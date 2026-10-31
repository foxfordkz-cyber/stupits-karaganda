import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sampleForReview } from '../../../src/evaluation.mjs';
import { scorePrecisionReview } from '../../../src/human-evaluation.mjs';
import { validatePrecision } from '../precision.mjs';

const report = JSON.parse(await readFile(new URL('../../../fixtures/synthetic/report.sample.json', import.meta.url), 'utf8'));
const sample = (size = 4, seed = 'report-module-synthetic-precision') => sampleForReview(report, { size, seed });

// Synthetic attestations exist only in unit-test memory; they do not represent human review.
function answer(row, correct, reviewer = 'SYNTHETIC_TEST_ONLY') {
  Object.assign(row, { reviewed: true, correct, reviewer, reviewed_at: '2026-10-31T12:00:00+05:00' });
}

async function matchesCanonical(value, currentReport = report) {
  const before = JSON.stringify({ value, currentReport });
  const expected = scorePrecisionReview(value, currentReport);
  const actual = await validatePrecision(value, currentReport);
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify({ value, currentReport }), before, 'import must not alter sample or report');
  return actual;
}

async function bothReject(value, currentReport = report) {
  assert.throws(() => scorePrecisionReview(value, currentReport));
  await assert.rejects(() => validatePrecision(value, currentReport));
}

test('precision import agrees with official counts for empty, partial and completed mock reviews', async () => {
  const value = sample();
  let result = await matchesCanonical(value);
  assert.deepEqual([result.confirmed, result.rejected, result.unreviewed], [0, 0, 4]);
  assert.equal(result.precision_on_reviewed, null);
  assert.equal(result.report_precision_estimate, null);
  answer(value.rows[0], true);
  answer(value.rows[1], false);
  result = await matchesCanonical(value);
  assert.deepEqual([result.confirmed, result.rejected, result.unreviewed], [1, 1, 2]);
  assert.equal(result.precision_on_reviewed, 0.5);
  assert.equal(result.report_precision_estimate, null);
  answer(value.rows[2], true, ' ANOTHER_SYNTHETIC_REVIEWER ');
  answer(value.rows[3], true);
  result = await matchesCanonical(value);
  assert.equal(result.complete, true);
  assert.equal(result.report_precision_estimate, 0.75);
  assert.deepEqual(result.reviewers, ['ANOTHER_SYNTHETIC_REVIEWER', 'SYNTHETIC_TEST_ONLY']);
  assert.equal(Object.hasOwn(result, 'recall'), false);
});

test('precision import accepts reordered rows/report without losing per-finding identities', async () => {
  const value = sample(); answer(value.rows[0], true); answer(value.rows[1], false);
  const expected = scorePrecisionReview(value, report);
  value.rows.reverse();
  assert.deepEqual(await matchesCanonical(value, [...report].reverse()), expected);
});

test('source, translation, evidence and suggestion drift invalidate the frozen report', async () => {
  for (const field of ['source', 'target', 'evidence', 'suggestion']) {
    const value = sample();
    const changed = structuredClone(report);
    changed[0][field] += ' synthetic changed version';
    await bothReject(value, changed);
  }
  const value = sample(2);
  const selected = new Set(value.rows.map(row => row.finding.key));
  const changed = structuredClone(report);
  const unselected = changed.find(finding => !selected.has(finding.key));
  assert.ok(unselected);
  unselected.suggestion += ' unseen change';
  await bothReject(value, changed);
});

test('precision import rejects missing, duplicate and unrecognized selected rows', async () => {
  const missing = sample(); missing.rows.pop(); await bothReject(missing);
  const duplicate = sample(); duplicate.rows[1] = structuredClone(duplicate.rows[0]); await bothReject(duplicate);
  const unknown = sample(); unknown.rows[0].sample_id = '0'.repeat(64); await bothReject(unknown);
  const foreign = sample(); foreign.evaluation_scope = 'blind_translation_review'; await bothReject(foreign);
  for (const value of [null, [], { kind: 'qazaq-loc-qa-workspace', version: 1 }, { schema_version: '1.0', target_locale: 'kk', decisions: [] }]) {
    await bothReject(value);
  }
});

