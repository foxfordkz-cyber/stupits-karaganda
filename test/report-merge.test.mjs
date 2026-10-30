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
