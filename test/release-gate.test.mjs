import test from 'node:test';
import assert from 'node:assert/strict';
import { hashText } from '../src/contracts.mjs';
import { checkRelease } from '../src/release-gate.mjs';
import { inspectArb, technicalSignature } from '../src/arb-audit.mjs';

// MOCK human attestations for unit tests only; none represents a real review.
function makeCase({ source = 'Open {name}', original = 'Old {name}', fixed = 'New {name}' } = {}) {
  const d = {
    key: 'message', entry_id: 'message#1', decision: 'edited',
    original_text: original, approved_text: fixed,
    source_hash: hashText(source), original_hash: hashText(original), approved_hash: hashText(fixed),
    reviewer: 'TEST_ONLY', reviewed_at: '2026-10-30T12:00:00Z', reviewed_by_human: true,
  };
  const stamp = Object.fromEntries(['reviewed_by_human', 'reviewer', 'reviewed_at', 'source_hash', 'original_hash', 'approved_hash'].map(k => [k, d[k]]));
  return {
    sourceText: JSON.stringify({ '@@locale': 'ru', message: source, brand: 'MockCoin' }),
    originalText: JSON.stringify({ '@@locale': 'kk', message: original, brand: 'MockCoin' }),
    fixedText: JSON.stringify({ '@@locale': 'kk', message: fixed, brand: 'MockCoin', '@message': { 'x-locqa': stamp } }),
    report: [{ key: 'message', issue_type: 'machine_translation_suspect', severity: 'medium', source, target: original, evidence: 'TEST_ONLY synthetic issue', suggestion: fixed, confidence: 0.8, reviewed_by_human: false }],
    reviews: { schema_version: '1.0', target_locale: 'kk', decisions: [d] },
  };
}
function changeArb(value, field, mutate) {
  const obj = JSON.parse(value[field]); mutate(obj); value[field] = JSON.stringify(obj);
}
function hasError(result, pattern) { assert.ok(result.errors.some(e => pattern.test(e)), JSON.stringify(result)); }

test('release accepts exact mock approval and matching stamp but never claims Flutter verified', () => {
  const result = checkRelease(makeCase());
  assert.equal(result.status, 'preflight_passed');
  assert.equal(result.changed_count, 1);
  assert.equal(result.reviewed_changed_count, 1);
  assert.equal(result.flutter_verified, false);
  assert.equal(result.scope, 'artifact_consistency_only');
});

test('approval becomes stale when source, original or exported text changes', () => {
  const changedSource = makeCase();
  changeArb(changedSource, 'sourceText', a => { a.message = 'Different source {name}'; });
  hasError(checkRelease(changedSource), /Stale source review/);
  const changedOriginal = makeCase();
  changeArb(changedOriginal, 'originalText', a => { a.message = 'Different original {name}'; });
  hasError(checkRelease(changedOriginal), /Stale original review/);
  const changedFixed = makeCase();
  changeArb(changedFixed, 'fixedText', a => { a.message = 'Later edit {name}'; });
  hasError(checkRelease(changedFixed), /lacks current human approval/);
});

test('changed strings without accepted reviews are blocked', () => {
  const missing = makeCase(); missing.reviews.decisions = [];
  hasError(checkRelease(missing), /lacks current human approval/);
  const rejected = makeCase();
  Object.assign(rejected.reviews.decisions[0], { decision: 'rejected', approved_text: null, approved_hash: null });
  hasError(checkRelease(rejected), /lacks current human approval/);
});

test('each ARB stamp field must match the exact review record', () => {
  for (const field of ['reviewed_by_human', 'reviewer', 'reviewed_at', 'source_hash', 'original_hash', 'approved_hash']) {
    const value = makeCase();
    changeArb(value, 'fixedText', a => { delete a['@message']['x-locqa'][field]; });
    hasError(checkRelease(value), /Missing\/mismatched ARB review stamp/);
  }
  const wrongPerson = makeCase();
  changeArb(wrongPerson, 'fixedText', a => { a['@message']['x-locqa'].reviewer = 'OTHER_TEST_ONLY'; });
  hasError(checkRelease(wrongPerson), /reviewer/);
});

