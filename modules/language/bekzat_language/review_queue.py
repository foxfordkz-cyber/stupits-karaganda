"""Occurrence-bound handoff sidecar. This is never a human decision journal."""
from .contracts import digest, identity, validate_finding
from .proposals import text_hash


def build_review_queue(records, result):
    findings, locators = result['findings'], result['finding_index']
    if len(findings) != len(locators):
        raise ValueError('review_queue_missing_provenance')
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
        for key in ('entry_id', 'bundle_index'):
            if key in record:
                row[key] = record[key]
        row['review_id'] = digest({'record': row['record_hash'], 'finding': row['finding_hash']})
        rows.append(row)
    return {'kind': 'bekzat-language-review-queue', 'version': 1,
            'report_hash': digest(findings), 'rows': rows,
            'human_decisions_created': 0, 'approval_semantics': 'none; pending findings only'}
