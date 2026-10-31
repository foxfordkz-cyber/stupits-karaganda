import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertContract, hashText } from '../../../src/contracts.mjs';
import { inspectArb } from '../../../src/arb-audit.mjs';
import {
  createModel, sha256, makeDraft, createWorkspace, restoreWorkspace, validateReviews,
} from '../model.mjs';

const fixtureBase = new URL('../../../fixtures/synthetic/', import.meta.url);
const fixtureReport = JSON.parse(await readFile(new URL('report.sample.json', fixtureBase), 'utf8'));
const fixtureSource = inspectArb(await readFile(new URL('source.arb', fixtureBase), 'utf8'));
const fixtureTarget = inspectArb(await readFile(new URL('target.arb', fixtureBase), 'utf8'));

function fixtureBundle() {
  const entries = [];
  for (const [key, source] of fixtureSource.strings) {
    const targets = fixtureTarget.entries.filter(entry => entry.key === key);
    for (const entry of targets.length ? targets : [{ text: null, occurrence: 0 }]) {
      entries.push({
        entry_id: `${encodeURIComponent(key)}#${entry.occurrence}`, key, occurrence: entry.occurrence,
        source, target: entry.text, source_hash: hashText(source), target_hash: hashText(entry.text),
        context: { section: 'Synthetic test fixtures' },
      });
    }
  }
  return assertContract('bundle', {
    schema_version: '1.0', source_locale: 'ru', target_locale: 'kk', entries,
  });
}

function model() {
  return createModel(fixtureBundle(), structuredClone(fixtureReport));
}

// Mock attestations exercise import validation only. They are not human reviews.
function mockReviews(card, decision = 'accepted') {
  const entry = card.entry;
  const approved = decision === 'rejected' ? null : card.finding.suggestion;
  return assertContract('reviews', {
    schema_version: '1.0', target_locale: 'kk', decisions: [{
      key: entry.key, entry_id: entry.entry_id, decision,
      original_text: entry.target, approved_text: approved,
      source_hash: entry.source_hash, original_hash: entry.target_hash,
      approved_hash: hashText(approved), reviewer: 'SYNTHETIC_TEST_ONLY',
      reviewed_at: '2026-10-31T10:00:00Z', reviewed_by_human: true,
    }],
  });
}

test('report workspace binds the agreed fixture with all eleven issue types', () => {
  const result = model();
  assert.equal(result.cards.length, 11);
  assert.equal(new Set(result.cards.map(card => card.finding.issue_type)).size, 11);
  assert.ok(result.cards.every(card => card.entry && !card.blockedReason));
  assert.equal(new Set(result.cards.map(card => card.id)).size, 11);
  assert.deepEqual(result.report, fixtureReport);
  assert.deepEqual(result.cards.map(card => card.id), model().cards.map(card => card.id));
});

test('browser hashing preserves UTF-8, whitespace, normalization and missing-vs-empty distinction', async () => {
  for (const text of [null, '', 'Қазақша', ' trailing ', '\r\n', '\n', '\u00e9', 'e\u0301']) {
    assert.equal(await sha256(text), hashText(text));
  }
  assert.notEqual(await sha256(''), await sha256(null));
  assert.notEqual(await sha256('\u00e9'), await sha256('e\u0301'));
});

test('accept, edit and reject survive JSON export/import without human attestation or input mutation', async () => {
  const original = model();
  const snapshot = JSON.stringify({ bundle: original.bundle, report: original.report });
  const drafts = [
    await makeDraft(original.cards[0], 'accepted', 'ignored', 'Accept note', 'TEST_EDITOR'),
    await makeDraft(original.cards[1], 'edited', '  Өзгертілген мәтін\n', 'Edit note', 'TEST_EDITOR'),
    await makeDraft(original.cards[2], 'rejected', 'ignored', 'Reject note', 'TEST_EDITOR'),
  ];
  assert.equal(drafts[0].proposed_text, original.cards[0].finding.suggestion);
  assert.equal(drafts[1].proposed_text, '  Өзгертілген мәтін\n');
  assert.equal(drafts[2].proposed_text, null);
  assert.equal(drafts[0].original_hash, null);
  assert.ok(drafts.every(draft => !Object.hasOwn(draft, 'reviewed_by_human')));
  const saved = createWorkspace(original, drafts);
  assert.equal(saved.kind, 'qazaq-loc-qa-workspace');
  assert.equal(saved.version, 1);
  assert.equal(saved.imported_reviews.decisions.length, 0);
  const restored = await restoreWorkspace(JSON.parse(JSON.stringify(saved)), original);
  assert.deepEqual(restored.drafts, drafts);
  assert.deepEqual(restored.staleDrafts, []);
  assert.deepEqual(restored.reviews.applicable, []);
  assert.equal(JSON.stringify({ bundle: original.bundle, report: original.report }), snapshot);
});

