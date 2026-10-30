import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = new URL('../fixtures/synthetic/', import.meta.url);
const loadText = (name) => readFile(new URL(name, base), 'utf8');
const loadJson = async (name) => JSON.parse(await loadText(name));
const types = [
  'untranslated', 'same_as_source', 'placeholder_mismatch', 'plural_mismatch',
  'glossary_violation', 'length_overflow', 'machine_translation_suspect',
  'inconsistent_term', 'suffix_harmony', 'orthography', 'wrong_language',
];
const identity = ({ key, issue_type }) => JSON.stringify([key, issue_type]);
const fields = ['key', 'issue_type', 'severity', 'source', 'target', 'evidence',
  'suggestion', 'confidence', 'reviewed_by_human'].sort();

test('every issue type has exactly one synthetic gold example and sample finding', async () => {
  const [gold, report] = await Promise.all([loadJson('gold.json'), loadJson('report.sample.json')]);
  assert.equal(gold.length, types.length);
  assert.deepEqual(gold.map((row) => row.issue_type).sort(), [...types].sort());
  assert.equal(new Set(gold.map(identity)).size, gold.length);
  assert.deepEqual(report.map(identity).sort(), gold.map(identity).sort());
});

test('sample report uses actual paired texts, official fields and no human approvals', async () => {
  const [source, target, report] = await Promise.all([
    loadJson('source.arb'), loadJson('target.arb'), loadJson('report.sample.json'),
  ]);
  for (const finding of report) {
    assert.deepEqual(Object.keys(finding).sort(), fields, finding.key);
    assert.equal(finding.source, source[finding.key], finding.key);
    assert.equal(finding.target, target[finding.key] ?? '', finding.key);
    assert.equal(finding.reviewed_by_human, false, finding.key);
    assert.ok(['high', 'medium', 'low'].includes(finding.severity), finding.key);
    assert.ok(Number.isFinite(finding.confidence) && finding.confidence >= 0 && finding.confidence <= 1);
    assert.ok(typeof finding.evidence === 'string' && finding.evidence.length > 0);
    assert.ok(typeof finding.suggestion === 'string' && finding.suggestion.length > 0);
  }
});

test('negative examples exist in both files and are not labeled as errors', async () => {
  const [source, target, gold, negatives] = await Promise.all([
    loadJson('source.arb'), loadJson('target.arb'), loadJson('gold.json'), loadJson('negatives.json'),
  ]);
  const positives = new Set(gold.map(({ key }) => key));
  assert.equal(negatives.length, 7);
  assert.equal(new Set(negatives.map(({ key }) => key)).size, negatives.length);
  for (const { key, reason } of negatives) {
    assert.equal(typeof source[key], 'string', key);
    assert.equal(typeof target[key], 'string', key);
    assert.equal(positives.has(key), false, key);
    assert.ok(reason.length > 0);
  }
  for (const key of ['cleanBrand', 'cleanNumber', 'cleanRadioLoanword', 'cleanPrivateGlyph']) {
    assert.equal(source[key], target[key], key);
  }
  assert.equal(target.cleanPrivateGlyph.codePointAt(0), 0xe321);
  assert.deepEqual(target.cleanFormatTokens.match(/%[sd]/g), source.cleanFormatTokens.match(/%[sd]/g));
  assert.equal(target.cleanFormatTokens.includes('<g>%d</g>'), true);
  assert.equal(target.cleanFormatTokens.split('\n').length, 2);
});

test('missing key and placeholder typo are genuine controlled mutations', async () => {
  const [source, target] = await Promise.all([loadJson('source.arb'), loadJson('target.arb')]);
  assert.equal(Object.hasOwn(source, 'demoMissingExitLabel'), true);
  assert.equal(Object.hasOwn(target, 'demoMissingExitLabel'), false);
  assert.match(source.demoParcelNotice, /\{recipient\}/);
  assert.match(target.demoParcelNotice, /\{recipent\}/);
  assert.doesNotMatch(target.demoParcelNotice, /\{recipient\}/);
});

test('plural positives and negatives distinguish missing other from locale categories', async () => {
  const [source, target] = await Promise.all([loadJson('source.arb'), loadJson('target.arb')]);
  assert.match(source.demoTokenBalance, /other\{/);
  assert.doesNotMatch(target.demoTokenBalance, /other\{/);
  assert.match(source.cleanLocalePlural, /few\{/);
  assert.match(source.cleanLocalePlural, /many\{/);
  assert.doesNotMatch(target.cleanLocalePlural, /(?:few|many)\{/);
  assert.match(target.cleanLocalePlural, /other\{\{count\}/);
  assert.equal(source.cleanLocalePlural.includes('#'), false);
  assert.equal(target.cleanLocalePlural.includes('#'), false);
});

test('raw edge cases keep duplicate keys that ordinary JSON parsing would lose', async () => {
  const duplicates = await loadText('edge-cases/duplicate-normal-conflicting.arb');
  assert.equal([...duplicates.matchAll(/"edgeRepeatedLabel"\s*:/g)].length, 2);
  assert.equal(JSON.parse(duplicates).edgeRepeatedLabel, 'Екінші мәтін');
  assert.match(duplicates, /Бірінші мәтін/);
  const comments = await loadText('edge-cases/repeated-comments.arb');
  assert.equal([...comments.matchAll(/"@@comment"\s*:/g)].length, 3);
  assert.equal(JSON.parse(comments)['@@comment'], 'Третий вымышленный раздел');
});

test('Flutter smoke pair has matching keys and variable metadata with explicit ICU cases', async () => {
  const [source, target] = await Promise.all([
    loadJson('flutter-valid/source.arb'), loadJson('flutter-valid/target.arb'),
  ]);
  const messageKeys = (file) => Object.keys(file).filter((key) => !key.startsWith('@'));
  assert.deepEqual(messageKeys(source).sort(), messageKeys(target).sort());
  assert.equal(source['@@locale'], 'ru');
  assert.equal(target['@@locale'], 'kk');
  for (const file of [source, target]) {
    for (const key of messageKeys(file)) {
      assert.ok(Object.keys(file['@' + key].placeholders).length > 0, key);
      assert.equal(file['@' + key].reviewed_by_human, undefined);
    }
    assert.match(file.smokeNestedMessage, /role, select,/);
    assert.match(file.smokeNestedMessage, /count, plural,/);
    assert.match(file.smokeNestedMessage, /\{count\}/);
    assert.equal(file.smokeNestedMessage.includes('#'), false);
    assert.equal(file.smokeIslandCount.includes('#'), false);
    assert.equal([...file.smokeNestedMessage.matchAll(/other\{/g)].length, 3);
    assert.match(file.smokeEscapedText, /'\{'/);
    assert.match(file.smokeEscapedText, /'\}'/);
    assert.match(file.smokeEscapedText, /''/);
    assert.match(file['@smokeEscapedText'].description, /use-escaping: true/);
  }
});

test('parser edge-case ICU pair stays identical to the Flutter smoke pair', async () => {
  for (const locale of ['source', 'target']) {
    assert.equal(await loadText('edge-cases/icu-nested-escaped-' + locale + '.arb'),
      await loadText('flutter-valid/' + locale + '.arb'));
  }
});

test('synthetic glossary has the required header and fixture-specific terms', async () => {
  const csv = await loadText('glossary.csv');
  assert.equal(csv.split(/\r?\n/)[0], 'ru,kk,en,comment');
  assert.match(csv, /гильдия,бірлестік,guild,/);
  assert.match(csv, /StarPebble,StarPebble,StarPebble,/);
});
