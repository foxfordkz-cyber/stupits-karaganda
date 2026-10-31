"""Strict integration contracts, implemented with the Python standard library."""
import hashlib
import json
import math
import re

ISSUES = frozenset({"glossary_violation", "inconsistent_term", "machine_translation_suspect",
                    "orthography", "wrong_language", "suffix_harmony"})
FINDING_FIELDS = frozenset({"key", "issue_type", "severity", "source", "target", "evidence",
                            "suggestion", "confidence", "reviewed_by_human"})
REQUIRED_RECORD = frozenset({"key", "locale", "source", "target", "occurrence", "source_hash"})


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def strict_json(text):
    def pairs(items):
        result = {}
        for k, v in items:
            if k in result:
                raise ValueError("duplicate JSON field")
            result[k] = v
        return result
    def constant(_):
        raise ValueError("non-finite JSON number")
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    except RecursionError:
        raise ValueError("JSON nesting limit exceeded") from None


def record_errors(record):
    if not isinstance(record, dict):
        return ["record_not_object"]
    errors = ["missing_" + k for k in sorted(REQUIRED_RECORD - record.keys())]
    for k in ("key", "locale", "source", "target", "source_hash"):
        if k in record and (not isinstance(record[k], str) or (k != "source" and not record[k])):
            errors.append("invalid_" + k)
    if "source" in record and record["source"] == "":
        errors.append("empty_source_for_core_module")
    if "occurrence" in record and (type(record["occurrence"]) is not int or record["occurrence"] < 1):
        errors.append("invalid_occurrence")
    if isinstance(record.get("source_hash"), str) and not re.fullmatch(r"[a-fA-F0-9]{64}", record["source_hash"]):
        errors.append("invalid_source_hash")
    for k in ("category", "description"):
        if k in record and not isinstance(record[k], str):
            errors.append("invalid_" + k)
    for k in ("metadata", "@metadata"):
        if k in record and not isinstance(record[k], dict):
            errors.append("invalid_" + k)
    if "context" in record and not isinstance(record["context"], (dict, str)):
        errors.append("invalid_context")
    if isinstance(record.get("locale"), str) and not re.fullmatch(r"kk(?:[-_][A-Za-z0-9]+)*", record["locale"], re.I):
        errors.append("unsupported_locale")
    try:
        encoded = canonical(record).encode("utf-8")
        if len(encoded) > 262_144:
            errors.append("record_too_large")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        errors.append("non_json_record")
    return errors


def identity(record):
    return {k: record[k] for k in ("key", "locale", "occurrence", "source_hash")}


def validate_finding(finding, record):
    if not isinstance(finding, dict) or set(finding) != FINDING_FIELDS:
        raise ValueError("finding_fields")
    for k in ("key", "source", "target"):
        if finding[k] != record[k]:
            raise ValueError("finding_identity")
    if (not isinstance(finding["issue_type"], str) or finding["issue_type"] not in ISSUES or
            not isinstance(finding["severity"], str) or finding["severity"] not in {"high", "medium", "low"}):
        raise ValueError("finding_enum")
    for k in ("evidence", "suggestion"):
        if not isinstance(finding[k], str) or not finding[k].strip():
            raise ValueError("finding_empty_text")
    c = finding["confidence"]
    if type(c) not in (int, float) or not 0 <= c <= 1 or not math.isfinite(c):
        raise ValueError("finding_confidence")
    if finding["reviewed_by_human"] is not False:
        raise ValueError("finding_human_review_forbidden")
    try:
        canonical(finding).encode("utf-8")
    except (UnicodeError, ValueError, RecursionError):
        raise ValueError("finding_invalid_unicode") from None
    return finding


def finding(record, issue, evidence, suggestion, confidence, severity="medium"):
    return validate_finding({"key": record["key"], "issue_type": issue, "severity": severity,
        "source": record["source"], "target": record["target"], "evidence": evidence,
        "suggestion": suggestion, "confidence": confidence, "reviewed_by_human": False}, record)


def validate_glossary(glossary):
    if not isinstance(glossary, dict) or not isinstance(glossary.get("status"), str) or glossary["status"] not in {"draft", "agreed"}:
        raise ValueError("glossary needs status=draft|agreed")
    try:
        if len(canonical(glossary).encode("utf-8")) > 1_000_000:
            raise ValueError("glossary too large")
    except (TypeError, UnicodeError, RecursionError):
        raise ValueError("glossary must be finite UTF-8 JSON") from None
    entries = glossary.get("entries")
    if not isinstance(entries, list):
        raise ValueError("glossary.entries must be an array")
    ids = set()
    for e in entries:
        if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not e["id"] or e["id"] in ids:
            raise ValueError("glossary entry needs a unique id")
        ids.add(e["id"])
        for k in ("source_forms", "allowed_forms"):
            if not isinstance(e.get(k), list) or not e[k] or any(not isinstance(s, str) or not s.strip() for s in e[k]):
                raise ValueError("glossary needs nonempty string lists: " + k)
        if not isinstance(e.get("preferred"), str) or e["preferred"] not in e["allowed_forms"]:
            raise ValueError("glossary.preferred must be an allowed form")
        for k in ("categories",):
            if k in e and (not isinstance(e[k], list) or any(not isinstance(s, str) or not s for s in e[k])):
                raise ValueError("invalid glossary categories")
        forbidden = e.get("forbidden_forms", {})
        variants = e.get("variants", {})
        for mapping in (forbidden, variants):
            if not isinstance(mapping, dict) or any(not isinstance(k, str) or not k or not isinstance(v, str) or not v for k, v in mapping.items()):
                raise ValueError("invalid glossary mapping")
        if any(v not in e["allowed_forms"] for v in forbidden.values()):
            raise ValueError("forbidden replacement must be an allowed form")
        if set(s.casefold() for s in forbidden) & set(s.casefold() for s in e["allowed_forms"]):
            raise ValueError("glossary form is both allowed and forbidden")
        if "consistent" in e and type(e["consistent"]) is not bool:
            raise ValueError("glossary.consistent must be boolean")
        if not isinstance(e.get("consistency_scope", "category"), str) or e.get("consistency_scope", "category") not in {"category", "global"}:
            raise ValueError("glossary.consistency_scope must be category|global")
    return glossary