test('drafts become stale when source, target, or suggestion changes, and remain recoverable', async () => {
  for (const field of ['source', 'target', 'suggestion']) {
    const before = model();
    const card = before.cards[1];
    const draft = await makeDraft(card, 'accepted', null, 'Keep this note', 'TEST_EDITOR');
    const saved = createWorkspace(before, [draft]);
    const bundle = structuredClone(before.bundle);
    const report = structuredClone(before.report);
    report[1][field] += ' changed';
    if (field !== 'suggestion') {
      const entry = bundle.entries.find(value => value.entry_id === card.entry.entry_id);
      entry[field] = report[1][field];
      entry[field === 'source' ? 'source_hash' : 'target_hash'] = hashText(entry[field]);
    }
    const after = createModel(bundle, report);
    const result = await restoreWorkspace(saved, after);
    assert.equal(result.drafts.length, 0, field);
    assert.equal(result.staleDrafts.length, 1, field);
    assert.deepEqual(result.staleDrafts[0].draft, draft, field);
    assert.ok(result.staleDrafts[0].reason, field);
  }
});

test('draft imports reject tampered proposed hashes and human-review fields atomically', async () => {
  const current = model();
  const draft = await makeDraft(current.cards[1], 'edited', 'Synthetic revision');
  const saved = createWorkspace(current, [draft]);
  for (const patch of [
    { proposed_text: 'Changed without a matching hash' },
    { proposed_hash: '0'.repeat(64) },
    { reviewed_by_human: true },
    { decision: 'approved' },
  ]) {
    const tampered = structuredClone(saved);
    Object.assign(tampered.drafts[0], patch);
    await assert.rejects(() => restoreWorkspace(tampered, current));
  }
  const duplicates = structuredClone(saved);
  duplicates.drafts.push(structuredClone(draft));
  await assert.rejects(() => restoreWorkspace(duplicates, current));
  const wrongLocale = structuredClone(saved);
  wrongLocale.target_locale = 'uz';
  await assert.rejects(() => restoreWorkspace(wrongLocale, current));
  assert.deepEqual(saved.drafts, [draft]);
});

test('missing and empty targets bind to distinct occurrence identities', async () => {
  const missing = model();
  const card = missing.cards[0];
  assert.equal(card.entry.target, null);
  assert.equal(card.entry.occurrence, 0);
  const saved = createWorkspace(missing, [await makeDraft(card, 'accepted')]);
  const emptyBundle = structuredClone(missing.bundle);
  const entry = emptyBundle.entries.find(value => value.entry_id === card.entry.entry_id);
  entry.target = ''; entry.target_hash = hashText('');
  entry.occurrence = 1; entry.entry_id = `${encodeURIComponent(entry.key)}#1`;
  const empty = createModel(emptyBundle, missing.report);
  const result = await restoreWorkspace(saved, empty);
  assert.equal(result.drafts.length, 0);
  assert.equal(result.staleDrafts.length, 1);
});

test('a new draft and stale missing-target draft both survive another save and import', async () => {
  const before = model();
  const previousDraft = await makeDraft(before.cards[0], 'accepted', undefined, 'Original missing target');
  const saved = createWorkspace(before, [previousDraft]);
  const changedBundle = structuredClone(before.bundle);
  const entry = changedBundle.entries.find(value => value.entry_id === before.cards[0].entry.entry_id);
  entry.target = ''; entry.target_hash = hashText('');
  entry.occurrence = 1; entry.entry_id = `${encodeURIComponent(entry.key)}#1`;
  const after = createModel(changedBundle, before.report);
  const recovered = await restoreWorkspace(saved, after);
  const currentDraft = await makeDraft(after.cards[0], 'edited', 'Synthetic replacement', 'Current empty target');
  const resaved = createWorkspace(after, [currentDraft, ...recovered.staleDrafts.map(item => item.draft)]);
  const restored = await restoreWorkspace(JSON.parse(JSON.stringify(resaved)), after);
  assert.deepEqual(restored.drafts, [currentDraft]);
  assert.equal(restored.staleDrafts.length, 1);
  assert.deepEqual(restored.staleDrafts[0].draft, previousDraft);
  const duplicateCurrent = createWorkspace(after, [currentDraft, structuredClone(currentDraft)]);
  await assert.rejects(() => restoreWorkspace(duplicateCurrent, after));
  const conflictingCurrent = await makeDraft(after.cards[0], 'rejected', undefined, 'Different current decision');
  await assert.rejects(() => restoreWorkspace(createWorkspace(after, [currentDraft, conflictingCurrent]), after));
});

