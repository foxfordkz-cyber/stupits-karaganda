import argparse
from pathlib import Path
import sys
from .contracts import strict_json
from .engine import analyze
from .storage import private_path, write_json

MAX_INPUT_BYTES = 64 * 1024 * 1024


def read_bounded(path, limit=MAX_INPUT_BYTES):
    with Path(path).open("rb") as f:
        content = f.read(limit + 1)
    if len(content) > limit:
        raise ValueError("input file exceeds size limit")
    return content.decode("utf-8-sig")


def load_records(path):
    text = read_bounded(path)
    if text.lstrip().startswith("["):
        value = strict_json(text)
        if not isinstance(value, list):
            raise ValueError("input must be JSON array or JSONL")
        return value
    return [strict_json(line) for line in text.splitlines() if line.strip()]


def main(argv=None):
    parser = argparse.ArgumentParser(description="Bekzat: prepared-record Kazakh language diagnostics")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--glossary", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path, help="new private directory outside Git")
    parser.add_argument("--cache", required=True, type=Path, help="shared private cache directory outside Git")
    parser.add_argument("--limit", type=int, help="pilot size, normally 100; omit for full input")
    parser.add_argument("--provider-config", type=Path)
    parser.add_argument("--max-requests", type=int, default=0)
    parser.add_argument("--max-tokens", type=int, default=0)
    parser.add_argument("--max-cost-usd", type=float, default=0.0)
    args = parser.parse_args(argv)
    try:
        if args.limit is not None and args.limit < 1:
            raise ValueError("limit must be positive")
        records = load_records(args.input)
        glossary = strict_json(read_bounded(args.glossary, 1_000_000))
        provider = strict_json(read_bounded(args.provider_config, 1_000_000)) if args.provider_config else None
        out = private_path(args.out)
        private_path(args.cache)
        if out.exists() and any(out.iterdir()):
            raise ValueError("output directory must be new or empty")
        # Read-only input is never overwritten, including an input named report.json.
        for source in (args.input, args.glossary, args.provider_config):
            if source and source.resolve().is_relative_to(out):
                raise ValueError("input/config must not be inside output directory")
        out.mkdir(parents=True, exist_ok=True)
        selected = records[:args.limit] if args.limit else records
        result = analyze(selected, glossary, cache_dir=args.cache, provider=provider,
                         max_requests=args.max_requests, max_tokens=args.max_tokens,
                         max_cost_usd=args.max_cost_usd, log_path=out / "events.jsonl")
        result["metrics"]["available_input_records"] = len(records)
        result["metrics"]["selected_records"] = len(selected)
        result["metrics"]["selection"] = "first_n" if args.limit else "all"
        for key, filename in (("findings", "report.json"), ("finding_index", "finding_index.json"),
                              ("diagnostics", "diagnostics.json"), ("metrics", "metrics.json")):
            write_json(out / filename, result[key])
        m = result["metrics"]
        print(f'status={m["status"]}; records={m["valid_records"]}; findings={m["findings"]}; '
              f'seconds={m["elapsed_seconds"]}; provider_requests={m["provider_requests"]}; '
              f'cost_usd={m["cost_usd_total"]}')
        return 0 if m["status"] == "complete" else 2
    except (OSError, ValueError, TypeError, RecursionError) as exc:
        # Diagnostics deliberately omit raw exception text which could include private data.
        print(f'configuration/input/output error ({type(exc).__name__}); check README and paths', file=sys.stderr)
        return 1
