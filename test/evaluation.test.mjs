import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evaluate, sampleForReview, validateReport, ISSUE_TYPES } from '../src/evaluation.mjs';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const label = (key, issue_type = 'untranslated') => ({ key, issue_type });
const finding = (key, issue_type = 'untranslated') => ({
  key, issue_type, severity: 'high', source: 'Synthetic source', target: '',
  evidence: 'Synthetic missing translation', suggestion: 'Synthetic replacement',
  confidence: 0.9, reviewed_by_human: false,
});

test('scores exact key/type with false positives and negatives', () => {
  const r = evaluate([label('a'), label('b', 'orthography')], [label('a'), label('b', 'wrong_language')]);
  assert.deepEqual(r.micro, { tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5, f1: 0.5, support: 2, predicted: 2 });
  assert.deepEqual(r.false_negatives, [label('b', 'orthography')]);
  assert.deepEqual(r.false_positives, [label('b', 'wrong_language')]);
  assert.equal(r.evaluation_scope, 'local_labeled_set');
  assert.equal(Object.keys(r.per_type).length, 11);
  assert.equal(r.per_type.orthography.fn, 1);
});

test('duplicates never inflate true positives', () => {
  const r = evaluate([label('a'), label('a')], [label('a'), label('a'), label('a')]);
  assert.equal(r.micro.tp, 1);
  assert.equal(r.counts.duplicate_gold_rows, 1);
  assert.equal(r.counts.duplicate_predicted_rows, 2);
});

test('undefined denominators are null and missed errors have recall zero', () => {
  assert.deepEqual(evaluate([], []).micro, { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null, support: 0, predicted: 0 });
  const missed = evaluate([label('a')], []).micro;
  assert.equal(missed.precision, null); assert.equal(missed.recall, 0); assert.equal(missed.f1, 0);
  const spurious = evaluate([], [label('a')]).micro;
  assert.equal(spurious.precision, 0); assert.equal(spurious.recall, null); assert.equal(spurious.f1, 0);
});

test('two types on one key remain distinct', () => {
  const a = [label('a', 'wrong_language'), label('a', 'same_as_source')];
  assert.equal(evaluate(a, a).micro.tp, 2);
});

test('rejects malformed input, blank keys and unknown categories', () => {
  for (const invalid of [null, {}, [null], [{ key: '', issue_type: 'untranslated' }], [{ key: ' ', issue_type: 'untranslated' }], [{ key: 5, issue_type: 'untranslated' }], [label('x', 'duplicate_key')]]) {
    assert.throws(() => evaluate(invalid, [])); assert.throws(() => evaluate([], invalid));
  }
});

test('all types supported; metrics independent of row order', () => {
  const a = ISSUE_TYPES.map((type, i) => label('example_' + i, type));
  assert.equal(evaluate(a, [...a].reverse()).micro.f1, 1);
  assert.deepEqual(evaluate(a, [...a].reverse()), evaluate([...a].reverse(), a));
});

test('sample reproducible, order independent, unique and leaves human answers unset', () => {
  const report = Array.from({ length: 30 }, (_, i) => finding('row_' + i));
  const first = sampleForReview(report, { size: 10, seed: 'precommitted-seed' });
  assert.deepEqual(first, sampleForReview([...report].reverse(), { size: 10, seed: 'precommitted-seed' }));
  assert.equal(first.rows.length, 10);
  assert.equal(new Set(first.rows.map((r) => r.sample_id)).size, 10);
  assert.ok(first.rows.every((r) => r.reviewed === null && r.correct === null && r.reviewer === null && r.finding.reviewed_by_human === false));
  assert.notDeepEqual(first.rows, sampleForReview(report, { size: 10, seed: 'other-seed' }).rows);
  first.rows[0].finding.target = 'changed';
  assert.ok(report.every((r) => r.target === ''));
});

test('sample capped, identical duplicates removed, empty sample supported', () => {
  const r = sampleForReview([finding('a'), finding('a')], { size: 100, seed: 's' });
  assert.equal(r.population_size, 1); assert.equal(r.duplicate_report_rows, 1); assert.equal(r.sample_size, 1);
  assert.equal(sampleForReview([], { seed: 's' }).sample_size, 0);
  assert.equal(sampleForReview([finding('a')], { size: 0, seed: 's' }).sample_size, 0);
});

test('sample rejects conflicting duplicate evidence; ignores object property order', () => {
  assert.throws(() => sampleForReview([finding('a'), { ...finding('a'), suggestion: 'different' }], { seed: 's' }), /Conflicting duplicate/);
  const reordered = Object.fromEntries(Object.entries(finding('a')).reverse());
  assert.equal(sampleForReview([finding('a'), reordered], { seed: 's' }).sample_size, 1);
});

test('whole population validated even for zero-size sample', () => {
  assert.throws(() => sampleForReview([finding('a'), { ...finding('b'), confidence: 2 }], { size: 0, seed: 's' }), /confidence/);
});

test('invalid sampling arguments and official fields rejected', () => {
  for (const size of [-1, 1.1, NaN, Infinity, '10', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => sampleForReview([], { size, seed: 's' }), /size/);
  for (const seed of [undefined, '', ' ', 42]) assert.throws(() => sampleForReview([], { seed }), /seed/);
  assert.throws(() => sampleForReview([label('a')], { seed: 's' }), /required/);
  for (const changes of [{ reviewed_by_human: 'true' }, { confidence: NaN }, { evidence: ' ' }, { suggestion: null }, { severity: 'critical' }]) assert.throws(() => validateReport([{ ...finding('a'), ...changes }]));
});

test('CLI file flow and overwrite protection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'locqa-evaluation-'));
  try {
    const gold = join(dir, 'gold.json'), report = join(dir, 'report.json'), sample = join(dir, 'nested', 'sample.json');
    await writeFile(gold, JSON.stringify([label('a')]));
    await writeFile(report, JSON.stringify([finding('a')]));
    const r = await run(process.execPath, ['scripts/evaluate.mjs', '--gold', gold, '--report', report], { cwd: repoRoot });
    assert.equal(JSON.parse(r.stdout).micro.precision, 1);
    await run(process.execPath, ['scripts/sample-review.mjs', '--report', report, '--out', sample, '--seed', 's'], { cwd: repoRoot });
    assert.equal(JSON.parse(await readFile(sample, 'utf8')).rows[0].correct, null);
    await assert.rejects(run(process.execPath, ['scripts/evaluate.mjs', '--gold', gold, '--report', report, '--out', gold], { cwd: repoRoot }), /must not overwrite/);
    await assert.rejects(run(process.execPath, ['scripts/sample-review.mjs', '--report', report, '--out', report, '--seed', 's'], { cwd: repoRoot }), /must not overwrite/);
    if (process.platform === 'win32') await assert.rejects(run(process.execPath, ['scripts/evaluate.mjs', '--gold', gold, '--report', report, '--out', gold.toUpperCase()], { cwd: repoRoot }), /must not overwrite/);
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('locqa-evaluation-'));
    await rm(dir, { recursive: true, force: true });
  }
});
