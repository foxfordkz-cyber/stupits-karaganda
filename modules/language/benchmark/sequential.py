"""Three sequential input files, a shared cache, and exact first/replay equality."""
import argparse
from pathlib import Path
import sys

MODULE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE))
from benchmark.fixtures import build, records_for
from benchmark.run import engine_identity, measure, repeated_records
from bekzat_language.storage import private_path, write_json


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out', required=True, type=Path)
    args = p.parse_args()
    out = private_path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    cases, glossary = build()
    rows = repeated_records(records_for(cases), 150)
    write_json(out / 'glossary.json', glossary)
    results = []
    for n, selected in enumerate((rows[:100], rows[50:], rows[:100])):
        path = out / f'file-{n}.json'
        write_json(path, selected)
        _, result = measure(MODULE, path, out / 'glossary.json', out / f'run-{n}', out / 'cache')
        results.append(result)
    if [r['cache_hits'] for r in results] != [0, 50, 100]:
        raise ValueError('unexpected sequential cache reuse')
    for name in ('findings', 'finding_index', 'proposals'):
        if (out / 'run-0' / (name + '.json')).read_bytes() != (out / 'run-2' / (name + '.json')).read_bytes():
            raise ValueError('replay changed findings')
    write_json(out / 'sequential.json', {'engine': engine_identity(MODULE), 'runs': results,
        'replay_identical': True, 'scope': 'three invented files; corpus consistency is per analyze call'})
    print('sequential files passed; cache hits 0/100, 50/100, 100/100; identical replay')


if __name__ == '__main__':
    main()