test('ambiguous duplicate bundle keys and mismatched report text cannot receive decisions', async () => {
  const current = model();
  const bundle = structuredClone(current.bundle);
  const original = bundle.entries.find(entry => entry.entry_id === current.cards[1].entry.entry_id);
  bundle.entries.push({ ...original, occurrence: 2, entry_id: `${encodeURIComponent(original.key)}#2` });
  const duplicate = createModel(bundle, current.report);
  assert.ok(duplicate.cards[1].blockedReason);
  await assert.rejects(() => makeDraft(duplicate.cards[1], 'accepted'));
  const mismatchReport = structuredClone(current.report);
  mismatchReport[1].target += ' mismatch';
  const mismatch = createModel(current.bundle, mismatchReport);
  assert.ok(mismatch.cards[1].blockedReason);
  await assert.rejects(() => makeDraft(mismatch.cards[1], 'edited', 'Synthetic revision'));
});

test('valid imported mock reviews retain exact values and never modify report flags', async () => {
  const current = model();
  for (const decision of ['accepted', 'edited', 'rejected']) {
    const reviews = mockReviews(current.cards[1], decision);
    const snapshot = JSON.stringify(reviews);
    const result = await validateReviews(reviews, current);
    assert.deepEqual(result.applicable, reviews.decisions);
    assert.deepEqual(result.stale, []);
    const saved = createWorkspace(current, [], reviews);
    const restored = await restoreWorkspace(JSON.parse(JSON.stringify(saved)), current);
    assert.deepEqual(restored.reviews.applicable, reviews.decisions);
    assert.equal(JSON.stringify(reviews), snapshot);
  }
  assert.ok(current.report.every(finding => finding.reviewed_by_human === false));
});

test('stale source and original target reviews are quarantined, including null-vs-empty', async () => {
  const current = model();
  for (const field of ['source_hash', 'original_text']) {
    const reviews = mockReviews(current.cards[1]);
    if (field === 'source_hash') reviews.decisions[0].source_hash = hashText('Older synthetic source');
    else {
      reviews.decisions[0].original_text = 'Older synthetic target';
      reviews.decisions[0].original_hash = hashText(reviews.decisions[0].original_text);
    }
    const result = await validateReviews(reviews, current);
    assert.deepEqual(result.applicable, []);
    assert.equal(result.stale.length, 1);
    assert.deepEqual(result.stale[0].decision, reviews.decisions[0]);
  }
  const missingReview = mockReviews(current.cards[0]);
  missingReview.decisions[0].original_text = '';
  missingReview.decisions[0].original_hash = hashText('');
  assert.equal((await validateReviews(missingReview, current)).stale.length, 1);
});

test('review import rejects malformed or tampered attestations and foreign locales', async () => {
  const current = model();
  for (const patch of [
    { approved_text: 'Tampered synthetic approval' },
    { approved_hash: '0'.repeat(64) },
    { original_hash: '0'.repeat(64) },
    { reviewer: '   ' }, { reviewed_at: '2026-99-31T00:00:00Z' },
    { reviewed_at: '2026-10-31T12:00:60Z' },
    { reviewed_by_human: false }, { extra: 'unexpected' },
  ]) {
    const reviews = mockReviews(current.cards[1]);
    Object.assign(reviews.decisions[0], patch);
    await assert.rejects(() => validateReviews(reviews, current));
  }
  const duplicate = mockReviews(current.cards[1]);
  duplicate.decisions.push(structuredClone(duplicate.decisions[0]));
  await assert.rejects(() => validateReviews(duplicate, current));
  const foreign = mockReviews(current.cards[1]); foreign.target_locale = 'uz';
  await assert.rejects(() => validateReviews(foreign, current));
});