test('changing a seed that selects different findings cannot preserve the previous answers', async () => {
  const value = sample(3);
  const originalIds = value.rows.map(row => row.sample_id).sort().join(',');
  const changedSeed = Array.from({ length: 50 }, (_, index) => `changed-synthetic-seed-${index}`)
    .find(seed => sample(3, seed).rows.map(row => row.sample_id).sort().join(',') !== originalIds);
  assert.ok(changedSeed);
  value.seed = changedSeed;
  await bothReject(value);
  // The canonical format does not authenticate the original seed when every row is selected.
  const entire = sample(report.length); entire.seed = 'another-full-population-seed';
  await matchesCanonical(entire);
});

test('precision import detects changed selected finding payload and stale optional hashes', async () => {
  const changedFinding = sample(); changedFinding.rows[0].finding.source += ' changed'; await bothReject(changedFinding);
  const reportHash = sample(); reportHash.report_sha256 = 'f'.repeat(64); await bothReject(reportHash);
  const findingHash = sample(); findingHash.rows[0].finding_sha256 = 'a'.repeat(64); await bothReject(findingHash);
  for (const field of ['sample_size', 'population_size', 'duplicate_report_rows', 'requested_size']) {
    const changed = sample(); changed[field]++; await bothReject(changed);
  }
});

test('unreviewed rows cannot silently become confirmations through incomplete or invalid answers', async () => {
  for (const patch of [
    { reviewed: true, correct: true },
    { reviewed: true, correct: true, reviewer: ' ', reviewed_at: '2026-10-31T12:00:00Z' },
    { reviewed: true, correct: true, reviewer: 'TEST_ONLY', reviewed_at: '2026-02-30T12:00:00Z' },
    { reviewed: true, correct: null, reviewer: 'TEST_ONLY', reviewed_at: '2026-10-31T12:00:00Z' },
    { reviewed: true, correct: 'true', reviewer: 'TEST_ONLY', reviewed_at: '2026-10-31T12:00:00Z' },
    { reviewed: false, correct: null }, { reviewed: null, correct: true },
    { reviewed: null, reviewer: 'TEST_ONLY' }, { reviewed: null, reviewed_at: '2026-10-31T12:00:00Z' },
    { notes: {} },
  ]) {
    const value = sample(); Object.assign(value.rows[0], patch); await bothReject(value);
  }
});

test('zero-size and empty-population samples retain undefined precision rather than perfect quality', async () => {
  const zero = await matchesCanonical(sample(0));
  assert.equal(zero.sample_size, 0);
  assert.equal(zero.precision_on_reviewed, null);
  assert.equal(zero.report_precision_estimate, null);
  const empty = sampleForReview([], { size: 100, seed: 'empty-synthetic' });
  const result = await matchesCanonical(empty, []);
  assert.equal(result.confirmed, 0);
  assert.equal(result.wilson95_on_reviewed.lower, null);
});

test('legacy samples preserve canonical limitations without manufacturing whole-report certainty', async () => {
  const value = sample(); delete value.report_sha256;
  for (const row of value.rows) { delete row.finding_sha256; answer(row, true); }
  const result = await matchesCanonical(value);
  assert.equal(result.population_binding, 'legacy_selected_findings_only');
  assert.equal(result.precision_on_reviewed, 1);
  assert.equal(result.report_precision_estimate, null);
  const unreviewed = sample(); delete unreviewed.report_sha256;
  for (const row of unreviewed.rows) { delete row.finding_sha256; delete row.reviewed_at; delete row.reviewer; }
  await matchesCanonical(unreviewed);
});

test('duplicate report rows follow canonical de-duplication and reject conflicting versions', async () => {
  const duplicates = [...report, structuredClone(report[0])];
  const value = sampleForReview(duplicates, { size: 4, seed: 'synthetic-duplicates' });
  const result = await matchesCanonical(value, duplicates);
  assert.equal(result.population_size, report.length);
  const conflicting = structuredClone(duplicates); conflicting.at(-1).suggestion += ' conflict';
  await bothReject(value, conflicting);
});
