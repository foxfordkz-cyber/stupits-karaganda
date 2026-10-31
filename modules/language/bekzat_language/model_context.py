"""Optional exact-form glossary selection, with an auditable full-input fingerprint."""
from .contracts import canonical, digest
from .rules import hits


def select_glossary(record, glossary, term_context, scope='full'):
    if not isinstance(scope, str) or scope not in {'full', 'relevant'}:
        raise ValueError('invalid glossary_scope')
    entries = glossary['entries']
    selected = entries
    if scope == 'relevant':
        context = record.get('context', {})
        description = [record.get('description', '')]
        if isinstance(context, str):
            description.append(context)
        elif isinstance(context, dict) and isinstance(context.get('description'), str):
            description.append(context['description'])
        source_context = '\n'.join([record['source'], *description])
        witnesses = {item['concept'] for item in term_context}
        selected = []
        for entry in entries:
            if entry.get('categories') and record.get('category', '') not in entry['categories']:
                continue
            target_forms = set(entry['allowed_forms']) | set(entry.get('forbidden_forms', {})) | set(entry.get('variants', {}))
            if (entry['id'] in witnesses or any(hits(form, source_context) for form in entry['source_forms']) or
                    any(hits(form, record['target']) for form in target_forms)):
                selected.append(entry)
    scoped = {**glossary, 'entries': selected}
    audit = {'mode': scope, 'full_glossary_hash': digest(glossary),
             'total_entries': len(entries), 'selected_entries': len(selected),
             'omitted_entries': len(entries) - len(selected),
             'full_glossary_bytes': len(canonical(glossary).encode('utf-8')),
             'selected_glossary_bytes': len(canonical(scoped).encode('utf-8'))}
    return scoped, audit
