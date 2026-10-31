"""One isolated engine import per measurement, including historical worktrees."""
import argparse
import json
from pathlib import Path
import platform
import sys
import time
import tracemalloc


def main():
    p = argparse.ArgumentParser()
    for name in ('engine', 'records', 'glossary', 'out', 'cache'):
        p.add_argument('--' + name, required=True, type=Path)
    args = p.parse_args()
    sys.path.insert(0, str(args.engine.resolve()))
    from bekzat_language import analyze
    from bekzat_language.storage import private_path, write_json
    out = private_path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    records = json.loads(args.records.read_text(encoding='utf-8'))
    glossary = json.loads(args.glossary.read_text(encoding='utf-8'))
    tracemalloc.start()
    started = time.perf_counter()
    result = analyze(records, glossary, cache_dir=args.cache, log_path=out / 'events.jsonl')
    elapsed = time.perf_counter() - started
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    for key in ('findings', 'finding_index', 'metrics', 'diagnostics', 'proposals'):
        write_json(out / (key + '.json'), result.get(key, []))
    measurement = {
        'wall_seconds': elapsed, 'peak_python_allocated_bytes': peak,
        'memory_scope': 'tracemalloc during analyze; excludes native SQLite/OS RSS and input loading',
        'timing_scope': 'tracemalloc enabled; includes persistent cache IO and event logging',
        'python': platform.python_version(), 'platform': platform.platform(),
    }
    write_json(out / 'measurement.json', measurement)
    return 0 if result['metrics']['status'] == 'complete' else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError):
        print('Benchmark worker failed; inspect configuration and output directory', file=sys.stderr)
        raise SystemExit(1)
