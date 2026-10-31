import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeReports } from '../src/report-merge.mjs';

const finding = (key, issue_type = 'orthography') => ({
  key, issue_type, severity: 'medium', source: 'Synthetic source', target: 'Synthetic target',
  evidence: 'Synthetic evidence', suggestion: 'Synthetic correction', confidence: 0.8, reviewed_by_human: false,
});

test('merge deduplicates identical findings independent of object field order', () => {
  const a = finding('a');
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  const result = mergeReports([[a], [reordered], [finding('a')]]);
  assert.equal(result.duplicates, 2);
  assert.equal(result.report.length, 1);
});

test('merge keeps distinct types on same key and sorts deterministically', () => {
  const reports = [[finding('z')], [finding('a', 'wrong_language'), finding('a', 'orthography')]];
  assert.deepEqual(mergeReports(reports), mergeReports([...reports].reverse()));
  assert.deepEqual(mergeReports(reports).report.map(f => [f.key, f.issue_type]), [
    ['a', 'orthography'], ['a', 'wrong_language'], ['z', 'orthography'],
  ]);
});

test('merge rejects contradictory evidence, suggestions, review status and confidence', () => {
  for (const patch of [{ evidence: 'Other evidence' }, { suggestion: 'Other correction' }, { confidence: 0.9 }, { reviewed_by_human: true }]) {
    assert.throws(() => mergeReports([[finding('a')], [{ ...finding('a'), ...patch }]]), /Conflicting findings/);
  }
});

test('merge rejects malformed reports and preserves empty result shape', () => {
  assert.deepEqual(mergeReports([]), { report: [], duplicates: 0 });
  assert.deepEqual(mergeReports([[], []]), { report: [], duplicates: 0 });
  assert.throws(() => mergeReports([[{ ...finding('a'), issue_type: 'unknown' }]]));
  assert.throws(() => mergeReports([{}]));
});

test('merge rejects an absent reports collection instead of silently emitting a report', () => {
  assert.throws(() => mergeReports(undefined));
});

test('opt-in combination retains every explanation and proposal without inventing approval', () => {
  const a = finding('syntheticCompound');
  const b = { ...a, evidence: 'Second independent fragment', suggestion: 'Second proposal', severity: 'high', confidence: 0.6 };
  const before = JSON.stringify([a, b]);
  const merged = mergeReports([[a, b, a]], { combineSameText: true });
  assert.equal(merged.duplicates, 1);
  assert.equal(merged.report.length, 1);
  assert.equal(merged.report[0].suggestion, '');
  assert.equal(merged.report[0].confidence, 0.6);
  assert.equal(merged.report[0].severity, 'high');
  assert.equal(merged.report[0].reviewed_by_human, false);
  for (const f of [a, b]) {
    assert.ok(merged.report[0].evidence.includes(f.evidence));
    assert.ok(merged.report[0].evidence.includes(f.suggestion));
  }
  assert.equal(merged.combinations[0].variants.flatMap(v => v.origins).length, 3);
  assert.equal(JSON.stringify([a, b]), before);
  assert.deepEqual(mergeReports([[b], [a]], { combineSameText: true }).report, merged.report);
  assert.throws(() => mergeReports([[a, b]]), /Conflicting findings/);
});

test('opt-in combination never reconciles different versions or human status', () => {
  const a = finding('syntheticConflict');
  for (const patch of [{ source: 'Changed source' }, { target: 'Changed target' }, { reviewed_by_human: true }]) {
    assert.throws(() => mergeReports([[a, { ...a, ...patch }]], { combineSameText: true }), /require explicit resolution/);
  }
});
