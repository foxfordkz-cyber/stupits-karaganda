import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashText } from '../../../src/contracts.mjs';
import { assessReviews, commitHandoff } from '../review-gate.mjs';
import { parseJson, readText, privatePath, writeAtomicNew, withStateLock } from '../review-io.mjs';

// Explicit contract doubles, NEVER evidence of human review or real core safety.
const reviewer = 'SYNTHETIC_TEST_DOUBLE_NOT_HUMAN';
function fixture() {
  const e = { key: 'testGift', entry_id: 'testGift#1', occurrence: 1,
    source: 'Подарок', target: 'Сыйлык', source_hash: hashText('Подарок'), target_hash: hashText('Сыйлык'), context: {} };
  const f = { key: e.key, issue_type: 'orthography', severity: 'low', source: e.source, target: e.target,
    evidence: 'Synthetic spelling example.', suggestion: 'Сыйлық', confidence: 0.9, reviewed_by_human: false };
  const bundle = { schema_version: '1.0', source_locale: 'ru', target_locale: 'kk', entries: [e] };
  const queue = { kind: 'bekzat-language-review-queue', version: 2, rows: [{ ...e, ...f, finding_index: 0,
    status: 'pending_human_review', candidates: [{ candidate_id: 'synthetic', text: 'Сыйлық', text_hash: hashText('Сыйлық'), reviewed_by_human: false }] }] };
  const d = { key: e.key, entry_id: e.entry_id, decision: 'accepted', original_text: e.target,
    approved_text: 'Сыйлық', source_hash: e.source_hash, original_hash: e.target_hash, approved_hash: hashText('Сыйлық'),
    reviewer, reviewed_at: '2026-10-31T00:00:00Z', reviewed_by_human: true };
  return { bundle, report: [f], queue, reviews: { schema_version: '1.0', target_locale: 'kk', decisions: [d] },
    authorizedReviewers: [reviewer], sourceText: 'CONTRACT_DOUBLE', targetText: 'CONTRACT_DOUBLE',
    core: { normalizeArbs: () => ({ bundle, diagnostics: [] }), checkBundle: () => ({ report: [], diagnostics: [] }),
      exportApproved: () => ({ text: 'CONTRACT_DOUBLE', audit: {} }) },
    linguistics: { auditReviews: () => ({ status: 'consistent', human_identity_verified: false }) } };
}
function temporary(t) { const p = mkdtempSync(join(tmpdir(), 'bekzat-gate-test-')); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }
const codes = g => g.problems.flatMap(p => p.codes ?? [p.code]);

