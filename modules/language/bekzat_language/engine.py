"""Batch orchestration, bounded model work and audit data separate from findings."""
from collections import Counter
from datetime import datetime, timezone
import math
from pathlib import Path
import time
from .contracts import (canonical, digest, identity, record_errors, validate_finding,
                        validate_glossary)
from .provider import (PROMPT_VERSION, build_request, call_provider, cost, usage_of,
                       validate_config, validate_issues)
from .rules import RULES_VERSION, analyze_record, term_contexts
from .proposals import validate_proposal
from .storage import Cache, private_path


def analyze(records, glossary, *, cache_dir, provider=None, max_requests=0, max_tokens=0,
            max_cost_usd=0.0, log_path=None):
    """Return findings, finding_index, diagnostics and metrics. Never modify records.

    max_tokens limits reserved model input+output. All cached results remain usable
    with zero budget. The provider adapter must enforce exact token limits upstream.
    """
    start = time.perf_counter()
    started_at = datetime.now(timezone.utc).isoformat()
    validate_glossary(glossary)
    if not isinstance(records, list) or len(records) > 50_000:
        raise ValueError("records must be a list of at most 50000 entries")
    if type(max_requests) is not int or max_requests < 0 or type(max_tokens) is not int or max_tokens < 0:
        raise ValueError("budget counts must be nonnegative integers")
    if type(max_cost_usd) not in (int, float) or not 0 <= max_cost_usd <= 1e12 or not math.isfinite(max_cost_usd):
        raise ValueError("invalid cost budget")
    if provider is not None:
        validate_config(provider)
    diagnostics = []
    good = []
    input_indices = []
    prelim = []
    identities = Counter()
    total_bytes = 0
    for index, record in enumerate(records):
        errors = record_errors(record)
        prelim.append(errors)
        if not errors:
            total_bytes += len(canonical(record).encode("utf-8"))
            if total_bytes > 64 * 1024 * 1024:
                raise ValueError("batch exceeds 64 MiB; split input into smaller batches")
        if not errors:
            identities[(record["key"], record["locale"].replace("_", "-").lower(), record["occurrence"])] += 1
    for index, (record, errors) in enumerate(zip(records, prelim)):
        if not errors and identities[(record["key"], record["locale"].replace("_", "-").lower(), record["occurrence"])] > 1:
            errors = ["duplicate_record_identity"]
        if errors:
            diagnostics.append({"input_index": index, "codes": errors})
        else:
            good.append(record)
            input_indices.append(index)
    try:
        unhashable = any("non_json_record" in errors or "record_too_large" in errors for errors in prelim)
        records_hash = None if unhashable else digest(records)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        records_hash = None
    contexts, consistency = term_contexts(good, glossary)
    metrics = {"started_at_utc": started_at, "engine_version": "1.2.0", "rules_version": RULES_VERSION,
        "input_records": len(records), "valid_records": len(good),
        "quarantined_records": len(diagnostics), "records_hash": records_hash,
        "records_hash_scope": "complete_input" if records_hash else "unavailable_invalid_input",
        "glossary_hash": digest(glossary), "glossary_status": glossary["status"],
        "mode": "model_and_local" if provider else "local_only",
        "model_records_completed": 0, "model_records_skipped": 0, "provider_requests": 0,
        "local_cache_hits": 0, "local_cache_misses": 0, "model_cache_hits": 0,
        "input_tokens": 0, "output_tokens": 0, "reserved_tokens": 0,
        "cost_usd_known": 0.0, "cost_usd_reserved": 0.0, "cost_status": "known",
        "provider_failures": 0, "budget": {"max_requests": max_requests, "max_tokens": max_tokens,
        "max_cost_usd": max_cost_usd}, "human_review_count": 0,
        "confidence_semantics": "uncalibrated heuristic or model self-confidence; not measured accuracy",
        "quality_metrics": {"precision": None, "recall": None, "reason": "no human labels or hidden answer key"}}
    if provider:
        metrics["provider"] = {k: provider[k] for k in ("provider_id", "model_id", "revision",
            "input_usd_per_million", "output_usd_per_million")}
    findings, finding_index, events, proposals = [], [], [], []
    provider_stopped = False
    logfile = None
    if log_path is not None:
        path = private_path(log_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        logfile = path.open("x", encoding="utf-8", newline="\n")
    try:
        with Cache(cache_dir) as cache:
            for n, record in enumerate(good):
                record_started = time.perf_counter()
                event = {"input_index": input_indices[n], "identity_hash": digest(identity(record)),
                         "provider_requests": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
                local_key = digest({"kind": "local", "version": RULES_VERSION, "record": record, "glossary": glossary})
                local = cache.get(local_key)
                if local is not None:
                    try:
                        if not isinstance(local, dict) or set(local) != {'findings', 'proposals'}:
                            raise ValueError("invalid cached findings")
                        if not isinstance(local['findings'], list) or not isinstance(local['proposals'], list):
                            raise ValueError("invalid cached lists")
                        for f in local['findings']:
                            validate_finding(f, record)
                        for p in local['proposals']:
                            validate_proposal(p, record, local['findings'])
                    except (ValueError, TypeError):
                        local = None
                        cache.delete(local_key)
                if local is None:
                    local_proposals = []
                    local = {'findings': analyze_record(record, glossary, proposals=local_proposals),
                             'proposals': local_proposals}
                    cache.put(local_key, local)
                    metrics["local_cache_misses"] += 1
                    event["local_cache"] = "miss"
                else:
                    metrics["local_cache_hits"] += 1
                    event["local_cache"] = "hit"
                candidates = [(f, "local") for f in local['findings']] + [(f, "corpus") for f in consistency[n]]
                if provider:
                    request = build_request(record, glossary, contexts[n], provider)
                    model_key = digest({"kind": "model", "version": PROMPT_VERSION,
                        "config": provider, "request": request})
                    response = cache.get(model_key)
                    model_findings = None
                    if response is not None:
                        try:
                            usage_of(response)
                            model_findings = validate_issues(response, record, contexts[n])
                        except (ValueError, TypeError):
                            cache.delete(model_key)
                    if model_findings is not None:
                        metrics["model_cache_hits"] += 1
                        metrics["model_records_completed"] += 1
                        event["model_status"] = "cache_hit"
                    else:
                        reserved_usage = {"input_tokens": request["input_token_limit"],
                                          "output_tokens": request["max_output_tokens"]}
                        reserve_tokens = sum(reserved_usage.values())
                        reserve_cost = cost(reserved_usage, provider)
                        fits = (metrics["provider_requests"] < max_requests and
                            metrics["reserved_tokens"] + reserve_tokens <= max_tokens and
                            metrics["cost_usd_reserved"] + reserve_cost <= max_cost_usd + 1e-12)
                        if not cache.available or provider_stopped or not fits:
                            metrics["model_records_skipped"] += 1
                            event["model_status"] = ("cache_unavailable" if not cache.available else
                                "stopped_after_failure" if provider_stopped else "budget_exhausted")
                        else:
                            metrics["provider_requests"] += 1
                            event["provider_requests"] = 1
                            metrics["reserved_tokens"] += reserve_tokens
                            metrics["cost_usd_reserved"] += reserve_cost
                            usage_known = False
                            try:
                                response = call_provider(provider, request)
                                usage = usage_of(response)
                                actual_cost = cost(usage, provider)
                                usage_known = True
                                metrics["input_tokens"] += usage["input_tokens"]
                                metrics["output_tokens"] += usage["output_tokens"]
                                metrics["cost_usd_known"] += actual_cost
                                event.update(usage)
                                event["cost_usd"] = actual_cost
                                if any(usage[k] > reserved_usage[k] for k in usage):
                                    raise ValueError("provider_exceeded_reserved_budget")
                                model_findings = validate_issues(response, record, contexts[n])
                                cache.put(model_key, response)
                                metrics["model_records_completed"] += 1
                                event["model_status"] = "completed"
                            except Exception as exc:
                                provider_stopped = True
                                model_findings = None
                                metrics["provider_failures"] += 1
                                if not usage_known:
                                    metrics["cost_status"] = "unknown_after_provider_failure"
                                    event["cost_usd"] = None
                                diagnostics.append({"input_index": input_indices[n],
                                    "codes": ["provider_failure"], "error_class": type(exc).__name__})
                                event["model_status"] = "failed"
                    if model_findings is not None:
                        candidates.extend((f, "model") for f in model_findings)
                else:
                    event["model_status"] = "not_configured"
                seen = {}
                for f, origin in candidates:
                    validate_finding(f, record)
                    token = digest(f)
                    if token in seen:
                        continue
                    seen[token] = len(findings)
                    finding_index.append({"finding_index": len(findings), "input_index": input_indices[n],
                        **identity(record), "origin": origin, "record_hash": digest(record)})
                    findings.append(f)
                for p in local['proposals']:
                    validate_proposal(p, record, local['findings'])
                    exported = {k: v for k, v in p.items() if k != 'local_finding_index'}
                    exported['finding_index'] = seen[digest(local['findings'][p['local_finding_index']])]
                    exported['input_index'] = input_indices[n]
                    proposals.append(exported)
                event["elapsed_seconds"] = round(time.perf_counter() - record_started, 6)
                events.append(event)
                if logfile:
                    logfile.write(canonical(event) + "\n")
                    logfile.flush()
            metrics["persistent_cache_available"] = cache.available
            if cache.error_code:
                diagnostics.append({"input_index": None, "codes": [cache.error_code], "scope": "run"})
    finally:
        if logfile:
            logfile.close()
    metrics["elapsed_seconds"] = round(time.perf_counter() - start, 6)
    metrics["findings"] = len(findings)
    metrics["proposals"] = len(proposals)
    metrics["records_with_findings"] = len({f["input_index"] for f in finding_index})
    metrics["counts_by_severity"] = dict(sorted(Counter(f["severity"] for f in findings).items()))
    metrics["counts_by_issue"] = dict(sorted(Counter(f["issue_type"] for f in findings).items()))
    metrics["local_scan_complete"] = len(good) == len(events)
    metrics["model_scan_complete"] = bool(provider) and metrics["model_records_completed"] == len(good)
    metrics["status"] = "complete" if not diagnostics and (not provider or metrics["model_scan_complete"]) else "partial"
    metrics["cost_usd_total"] = metrics["cost_usd_known"] if metrics["cost_status"] == "known" else None
    metrics["cost_scope"] = "provider token charges at configured rates; excludes hardware, development and subscription costs"
    return {"findings": findings, "finding_index": finding_index, "diagnostics": diagnostics,
            "metrics": metrics, "events": events, "proposals": proposals}
