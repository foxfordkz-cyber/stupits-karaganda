"""Reconstruct the existing queue from exact team snapshots, using its own codec.

Used by the Node handoff boundary; no duplicate hash/float/Unicode codec in JS.
Nothing is approved or rewritten. Private exception text never goes to stdout.
"""
import argparse
from pathlib import Path
from bekzat_language.cli import read_bounded
from bekzat_language.contracts import strict_json
from bekzat_language.review_queue import build_review_queue
from team_cli import prepare_bundle


def main():
    p = argparse.ArgumentParser()
    for name in ('bundle', 'report', 'index', 'proposals', 'queue'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--limit', type=int)
    a = p.parse_args()
    try:
        data = {name: strict_json(read_bounded(getattr(a, name))) for name in ('bundle', 'report', 'index', 'proposals', 'queue')}
        records, _ = prepare_bundle(data['bundle'])
        if a.limit is not None and a.limit < 1:
            raise ValueError('invalid selection')
        selected = records[:a.limit] if a.limit else records
        expected = build_review_queue(selected, {'findings': data['report'], 'finding_index': data['index'],
                                                  'proposals': data['proposals']})
        if expected != data['queue']:
            raise ValueError('stale or modified queue')
        print('queue_verified')
        return 0
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        print('queue_snapshot_validation_failed')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
