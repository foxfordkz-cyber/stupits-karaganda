"""Unapproved, version-bound spelling candidates; never a human review decision."""
import hashlib
import re
from .contracts import digest, identity


def text_hash(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def match_case(original, replacement):
    if original.isupper():
        return replacement.upper()
    if original[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement


def spelling_proposal(record, finding_index, start, end, replacement):
    # Complex/unbalanced ICU needs the core parser. Do not suggest whole-string
    # candidates there, even if a local spelling finding remains useful.
    without_slots = re.sub(r'\{[A-Za-z_][A-Za-z_0-9]*\}', '', record['target'])
    if '{' in without_slots or '}' in without_slots:
        return None
    original = record['target'][start:end]
    replacement = match_case(original, replacement)
    # Only plain words/spaces can be replaced here. No changes to ICU, tags, numbers,
    # printf tokens or line breaks. Full technical validation still belongs to core.
    if not original or not replacement or any(not (c.isalpha() or c == ' ') for c in original + replacement):
        return None
    candidate = record['target'][:start] + replacement + record['target'][end:]
    if candidate == record['target']:
        return None
    return {'local_finding_index': finding_index, **identity(record), 'record_hash': digest(record),
        'original_target_hash': text_hash(record['target']), 'candidate_text': candidate,
        'candidate_hash': text_hash(candidate),
        'replacement': {'start': start, 'end': end, 'original_span': original, 'text': replacement},
        'method': 'local_spelling_span', 'technical_validation': 'pending_core',
        'status': 'pending_human_review', 'reviewed_by_human': False}


def validate_proposal(proposal, record, findings):
    if not isinstance(proposal, dict) or proposal.get('reviewed_by_human') is not False:
        raise ValueError('invalid_proposal')
    index = proposal.get('local_finding_index')
    if type(index) is not int or not 0 <= index < len(findings) or findings[index]['issue_type'] != 'orthography':
        raise ValueError('invalid_proposal_finding')
    change = proposal.get('replacement')
    if not isinstance(change, dict) or set(change) != {'start', 'end', 'original_span', 'text'}:
        raise ValueError('invalid_proposal_span')
    start, end = change['start'], change['end']
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(record['target']):
        raise ValueError('invalid_proposal_offsets')
    if not isinstance(change['text'], str):
        raise ValueError('invalid_proposal_text')
    expected = spelling_proposal(record, index, start, end, change['text'])
    if expected is None or proposal != expected:
        raise ValueError('stale_or_modified_proposal')
    return proposal
