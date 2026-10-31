"""Occurrence-bound handoff sidecar. This is never a human decision journal."""
from copy import deepcopy
from .contracts import digest, identity, validate_finding
from .proposals import text_hash, validate_proposal


def build_review_queue(records, result):
    findings, locators = result['findings'], result['finding_index']
    if len(findings) != len(locators):
        raise ValueError('review_queue_missing_provenance')
    candidates = {}
    for proposal in result.get('proposals', []):
        index, n = proposal.get('finding_index'), proposal.get('input_index')
        if type(index) is not int or not 0 <= index < len(findings) or type(n) is not int or not 0 <= n < len(records):
            raise ValueError('review_queue_invalid_proposal_index')
        if locators[index]['input_index'] != n:
            raise ValueError('review_queue_proposal_occurrence')
        local = {k: v for k, v in proposal.items() if k not in
                 {'finding_index', 'input_index', 'entry_id', 'bundle_index', 'target_hash'}}
        local['local_finding_index'] = 0
        validate_proposal(local, records[n], [findings[index]])
        stable_record = {k: v for k, v in records[n].items() if k != 'bundle_index'}
        candidate_id = digest({'record': stable_record, 'candidate_hash': proposal['candidate_hash']})
        candidate = {'candidate_id': candidate_id, 'text': proposal['candidate_text'],
                     'text_hash': proposal['candidate_hash'], 'method': proposal['method'],
                     'technical_validation': 'pending_core', 'reviewed_by_human': False}
        if candidate not in candidates.setdefault(index, []):
            candidates[index].append(candidate)
    rows = []
    for index, (finding, locator) in enumerate(zip(findings, locators)):
        n = locator.get('input_index')
        if type(n) is not int or not 0 <= n < len(records) or locator.get('finding_index') != index:
            raise ValueError('review_queue_invalid_index')
        record = records[n]
        validate_finding(finding, record)
        if any(locator.get(k) != v for k, v in identity(record).items()) or locator.get('record_hash') != digest(record):
            raise ValueError('review_queue_stale_record')
        if record['source_hash'] != text_hash(record['source']):
            raise ValueError('review_queue_source_hash_mismatch')
        row = {**finding, **identity(record), 'target_hash': text_hash(record['target']),
               'record_hash': digest(record), 'finding_hash': digest(finding),
               'finding_index': index, 'input_index': n, 'status': 'pending_human_review'}
        row['context'] = deepcopy(record.get('context', {}))
        row['original_text'] = record['target']
        row['candidates'] = sorted(candidates.get(index, []), key=lambda p: p['candidate_id'])
        row['proposed_text'] = row['candidates'][0]['text'] if len(row['candidates']) == 1 else None
        row['proposal_status'] = ('single_candidate' if len(row['candidates']) == 1 else
                                  'conflicting_candidates' if row['candidates'] else 'needs_human_translation')
        for key in ('entry_id', 'bundle_index'):
            if key in record:
                row[key] = record[key]
        # Positional indices are provenance, not version identity: reordering a
        # bundle must not invalidate an unchanged occurrence or lose its history.
        stable_record = {k: v for k, v in record.items() if k != 'bundle_index'}
        row['review_id'] = digest({'record': stable_record, 'finding': finding,
                                   'candidates': row['candidates']})
        rows.append(row)
    grouped = {}
    for row in rows:
        group = (row['key'], row['locale'], row['occurrence'])
        for candidate in row['candidates']:
            grouped.setdefault(group, {})[candidate['text_hash']] = candidate['candidate_id']
    for row in rows:
        alternatives = grouped.get((row['key'], row['locale'], row['occurrence']), {})
        row['conflicting_candidate_ids'] = sorted(alternatives.values()) if len(alternatives) > 1 else []
    priority = {'high': 0, 'medium': 1, 'low': 2}
    rows.sort(key=lambda r: (priority[r['severity']], r['key'], r['locale'], r['occurrence'], r['review_id']))
    return {'kind': 'bekzat-language-review-queue', 'version': 2,
            'report_hash': digest(findings), 'rows': rows,
            'review_status': 'HUMAN_REVIEW_PENDING',
            'human_decisions_created': 0, 'approval_semantics': 'none; pending findings only'}
