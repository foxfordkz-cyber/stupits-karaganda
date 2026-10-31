"""Local-only bridge from the team's validated bundle/CSV to the Python module.

Use check.mjs: it applies the repository's shared JSON Schema and hash validator.
No source file is modified and no actual handout data belongs in this repository.
"""
import argparse
import csv
import hashlib
import io
from pathlib import Path
import sys
from urllib.parse import quote

from bekzat_language import analyze
from bekzat_language.cli import read_bounded
from bekzat_language.contracts import strict_json, validate_glossary
from bekzat_language.storage import private_path, write_json


def load_glossary(path):
    text = read_bounded(path, 1_000_000)
    if text.lstrip().startswith('{'):
        return validate_glossary(strict_json(text))
    reader = csv.DictReader(io.StringIO(text), strict=True)
    if reader.fieldnames != ['ru', 'kk', 'en', 'comment']:
        raise ValueError('CSV header must be ru,kk,en,comment')
    entries = []
    for n, row in enumerate(reader, 1):
        if None in row or any(value is None for value in row.values()):
            raise ValueError('CSV row must contain exactly four columns')
        if not row['ru'].strip() or not row['kk'].strip():
            raise ValueError('CSV ru and kk must not be blank')
        entries.append({'id': f'csv:{n}', 'source_forms': [row['ru']],
            'allowed_forms': [row['kk']], 'preferred': row['kk'],
            'forbidden_forms': {}, 'consistent': False,
            'en': row['en'], 'comment': row['comment']})
    # CSV has no approval/inflection/forbidden-form fields; do not invent them from comments.
    return validate_glossary({'status': 'draft', 'entries': entries})


def prepare_bundle(bundle):
    if not isinstance(bundle, dict) or bundle.get('schema_version') != '1.0':
        raise ValueError('bundle schema_version must be 1.0')
    if bundle.get('source_locale', '').lower().replace('_', '-').split('-')[0] != 'ru':
        raise ValueError('source locale must be ru')
    locale = bundle.get('target_locale', '')
    if locale.lower().replace('_', '-').split('-')[0] != 'kk':
        raise ValueError('target locale must be kk')
    entries = bundle.get('entries')
    if not isinstance(entries, list) or len(entries) > 50_000:
        raise ValueError('invalid bundle entries')
    records, skipped, seen = [], [], set()
    for index, e in enumerate(entries):
        entry_id = quote(e['key'], safe="~()*!.'-") + '#' + str(e['occurrence'])
        if e['entry_id'] != entry_id or entry_id in seen:
            raise ValueError('invalid or duplicate entry_id')
        seen.add(entry_id)
        for text_field, hash_field in (('source', 'source_hash'), ('target', 'target_hash')):
            actual = None if e[text_field] is None else hashlib.sha256(e[text_field].encode('utf-8')).hexdigest()
            if actual != e[hash_field]:
                raise ValueError('stale bundle hash')
        if (e['target'] is None) != (e['occurrence'] == 0):
            raise ValueError('missing target must use occurrence 0')
        if e['target'] in (None, '') or e['source'] == '':
            skipped.append({'bundle_index': index, 'entry_id': entry_id, 'code': 'technical_or_empty_entry'})
            continue
        context = e['context']
        records.append({'key': e['key'], 'locale': locale, 'source': e['source'], 'target': e['target'],
            'source_hash': e['source_hash'], 'target_hash': e['target_hash'],
            'occurrence': e['occurrence'], 'entry_id': entry_id, 'bundle_index': index,
            'category': context.get('section') or '', 'description': context.get('description') or '',
            'context': context})
    return records, skipped


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--bundle', required=True, type=Path)
    p.add_argument('--glossary', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--cache', type=Path)
    args = p.parse_args(argv)
    try:
        out = private_path(args.out)
        details = private_path(out.with_name(out.name + '.details'))
        cache = private_path(args.cache or (out.parent / '.bekzat-cache'))
        if out.exists() or details.exists():
            raise ValueError('out and details must be new')
        for source in (args.bundle.resolve(), args.glossary.resolve()):
            if source == out or source.is_relative_to(details) or source.is_relative_to(cache):
                raise ValueError('input overlaps runtime output')
        bundle = strict_json(read_bounded(args.bundle))
        records, skipped = prepare_bundle(bundle)
        glossary = load_glossary(args.glossary)
        details.mkdir(parents=True, exist_ok=False)
        result = analyze(records, glossary, cache_dir=cache, log_path=details / 'events.jsonl')
        for loc in result['finding_index']:
            record = records[loc['input_index']]
            for key in ('entry_id', 'bundle_index', 'target_hash'):
                loc[key] = record[key]
        result['metrics']['bundle_entries'] = len(bundle['entries'])
        result['metrics']['entries_delegated_to_core'] = len(skipped)
        result['metrics']['adapter_mode'] = 'team_bundle_local_only'
        for name in ('finding_index', 'diagnostics', 'metrics'):
            write_json(details / (name + '.json'), result[name])
        write_json(details / 'skipped_entries.json', skipped)
        # Write the official output last; the runner must still check process exit status.
        write_json(out, result['findings'])
        return 0 if result['metrics']['status'] == 'complete' else 2
    except (OSError, ValueError, TypeError, KeyError, AttributeError, csv.Error):
        print('Team language adapter failed; check validated bundle, glossary and private output paths', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
