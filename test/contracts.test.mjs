import test from 'node:test';
import assert from 'node:assert/strict';
import { assertContract, hashText } from '../src/contracts.mjs';

const finding = () => ({
  key: 'testButton', issue_type: 'orthography', severity: 'medium',
  source: 'Synthetic source', target: 'Synthetic target', evidence: 'Synthetic evidence',
  suggestion: 'Synthetic correction', confidence: 0.7, reviewed_by_human: false,
});
const bundle = () => ({
  schema_version: '1.0', source_locale: 'ru', target_locale: 'kk',
  entries: [{
    entry_id: 'testButton#1', key: 'testButton', occurrence: 1,
    source: 'Synthetic source', target: 'Synthetic target',
    source_hash: hashText('Synthetic source'), target_hash: hashText('Synthetic target'), context: {},
  }],
});
// These are mock attestations for automated unit tests, not actual human review.
const reviews = () => ({
  schema_version: '1.0', target_locale: 'kk',
  decisions: [{
    key: 'testButton', entry_id: 'testButton#1', decision: 'accepted',
    original_text: 'Synthetic target', approved_text: 'Synthetic correction',
    source_hash: hashText('Synthetic source'), original_hash: hashText('Synthetic target'),
    approved_hash: hashText('Synthetic correction'), reviewer: 'TEST_ONLY',
    reviewed_at: '2026-10-30T12:00:00Z', reviewed_by_human: true,
  }],
});

test('contracts accept valid finding, report, bundle and mock review', () => {
  for (const [name, value] of [['finding', finding()], ['report', [finding()]], ['bundle', bundle()], ['reviews', reviews()]]) {
    assert.equal(assertContract(name, value), value);
  }
  assert.throws(() => assertContract('unknown', []), /Unknown contract/);
});

test('report rejects wrong taxonomy, ranges, types, missing fields and unexpected fields', () => {
  for (const patch of [
    { issue_type: 'duplicate_key' }, { severity: 'critical' }, { confidence: -0.1 },
    { confidence: 1.1 }, { confidence: '0.5' }, { reviewed_by_human: 'true' }, { extra: true },
  ]) assert.throws(() => assertContract('report', [{ ...finding(), ...patch }]));
  const incomplete = finding();
  delete incomplete.evidence;
  assert.throws(() => assertContract('report', [incomplete]));
});

test('empty or whitespace-only identity and evidence are not valid findings', () => {
  for (const patch of [{ key: '' }, { key: ' \t' }, { evidence: '' }, { evidence: '\n ' }]) {
    assert.throws(() => assertContract('report', [{ ...finding(), ...patch }]));
  }
});

test('hashing binds exact UTF-8 text and distinguishes missing from empty', () => {
  assert.equal(hashText(null), null);
  assert.match(hashText(''), /^[a-f0-9]{64}$/);
  assert.notEqual(hashText('\u00e9'), hashText('e\u0301'));
  assert.throws(() => hashText(4), /expects/);
});

test('bundle rejects stale hashes, duplicate IDs and wrong occurrence sentinel', () => {
  const stale = bundle(); stale.entries[0].target += ' edited';
  assert.throws(() => assertContract('bundle', stale), /hash/i);
  const duplicate = bundle(); duplicate.entries.push(structuredClone(duplicate.entries[0]));
  assert.throws(() => assertContract('bundle', duplicate), /Duplicate entry_id/);
  const missing = bundle(); missing.entries[0].target = null; missing.entries[0].target_hash = null;
  assert.throws(() => assertContract('bundle', missing), /occurrence/);
  missing.entries[0].occurrence = 0; missing.entries[0].entry_id = 'testButton#0';
  assert.doesNotThrow(() => assertContract('bundle', missing));
});

test('bundle identity must be derived from key and occurrence', () => {
  const value = bundle(); value.entries[0].entry_id = 'some-other-key#1';
  assert.throws(() => assertContract('bundle', value), /entry_id|identity/i);
});

test('review validation binds original and approved text and requires a named attestation', () => {
  const original = reviews(); original.decisions[0].original_text += ' changed';
  assert.throws(() => assertContract('reviews', original), /hash/i);
  const approved = reviews(); approved.decisions[0].approved_text += ' changed';
  assert.throws(() => assertContract('reviews', approved), /hash/i);
  for (const patch of [{ reviewer: ' ' }, { reviewed_by_human: false }, { reviewed_at: 'not-a-date' }]) {
    const value = reviews(); Object.assign(value.decisions[0], patch);
    assert.throws(() => assertContract('reviews', value));
  }
});

test('review accepts rejection only without approved text and rejects repeated decisions', () => {
  const rejected = reviews(); rejected.decisions[0].decision = 'rejected';
  assert.throws(() => assertContract('reviews', rejected), /Rejected/);
  rejected.decisions[0].approved_text = null; rejected.decisions[0].approved_hash = null;
  assert.doesNotThrow(() => assertContract('reviews', rejected));
  rejected.decisions[0].decision = 'accepted';
  assert.throws(() => assertContract('reviews', rejected), /Approval/);
  const duplicate = reviews(); duplicate.decisions.push(structuredClone(duplicate.decisions[0]));
  assert.throws(() => assertContract('reviews', duplicate), /Multiple decisions/);
});

test('locale syntax rejects malformed identifiers while keeping arbitrary valid locales', () => {
  const malformedBundle = bundle(); malformedBundle.target_locale = 'not_a_locale!!!';
  assert.throws(() => assertContract('bundle', malformedBundle), /locale/i);
  const malformedReviews = reviews(); malformedReviews.target_locale = 'not_a_locale!!!';
  assert.throws(() => assertContract('reviews', malformedReviews), /locale/i);
  const regional = bundle(); regional.target_locale = 'kk_KZ';
  assert.doesNotThrow(() => assertContract('bundle', regional));
  const otherLanguage = bundle(); otherLanguage.target_locale = 'de';
  assert.doesNotThrow(() => assertContract('bundle', otherLanguage));
});