test('approved values must actually be exported', () => {
  const value = makeCase();
  changeArb(value, 'fixedText', a => { a.message = 'Old {name}'; });
  hasError(checkRelease(value), /Approved change was not exported/);
});

test('original keys cannot be dropped and new keys must exist in source', () => {
  const dropped = makeCase();
  changeArb(dropped, 'fixedText', a => { delete a.brand; });
  hasError(checkRelease(dropped), /Dropped original key: brand/);
  const extra = makeCase();
  changeArb(extra, 'fixedText', a => { a.extra = 'Invented resource'; });
  hasError(checkRelease(extra), /New key absent from source/);
});

test('a missing translation can be added only with occurrence zero and explicit approval', () => {
  const value = makeCase();
  changeArb(value, 'originalText', a => { delete a.message; });
  Object.assign(value.reviews.decisions[0], { entry_id: 'message#0', original_text: null, original_hash: null });
  changeArb(value, 'fixedText', a => { a['@message']['x-locqa'].original_hash = null; });
  value.report[0].target = '';
  assert.equal(checkRelease(value).status, 'preflight_passed');
  value.reviews.decisions[0].entry_id = 'message#1';
  hasError(checkRelease(value), /entry_id/);
});

test('conflicting original duplicates block release rather than choosing a last value', () => {
  const value = makeCase();
  value.originalText = '{"@@locale":"kk","message":"Earlier {name}","message":"Old {name}","brand":"MockCoin"}';
  value.reviews.decisions[0].entry_id = 'message#2';
  hasError(checkRelease(value), /original-target: conflicting key message/);
});

test('identical original duplicates are counted and last occurrence binds review', () => {
  const value = makeCase();
  value.originalText = '{"@@locale":"kk","message":"Old {name}","message":"Old {name}","brand":"MockCoin"}';
  const audited = inspectArb(value.originalText);
  assert.equal(audited.duplicates[0].occurrences.length, 2);
  assert.equal(audited.duplicates[0].conflicting, false);
  value.reviews.decisions[0].entry_id = 'message#2';
  const result = checkRelease(value);
  assert.equal(result.status, 'preflight_passed');
  assert.ok(result.warnings.some(w => /identical duplicate/.test(w)));
  value.reviews.decisions[0].entry_id = 'message#1';
  hasError(checkRelease(value), /entry_id/);
});

test('fixed output cannot contain repeated resource keys even if values match', () => {
  const value = makeCase();
  value.fixedText = value.fixedText.replace('"brand":"MockCoin"', '"brand":"MockCoin","brand":"MockCoin"');
  hasError(checkRelease(value), /fixed: repeated key brand/);
});

test('repeated section comments are accepted but duplicated metadata attributes are blocked', () => {
  const value = makeCase();
  value.originalText = value.originalText.replace('"brand":"MockCoin"', '"@@comment":"first","brand":"MockCoin","@@comment":"second"');
  assert.equal(checkRelease(value).status, 'preflight_passed');
  value.fixedText = value.fixedText.replace('"reviewer":"TEST_ONLY"', '"reviewer":"TEST_ONLY","reviewer":"TEST_ONLY"');
  hasError(checkRelease(value), /duplicate metadata attribute/);
});

test('placeholder names and printf directives cannot mutate under an approved translation', () => {
  hasError(checkRelease(makeCase({ source: 'Open {name}', original: 'Old {name}', fixed: 'New {username}' })), /Technical mismatch placeholders/);
  hasError(checkRelease(makeCase({ source: 'Amount %s', original: 'Old %s', fixed: 'New %d' })), /Technical mismatch printf/);
});

test('ICU missing other and unbalanced braces are rejected', () => {
  const bad = '{count, plural, one {One}}';
  hasError(checkRelease(makeCase({ source: '{count, plural, one {One} other {Many}}', original: '{count, plural, one {Old} other {Old many}}', fixed: bad })), /ICU\/placeholder parse failed/);
  hasError(checkRelease(makeCase({ fixed: 'New {name' })), /ICU\/placeholder parse failed/);
});

test('removing ICU plural logic while retaining the argument name is blocked', () => {
  const value = makeCase({ source: '{count, plural, one {One} other {Many}}', original: '{count, plural, one {Old} other {Old many}}', fixed: '{count}' });
  assert.equal(checkRelease(value).status, 'failed', 'Plural-to-argument mutation must not pass preflight');
});

