"""Run frozen synthetic expectations against isolated current and baseline engines."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

MODULE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE))
from benchmark.fixtures import build, records_for, PROVENANCE
from benchmark.scoring import score
from bekzat_language.contracts import canonical, digest, validate_finding
from bekzat_language.storage import private_path, write_json


def engine_identity(directory):
    files = sorted((directory / 'bekzat_language').glob('*.py'))
    if not files:
        raise ValueError('engine must contain bekzat_language Python sources')
    sources = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    revision = subprocess.run(['git', '-C', str(directory), 'rev-parse', 'HEAD'],
                              capture_output=True, text=True, check=False)
    dirty = subprocess.run(['git', '-C', str(directory), 'status', '--porcelain', '--', '.'],
                           capture_output=True, text=True, check=False)
    return {'git_sha': revision.stdout.strip() if revision.returncode == 0 else None,
            'working_tree_changes': bool(dirty.stdout.strip()), 'engine_source_hash': digest(sources),
            'python_sources': sources}


def measure(engine, records_path, glossary_path, out, cache):
    command = [sys.executable, str(MODULE / 'benchmark/worker.py'), '--engine', str(engine),
               '--records', str(records_path), '--glossary', str(glossary_path),
               '--out', str(out), '--cache', str(cache)]
    process = subprocess.run(command, capture_output=True, text=True, timeout=600, check=False)
    if process.returncode != 0:
        raise ValueError('measurement failed; no success is inferred from partial output')
    read = lambda name: json.loads((out / (name + '.json')).read_text(encoding='utf-8'))
    metrics = read('metrics')
    findings, index = read('findings'), read('finding_index')
    records = json.loads(records_path.read_text(encoding='utf-8'))
    if len(findings) != len(index):
        raise ValueError('missing finding provenance')
    predictions = []
    for n, (finding, locator) in enumerate(zip(findings, index)):
        i = locator['input_index']
        if type(i) is not int or not 0 <= i < len(records) or locator['finding_index'] != n:
            raise ValueError('invalid finding index')
        validate_finding(finding, records[i])
        if any(locator[k] != records[i][k] for k in ('key', 'locale', 'occurrence', 'source_hash')):
            raise ValueError('stale finding occurrence/hash')
        predictions.append({'input_index': i, 'issue_type': finding['issue_type']})
    summary = {**read('measurement'), 'valid_records': metrics['valid_records'],
        'findings': len(findings), 'diagnostics': len(read('diagnostics')),
        'cache_hits': metrics['local_cache_hits'], 'cache_misses': metrics['local_cache_misses'],
        'cache_hit_rate': metrics['local_cache_hits'] / len(records) if records else None,
        'provider_requests': metrics['provider_requests'], 'cost_usd': metrics['cost_usd_total'],
        'llm_cost_per_1000': None, 'cost_note': 'offline; no LLM cost measurement',
        'counts_by_issue': metrics['counts_by_issue']}
    return predictions, summary


def repeated_records(records, size):
    out = []
    for i in range(size):
        record = copy.deepcopy(records[i % len(records)])
        record['key'] += '_perf_' + str(i)
        # Preserve within-copy category relationships without creating new conflicts.
        record['category'] += '_copy_' + str(i // len(records))
        out.append(record)
    return out


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--engine', type=Path, default=MODULE)
    p.add_argument('--baseline', type=Path)
    p.add_argument('--historical', type=Path)
    p.add_argument('--dataset', choices=('development', 'holdout'), default='development')
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--sizes', default='100,1000,5600', help='synthetic scalability sizes, empty disables')
    args = p.parse_args(argv)
    sizes = [int(value) for value in args.sizes.split(',') if value]
    if len(set(sizes)) != len(sizes) or any(n < 1 or n > 50_000 for n in sizes):
        raise ValueError('invalid performance sizes')
    out = private_path(args.out)
    if out.exists():
        raise ValueError('output must be new')
    if args.dataset == 'holdout':
        from benchmark.holdout import build as dataset_builder, PROVENANCE as provenance
    else:
        dataset_builder, provenance = build, PROVENANCE
    cases, glossary = dataset_builder()
    records = records_for(cases)
    score(cases, [])  # Validate frozen labels before importing either evaluated engine.
    identities = {(r['key'], r['locale'], r['occurrence']) for r in records}
    if len(identities) != len(records):
        raise ValueError('benchmark occurrence collision')
    engines = {'current': args.engine.resolve()}
    if args.baseline:
        engines['baseline'] = args.baseline.resolve()
    if args.historical:
        engines['historical'] = args.historical.resolve()
    identities = {label: engine_identity(path) for label, path in engines.items()}
    out.mkdir(parents=True)
    write_json(out / 'records.json', records)
    write_json(out / 'glossary.json', glossary)
    result = {'benchmark_hash': digest({'cases': cases, 'glossary': glossary}),
              'provenance': provenance, 'dataset': args.dataset, 'cases': len(cases), 'engines': identities, 'quality': {}, 'performance': {}}
    for label, engine in engines.items():
        predictions, measurement = measure(engine, out / 'records.json', out / 'glossary.json',
                                            out / label / 'quality', out / label / 'quality-cache')
        result['quality'][label] = {'metrics': score(cases, predictions), 'measurement': measurement}
    if args.baseline:
        a, b = result['quality']['baseline']['metrics']['micro'], result['quality']['current']['metrics']['micro']
        result['delta'] = {k: b[k] - a[k] if a[k] is not None and b[k] is not None else None for k in a}
    for size in sizes:
        records_path = out / f'performance-{size}.json'
        write_json(records_path, repeated_records(records, size))
        runs = {}
        for phase in ('cold', 'warm'):
            _, runs[phase] = measure(args.engine.resolve(), records_path, out / 'glossary.json',
                out / f'performance-{size}' / phase, out / f'performance-{size}' / 'cache')
        for name in ('findings', 'finding_index', 'proposals'):
            if (out / f'performance-{size}' / 'cold' / (name + '.json')).read_bytes() != (
                    out / f'performance-{size}' / 'warm' / (name + '.json')).read_bytes():
                raise ValueError('cache replay changed output')
        if runs['warm']['cache_hits'] != size or runs['warm']['cache_misses'] != 0:
            raise ValueError('warm cache did not cover the complete batch')
        result['performance'][str(size)] = runs
    result['performance_scope'] = 'deterministic repetitions with unique keys; scalability, not new independent quality examples'
    write_json(out / 'evaluation.json', result)
    print(canonical({'cases': len(cases), 'quality': {k: v['metrics']['micro'] for k, v in result['quality'].items()},
                     'performance_sizes': sizes}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        print('Benchmark failed; no completed evaluation claimed. Check paths and private outputs.', file=sys.stderr)
        raise SystemExit(1)