test('empty real-review boundary remains pending; no implicit approval or mutated input', () => {
  const x = fixture(); x.reviews.decisions = []; const before = structuredClone({ bundle:x.bundle, queue:x.queue, reviews:x.reviews });
  const gate = assessReviews(x);
  assert.equal(gate.status, 'HUMAN_REVIEW_PENDING'); assert.equal(gate.human_decisions_created, 0);
  assert.equal(gate.approved_reviews, null); assert.deepEqual(gate.unconfirmed_entry_ids, ['testGift#1']);
  assert.deepEqual({ bundle:x.bundle, queue:x.queue, reviews:x.reviews }, before);
});
test('accepted whole candidate and edited human text both require owner preflight', () => {
  const x = fixture(); assert.equal(assessReviews(x).status, 'READY_FOR_INTEGRATOR');
  x.reviews.decisions[0].approved_text = 'Жаңа сыйлық'; x.reviews.decisions[0].approved_hash = hashText('Жаңа сыйлық');
  assert.ok(codes(assessReviews(x)).includes('accepted_text_is_not_current_candidate_use_edited'));
  x.reviews.decisions[0].decision = 'edited'; assert.equal(assessReviews(x).status, 'READY_FOR_INTEGRATOR');
  delete x.core; assert.ok(codes(assessReviews(x)).includes('real_core_and_linguistics_required'));
});
test('stale source, original text and unauthorized reviewer cannot enter handoff', () => {
  for (const field of ['source', 'original', 'reviewer']) {
    const x = fixture(), d = x.reviews.decisions[0];
    if (field === 'source') d.source_hash = hashText('old source');
    if (field === 'original') { d.original_text = 'old target'; d.original_hash = hashText(d.original_text); }
    if (field === 'reviewer') d.reviewer = 'NOT_IN_ALLOWLIST';
    const g = assessReviews(x); assert.equal(g.status, 'BLOCKED'); assert.equal(g.approved_reviews, null);
  }
});
test('duplicate occurrence, absent target, changed queue and model human flag fail closed', () => {
  let x = fixture(); x.bundle.entries.push({ ...x.bundle.entries[0], occurrence: 2, entry_id: 'testGift#2' });
  assert.ok(codes(assessReviews(x)).includes('duplicate_occurrence_requires_integrator'));
  x = fixture(); x.bundle.entries[0].target = null; x.bundle.entries[0].target_hash = null;
  x.bundle.entries[0].entry_id = 'testGift#0'; x.bundle.entries[0].occurrence = 0; x.queue.rows = []; x.report = [];
  assert.ok(codes(assessReviews(x)).includes('outside_language_queue'));
  x = fixture(); x.queue.rows[0].source_hash = hashText('changed'); assert.throws(() => assessReviews(x), /stale_queue/);
  x = fixture(); x.queue.rows[0].reviewed_by_human = true; assert.throws(() => assessReviews(x), /machine_approval/);
});
test('technical owner rejection and Aidana rejection block a supplied approval', () => {
  let x = fixture(); x.core.exportApproved = () => { throw Error('placeholder or ICU failure'); };
  assert.ok(codes(assessReviews(x)).includes('core_export_preflight_rejected'));
  x = fixture(); x.linguistics.auditReviews = () => ({ status: 'failed' });
  assert.ok(codes(assessReviews(x)).includes('linguistics_audit_failed'));
});
test('shared reviews schema rejects duplicate decisions and forged approved hash', () => {
  let x = fixture(); x.reviews.decisions.push({ ...x.reviews.decisions[0] }); assert.throws(() => assessReviews(x), /Multiple decisions/);
  x = fixture(); x.reviews.decisions[0].approved_hash = hashText('forged'); assert.throws(() => assessReviews(x), /Stale review hash/);
});
test('rejected decision preserves history, releases nothing, and clears pending entry', () => {
  const x = fixture(), d = x.reviews.decisions[0]; d.decision = 'rejected'; d.approved_text = null; d.approved_hash = null;
  const g = assessReviews(x); assert.equal(g.status, 'NO_APPROVED_CHANGES'); assert.equal(g.approved_reviews, null);
  assert.equal(g.unconfirmed_entry_ids.length, 0); assert.equal(d.reviewed_by_human, true);
});
test('durable receipt prevents replay and conflicting approval for same version', t => {
  const state = temporary(t), x = fixture(), gate = assessReviews(x);
  const first = withStateLock(state, () => commitHandoff(state, gate, { synthetic: true }));
  assert.ok(first.receipt.receipt_id); const file = join(state, 'receipts', first.receipt.receipt_id + '.json'), saved = readFileSync(file, 'utf8');
  assert.equal(withStateLock(state, () => commitHandoff(state, gate, {})).gate.status, 'ALREADY_HANDED_OFF');
  x.reviews.decisions[0].decision = 'edited'; x.reviews.decisions[0].approved_text = 'Басқа мәтін'; x.reviews.decisions[0].approved_hash = hashText('Басқа мәтін');
  assert.equal(withStateLock(state, () => commitHandoff(state, assessReviews(x), {})).gate.status, 'CONFLICTING_PREVIOUS_HANDOFF');
  assert.equal(readFileSync(file, 'utf8'), saved);
});
test('interrupted publication recovers from committed receipt without issuing twice', t => {
  const state = temporary(t), gate = assessReviews(fixture());
  assert.throws(() => withStateLock(state, () => commitHandoff(state, gate, {}, { afterCommit: () => { throw Error('injected crash'); } })), /injected/);
  assert.equal(existsSync(join(state, 'review-gate.lock')), false);
  const retry = withStateLock(state, () => commitHandoff(state, gate, {}));
  assert.equal(retry.gate.status, 'ALREADY_HANDED_OFF'); assert.equal(retry.receipt, null);
  assert.equal(readdirSync(join(state, 'receipts')).length, 1);
});
test('partial replay cannot silently issue remaining decisions', t => {
  const state = temporary(t), gate = assessReviews(fixture());
  withStateLock(state, () => commitHandoff(state, gate, {}));
  gate.approved_reviews.decisions.push({ ...gate.approved_reviews.decisions[0], key: 'second', entry_id: 'second#1' });
  assert.equal(withStateLock(state, () => commitHandoff(state, gate, {})).gate.status, 'PARTIALLY_HANDED_OFF');
});
test('corrupt history blocks new handoff and existing state lock is never stolen', t => {
  const state = temporary(t), gate = assessReviews(fixture()); mkdirSync(join(state, 'receipts'));
  writeFileSync(join(state, 'receipts', 'bad.json'), '{}');
  assert.throws(() => withStateLock(state, () => commitHandoff(state, gate, {})), /corrupt/);
  writeFileSync(join(state, 'review-gate.lock'), 'unverified owner');
  assert.throws(() => withStateLock(state, () => null), /state_locked/);
  assert.equal(readFileSync(join(state, 'review-gate.lock'), 'utf8'), 'unverified owner');
});
test('strict JSON/UTF8, private paths and atomic publication preserve existing content', t => {
  for (const text of ['{"x":1,"x":2}', '{"x":1e999}', '{"x":"\\ud800"}', '{"x":1,}', '/*x*/{}', '['.repeat(130)+'0'+']'.repeat(130)]) assert.throws(() => parseJson(text));
  assert.deepEqual({ ...parseJson('{"қазақ":"Ә🙂"}') }, { қазақ: 'Ә🙂' });
  const dir = temporary(t), file = join(dir, 'out.json'); writeAtomicNew(file, { v: 1 });
  assert.throws(() => writeAtomicNew(file, { v: 2 }), /output_exists/); assert.deepEqual({ ...parseJson(readText(file)) }, { v: 1 });
  writeFileSync(join(dir, 'bad'), Buffer.from([0xc0, 0xaf])); assert.throws(() => readText(join(dir, 'bad')));
  mkdirSync(join(dir, '.git')); assert.throws(() => privatePath(join(dir, 'nested', 'out')), /inside_git/);
});