test('language-specific plural categories may legitimately differ', () => {
  const value = makeCase({
    source: '{count, plural, one {One} few {Few} many {Many} other {Other}}',
    original: '{count, plural, one {Old} other {Old other}}',
    fixed: '{count, plural, one {New} other {New other}}',
  });
  assert.equal(checkRelease(value).status, 'preflight_passed');
});

test('changing explicit plural cases and select cases is blocked', () => {
  const plural = makeCase({
    source: '{count, plural, =0 {None} other {Some}}',
    original: '{count, plural, =0 {Old none} other {Old some}}',
    fixed: '{count, plural, other {New some}}',
  });
  assert.equal(checkRelease(plural).status, 'failed', 'Explicit =0 branch must survive');
  const select = makeCase({
    source: '{role, select, admin {Admin} other {Member}}',
    original: '{role, select, admin {Old admin} other {Old member}}',
    fixed: '{role, select, other {New member}}',
  });
  assert.equal(checkRelease(select).status, 'failed', 'Named select branches must survive');
});

test('same tag tokens with broken nesting are rejected', () => {
  const value = makeCase({ source: '<g><b>Open</b></g>', original: '<g><b>Old</b></g>', fixed: '<g><b>New</g></b>' });
  assert.equal(checkRelease(value).status, 'failed', 'Tag multiset equality must not hide invalid nesting');
});

test('source/report mismatch and target/report mismatch are detected', () => {
  const badSource = makeCase(); badSource.report[0].source = 'Other source';
  hasError(checkRelease(badSource), /Report source does not match/);
  const badTarget = makeCase(); badTarget.report[0].target = 'Other target';
  hasError(checkRelease(badTarget), /Report target does not match/);
});

test('target locales must match and malformed locale syntax is rejected', () => {
  const mismatch = makeCase(); changeArb(mismatch, 'fixedText', a => { a['@@locale'] = 'uz'; });
  hasError(checkRelease(mismatch), /locale/);
  const malformed = makeCase();
  malformed.reviews.target_locale = 'not_a_locale!!!';
  for (const field of ['originalText', 'fixedText']) changeArb(malformed, field, a => { a['@@locale'] = 'not_a_locale!!!'; });
  assert.throws(() => checkRelease(malformed), /locale/i);
});

test('clean brands, numbers and private-use symbols need no false human approvals', () => {
  const source = { '@@locale': 'ru', brand: 'MockCoin', digits: '123', glyph: '\uE001' };
  const target = { ...source, '@@locale': 'kk' };
  const result = checkRelease({
    sourceText: JSON.stringify(source), originalText: JSON.stringify(target), fixedText: JSON.stringify(target),
    report: [], reviews: { schema_version: '1.0', target_locale: 'kk', decisions: [] },
  });
  assert.equal(result.status, 'preflight_passed');
  assert.equal(result.changed_count, 0);
  assert.equal(result.reviewed_changed_count, 0);
});

test('ARB parser rejects nonstring resources, JSON comments and trailing commas', () => {
  for (const text of ['{"key":12}', '{"key":"x",}', '{/* comment */"key":"x"}', '[]']) assert.throws(() => inspectArb(text));
  assert.deepEqual(technicalSignature('{name} %s <g>x</g>').placeholders, ['name']);
});


test('ICU argument kinds and plural offsets cannot change during translation', () => {
  const formatKind = makeCase({ source: '{amount, number}', original: '{amount, number}', fixed: '{amount, date}' });
  assert.equal(checkRelease(formatKind).status, 'failed', 'Number argument cannot become a date');
  const offset = makeCase({
    source: '{count, plural, offset:1 one {One} other {Many}}',
    original: '{count, plural, offset:1 one {Old} other {Old many}}',
    fixed: '{count, plural, one {New} other {New many}}',
  });
  assert.equal(checkRelease(offset).status, 'failed', 'Plural offsets change message semantics');
});

test('escaped printf percent does not masquerade as a live placeholder', () => {
  const value = makeCase({ source: 'Literal %%s', original: 'Old literal %%s', fixed: 'New placeholder %s' });
  assert.equal(checkRelease(value).status, 'failed', 'Escaped %% must be consumed before recognizing %s');
});
