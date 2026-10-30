import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readArb, checkArbs, checkBundle, normalizeArbs, exportApproved } from '../index.mjs';
import { parseGlossary } from '../glossary.mjs';
import { assertFlutterEvidence } from '../flutter.mjs';
import { assertContract, hashText } from '../../../src/contracts.mjs';
import { runPipeline } from '../../../src/pipeline.mjs';

const fixture = path => readFile(new URL('../../../fixtures/synthetic/' + path, import.meta.url), 'utf8');
const arb = (locale, values) => JSON.stringify({ '@@locale': locale, ...values }, null, 2);
const check = (source, target, options = {}) => checkArbs({ sourceText: arb('ru', source), targetText: arb('kk', target), ...options });
const types = result => result.report.map(f => f.issue_type);
const emptyReviews = () => ({ schema_version: '1.0', target_locale: 'kk', decisions: [] });

// Test doubles only. These in-memory attestations are never reviews of real
// translations, and the production module provides no approval generator.
function decision(source, original, approved, key = 'greeting', occurrence = original === null ? 0 : 1) {
  return { key, entry_id: encodeURIComponent(key) + '#' + occurrence, decision: 'accepted', original_text: original, approved_text: approved,
    source_hash: hashText(source), original_hash: hashText(original), approved_hash: hashText(approved),
    reviewer: 'TEST_DOUBLE_NOT_A_HUMAN_REVIEW', reviewed_at: '2026-10-30T00:00:00Z', reviewed_by_human: true };
}
function exported(source, original, approved, options = {}) {
  return exportApproved({ sourceText: arb('ru', { greeting: source }), targetText: arb('kk', { greeting: original }),
    reviews: { ...emptyReviews(), decisions: [decision(source, original, approved)] }, ...options });
}

test('live checks find the five core synthetic examples without negative findings', async () => {
  const result = checkArbs({ sourceText: await fixture('source.arb'), targetText: await fixture('target.arb'), glossaryText: await fixture('glossary.csv') });
  assert.deepEqual(result.report.map(f => [f.key, f.issue_type]), [
    ['demoMissingExitLabel', 'untranslated'], ['demoUntranslatedAction', 'same_as_source'],
    ['demoParcelNotice', 'placeholder_mismatch'], ['demoTokenBalance', 'plural_mismatch'], ['demoShortTab', 'length_overflow']
  ]);
  assert.ok(result.report.every(f => f.reviewed_by_human === false));
  assertContract('report', result.report); assertContract('bundle', result.bundle);
  assert.equal(result.manifest.mode, 'live_core_detection');
});

test('loader keeps duplicate occurrences, sections, metadata, exact raw spans and hashes', () => {
  const text = '{\n"@@locale":"kk", "@@comment":"first", "greeting":"one", "@@comment":"second", "greeting":"two", "@greeting":{"description":"context"}\n}';
  const parsed = readArb(text);
  assert.deepEqual(parsed.groups.get('greeting').map(p => [p.occurrence, p.section]), [[1, 'first'], [2, 'second']]);
  assert.equal(parsed.properties.filter(p => p.key === '@@comment').length, 2);
  assert.equal(parsed.metadata.get('@greeting').value.description, 'context');
  assert.equal(parsed.sha256, hashText(text));
  for (const p of parsed.properties) assert.equal(p.raw, text.slice(p.offset, p.offset + p.length));
  assert.ok(parsed.diagnostics.some(d => d.code === 'duplicate_key'));
});

test('conflicting source duplicates cannot silently choose a source for bundle', () => {
  const result = checkArbs({ sourceText: '{"@@locale":"ru","greeting":"a","greeting":"b"}', targetText: arb('kk', { greeting: 'c' }) });
  assert.deepEqual(result.bundle.entries, []);
  assert.equal(result.report.length, 0);
  assert.ok(result.diagnostics.some(d => d.code === 'duplicate_key'));
});

test('target duplicates keep identities and per-finding trace outside report', () => {
  const result = checkArbs({ sourceText: arb('ru', { greeting: 'Hello {name}' }), targetText: '{"@@locale":"kk","greeting":"One","greeting":"Two"}' });
  assert.deepEqual(result.bundle.entries.map(e => e.entry_id), ['greeting#1', 'greeting#2']);
  assert.deepEqual(result.trace.flatMap(t => t.entry_ids), ['greeting#1', 'greeting#2']);
  assert.ok(!JSON.stringify(result.report).includes('entry_id'));
});

test('invalid JSON, nested duplicates, bad resource names, nonstring values diagnosed', () => {
  for (const text of ['{"a":"b",}', '{/*comment*/"a":"b"}', '[]', '{"a":']) assert.throws(() => readArb(text), /invalid ARB/);
  const parsed = readArb('{"inventoryEquipped@description":"invented","bad":3,"@bad":{"x":1,"x":2}}');
  assert.deepEqual(new Set(parsed.diagnostics.map(d => d.code)), new Set(['invalid_resource_name', 'non_string_resource', 'duplicate_attribute']));
});

test('missing target differs from empty and whitespace-only translations', () => {
  const result = check({ missing: 'Text', empty: 'Text', spaces: 'Text', blank: '' }, { empty: '', spaces: ' \n ', blank: '' });
  assert.equal(result.report.length, 3);
  assert.deepEqual(result.bundle.entries.map(e => [e.occurrence, e.target]), [[0, null], [1, ''], [1, ' \n '], [1, '']]);
});

test('same-source exceptions come from CSV terms or nonlinguistic content', () => {
  const result = check({ brand: 'BrandX', radio: 'Радио', number: '2048', glyph: '\ue321', placeholder: '{name}', translated: 'Текст' },
    { brand: 'BrandX', radio: 'Радио', number: '2048', glyph: '\ue321', placeholder: '{name}', translated: 'Текст' },
    { glossaryText: 'ru,kk,comment\r\nBrandX,BrandX,"Quoted, context"\r\nрадио,радио,"line\nwith ""quotes"""\r\n' });
  assert.deepEqual(result.report.map(f => f.key), ['translated']);
});

test('unchanged linguistic text inside nested ICU is found without flagging technical-only messages', () => {
  const nested = '{role, select, pilot{{n, plural, one{Один} other{Несколько}}} other{Нет}}';
  assert.ok(types(check({ message: nested }, { message: nested })).includes('same_as_source'));
  const technical = { markup: '<b>{name}</b>', standalone: '<nick>', printf: '%s %2$d', entity: '&nbsp; &amp;',
    select: '{role, select, pilot{{name}} other{{name}}}' };
  assert.deepEqual(check(technical, technical).report, []);
});

test('blank or malformed identities stay in diagnostics without breaking valid entries', () => {
  const result = check({ '': 'bad', ' ': 'bad', '\ud800': 'bad', greeting: 'Hello' }, { greeting: 'Сәлем' });
  assert.deepEqual(result.bundle.entries.map(e => e.key), ['greeting']);
  assert.equal(result.diagnostics.filter(d => d.code === 'invalid_resource_name').length, 3);
  assert.equal(result.baselinePlan.issues.length, 3);
});

test('baseline plan binds original hashes, all occurrences and sections with no assumed decisions', () => {
  const sourceText = '{"@@locale":"ru","same":"A","same":"A","choice":"A","choice":"B"}';
  const targetText = '{"@@locale":"kk","@@comment":"first","choice":"C","@@comment":"second","choice":"D","BadName":"E"}';
  const result = checkArbs({ sourceText, targetText }), plan = result.baselinePlan;
  assert.equal(plan.source_sha256, hashText(sourceText));
  assert.equal(plan.target_sha256, hashText(targetText));
  assert.equal(plan.decisions_applied, 0);
  assert.ok(plan.issues.every(issue => issue.decision === null));
  assert.equal(plan.issues.find(issue => issue.key === 'same').kind, 'identical_duplicate');
  const choice = plan.issues.find(issue => issue.key === 'choice' && issue.side === 'target');
  assert.equal(choice.kind, 'conflicting_duplicate');
  assert.deepEqual(choice.occurrences.map(o => [o.entry_id, o.section, o.value_hash]), [['choice#1', 'first', hashText('C')], ['choice#2', 'second', hashText('D')]]);
  assert.ok(plan.issues.some(issue => issue.kind === 'invalid_resource_name'));
  assert.equal(result.audit.source.properties.filter(p => p.key === 'choice').length, 2);
});

test('glossary rejects malformed, missing and duplicate columns', () => {
  for (const text of ['ru,en\na,b', 'ru,kk\na', 'ru,kk\n"a,b', 'ru,kk,kk\na,b,c', 'ru,kk\n"a"x,b']) assert.throws(() => parseGlossary(text, 'ru', 'kk'));
});

test('locale declaration cannot be overridden silently; missing locale requires option', () => {
  assert.throws(() => check({}, {}, { targetLocale: 'en' }), /conflicts/);
  assert.throws(() => checkArbs({ sourceText: '{}', targetText: '{}' }), /Missing locale/);
  assert.doesNotThrow(() => checkArbs({ sourceText: '{}', targetText: '{}', sourceLocale: 'ru', targetLocale: 'kk' }));
});

test('RU/KK plural categories may differ and other alone is valid fallback', () => {
  const result = check({ items: '{n, plural, one{{n} A} few{{n} B} many{{n} C} other{{n} D}}' }, { items: '{n, plural, other{{n} E}}' });
  assert.deepEqual(result.report, []);
});

test('CLDR rules classify unused KK categories without requiring Russian categories', () => {
  const result = check({ items: '{n, plural, one{A} other{B}}' }, { items: '{n, plural, few{C} other{D}}' });
  assert.ok(types(result).includes('plural_mismatch'));
  assert.match(result.report[0].evidence, /unused for kk/);
});

test('missing other and malformed plural are explainable plural findings', () => {
  for (const target of ['{n, plural, one{B}}', '{n, plural, one{B} other{C}']) {
    const result = check({ items: '{n, plural, one{A} other{B}}' }, { items: target });
    assert.ok(types(result).includes('plural_mismatch'));
  }
});

test('plural expression, exact selectors and offsets cannot disappear', () => {
  const source = '{n, plural, offset:1 =0{None} one{One} other{Many}}';
  for (const target of ['{n}', '{n, plural, offset:1 other{Many}}', '{n, plural, =0{None} other{Many}}']) {
    assert.ok(types(check({ items: source }, { items: target })).includes('plural_mismatch'));
  }
});

test('repeated placeholders and ICU number tokens cannot silently disappear', () => {
  assert.ok(types(check({ message: '{name}: {name}' }, { message: '{name}' })).includes('placeholder_mismatch'));
  assert.ok(types(check({ message: '{n, plural, other{# шт.}}' }, { message: '{n, plural, other{дана}}' })).includes('placeholder_mismatch'));
});

test('nested ICU and escaping parse structurally', async () => {
  const result = checkArbs({ sourceText: await fixture('edge-cases/icu-nested-escaped-source.arb'), targetText: await fixture('edge-cases/icu-nested-escaped-target.arb') });
  assert.deepEqual(result.report, []);
  assert.deepEqual(result.diagnostics, []);
});

test('plural cannot be lost in one select branch or moved to another', () => {
  const source = '{role, select, pilot{{n, plural, other{{n} A}}} other{{n, plural, other{{n} B}}}}';
  const target = '{role, select, pilot{{n}} other{{n, plural, other{{n} C}}}}';
  assert.ok(types(check({ items: source }, { items: target })).includes('plural_mismatch'));
});

test('select labels and nested argument coverage are preserved', () => {
  const source = '{role, select, pilot{Hi {name}} other{Bye {name}}}';
  for (const target of ['{role, select, other{Hi {name}}}', '{role, select, pilot{Hi} other{Hi {name}}}']) {
    assert.ok(types(check({ items: source }, { items: target })).includes('placeholder_mismatch'));
  }
});

test('additional localized branches preserve fallback arguments and per-branch formatting', () => {
  assert.ok(types(check({ items: '{n, plural, other{Hello {name}}}' }, { items: '{n, plural, one{Hi} other{Hi {name}}}' })).includes('placeholder_mismatch'));
  const source = '{role, select, pilot{{n, number, integer}} other{{n, number, integer}}}';
  const target = '{role, select, pilot{{n}} other{{n, number, integer}}}';
  assert.ok(types(check({ items: source }, { items: target })).includes('placeholder_mismatch'));
});

test('printf positions, formatting styles and markup balance are checked', () => {
  for (const [source, target] of [['%s %d', '%d %s'], ['{n, number, integer}', '{n}'], ['{n}', '{n, number}'], ['<b><i>A</i></b>', '<b><i>B</b></i>'], ['Hi {name}', 'Hi {naem}']]) {
    assert.ok(types(check({ greeting: source }, { greeting: target })).includes('placeholder_mismatch'));
  }
  assert.deepEqual(check({ greeting: '%2$d %1$s' }, { greeting: '%1$s %2$d' }).report, []);
});

test('invalid source ICU is separated from target findings', () => {
  const result = check({ greeting: '{broken' }, { greeting: 'Text' });
  assert.equal(result.report.length, 0);
  assert.ok(result.diagnostics.some(d => d.code === 'source_message_invalid'));
});

test('length heuristic measures graphemes and is configurable', () => {
  const result = check({ tab: 'Карта' }, { tab: 'Өте ұзын жасанды қойынды атауы' });
  assert.ok(types(result).includes('length_overflow'));
  assert.deepEqual(check({ tab: 'Карта' }, { tab: 'Өте ұзын жасанды қойынды атауы' }, { lengthRatio: 20 }).report, []);
  assert.throws(() => check({}, {}, { lengthRatio: NaN }), /positive finite/);
});

test('protected symbols and line breaks are structural diagnostics, not a twelfth type', () => {
  const result = check({ greeting: 'A\n\ue321' }, { greeting: 'B' });
  assert.ok(result.diagnostics.some(d => d.code === 'protected_token_mismatch'));
  assert.equal(result.report.length, 0);
});

test('empty review log does not invent corrections or human stamps', () => {
  const sourceText = arb('ru', { greeting: 'Hello' }), targetText = arb('kk', { greeting: 'Сәлем' });
  const result = exportApproved({ sourceText, targetText, reviews: emptyReviews() });
  assert.equal(result.text, targetText);
  assert.equal(result.audit.changed_count, 0);
  assert.equal(result.audit.flutter_verified, false);
});

test('approved change preserves other bytes, repeated sections and metadata', () => {
  const sourceText = arb('ru', { greeting: 'Hello {name}', untouched: 'Bye' });
  const targetText = '{\n "@@locale":"kk", "@@comment":"one", "greeting":"Hi {name}",\n "@greeting":{"description":"context","placeholders":{"name":{"type":"String"}}},\n "@@comment":"two", "untouched" : "Untouched\\n"\n}';
  // Preserve the original newline in the unchanged message on both sides.
  const result = exportApproved({ sourceText: sourceText.replace('"Bye"', '"Bye\\n"'), targetText,
    reviews: { ...emptyReviews(), decisions: [decision('Hello {name}', 'Hi {name}', 'Сәлем {name}')] } });
  const parsed = readArb(result.text);
  assert.equal(parsed.groups.get('greeting')[0].value, 'Сәлем {name}');
  assert.equal(parsed.properties.filter(p => p.key === '@@comment').length, 2);
  assert.ok(result.text.includes('"untouched" : "Untouched\\n"'));
  assert.equal(parsed.metadata.get('@greeting').value.description, 'context');
  assert.equal(parsed.metadata.get('@greeting').value['x-locqa'].reviewer, 'TEST_DOUBLE_NOT_A_HUMAN_REVIEW');
});

test('each changed hash invalidates approval and false review flag is rejected', () => {
  const sourceText = arb('ru', { greeting: 'Hello' }), targetText = arb('kk', { greeting: 'Hi' });
  const d = decision('Hello', 'Hi', 'Сәлем');
  for (const bad of [{ source_hash: hashText('Changed') }, { original_text: 'Changed', original_hash: hashText('Changed') }, { approved_text: 'Changed' }, { reviewed_by_human: false }, { entry_id: 'greeting#2' }]) {
    assert.throws(() => exportApproved({ sourceText, targetText, reviews: { ...emptyReviews(), decisions: [{ ...d, ...bad }] } }));
  }
});

test('rejected change never applies and stale existing stamps are removed', () => {
  const d = { ...decision('Hello', 'Hi', null), decision: 'rejected' };
  const result = exportApproved({ sourceText: arb('ru', { greeting: 'Hello' }), targetText: arb('kk', { greeting: 'Hi', '@greeting': { description: 'keep', 'x-locqa': { reviewed_by_human: true, approved_hash: hashText('Hi') } } }), reviews: { ...emptyReviews(), decisions: [d] } });
  const metadata = readArb(result.text).metadata.get('@greeting').value;
  assert.equal(metadata.description, 'keep'); assert.equal(metadata['x-locqa'], undefined);
  assert.equal(result.audit.changed_count, 0);
  assert.deepEqual(result.audit.invalidated_stamps, ['greeting']);
});

test('missing translation uses occurrence 0 and inherits placeholder metadata', () => {
  const d = decision('Hello {name}', null, 'Сәлем {name}');
  const result = exportApproved({ sourceText: arb('ru', { greeting: d.original_text ?? 'Hello {name}', '@greeting': { placeholders: { name: { type: 'String' } } } }), targetText: arb('kk', {}), reviews: { ...emptyReviews(), decisions: [d] } });
  assert.equal(readArb(result.text).metadata.get('@greeting').value.placeholders.name.type, 'String');
});

test('even human-approved text cannot drop placeholders, markup, newlines or font glyphs', () => {
  for (const [source, original, approved] of [
    ['Hi {name}', 'Hello {name}', 'Hello'], ['<b>Hi</b>', '<b>Hello</b>', 'Hello'],
    ['Hi\n', 'Hello\n', 'Hello'], ['Hi \ue321', 'Hello \ue321', 'Hello'],
    ['Hi &amp;', 'Hello &amp;', 'Hello &'], ["Show '{'", "Display '{'", 'Display'],
    ['Hi', 'Hello \ue321', 'Hello'], ['Hi {n}', 'Broken {n \ue321', 'Hello {n}'],
    ['Hi %%', 'Hello %%', 'Hello'], ["Apostrophe ''", "Literal ''", 'Literal'],
    ['Gear ⚙️', 'Icon ⚙️', 'Icon ⚙'], ['Cost $', 'Price $', 'Price'], ['Wave 👋🏽', 'Hello 👋🏽', 'Hello 👋']
  ]) assert.throws(() => exported(source, original, approved));
});

test('newlines, printf, tags and private glyph survive valid approval exactly', () => {
  const source = '<b>%s</b>\nОк \ue321', original = '<b>%s</b>\nHi \ue321', approved = '<b>%s</b>\nСәлем \ue321';
  assert.equal(readArb(exported(source, original, approved).text).groups.get('greeting')[0].value, approved);
});

test('identical duplicates are removed with full occurrence audit and unchanged original effective value', () => {
  const sourceText = '{"@@locale":"ru","greeting":"Hello","greeting":"Hello"}';
  const targetText = '{"@@locale":"kk","@@comment":"first","greeting":"Hi","@@comment":"second","greeting":"Hi"}';
  const result = exportApproved({ sourceText, targetText, reviews: emptyReviews() });
  const parsed = readArb(result.text);
  assert.equal(parsed.groups.get('greeting').length, 1);
  assert.equal(parsed.groups.get('greeting')[0].value, 'Hi');
  assert.equal(parsed.properties.filter(p => p.key === '@@comment').length, 2);
  assert.equal(result.audit.duplicate_audit.source[0].occurrences.length, 2);
  assert.deepEqual(result.audit.duplicate_audit.target[0].occurrences.map(p => p.section), ['first', 'second']);
  assert.equal(result.audit.original_sha256, hashText(targetText));
  assert.equal(result.audit.changed_count, 0);
});

function duplicateFixture(occurrence = 2) {
  const sourceText = arb('ru', { greeting: 'Hello' }), targetText = '{"@@locale":"kk","greeting":"First","greeting":"Last"}';
  const resolutions = { schema_version: '1.0', source_sha256: hashText(sourceText), original_target_sha256: hashText(targetText), decisions: [{
    key: 'greeting', occurrence, chosen_hash: hashText(occurrence === 1 ? 'First' : 'Last'), reviewer: 'TEST_DOUBLE_NOT_A_HUMAN_REVIEW', reviewed_at: '2026-10-30T00:00:00Z', reviewed_by_human: true
  }] };
  return { sourceText, targetText, reviews: emptyReviews(), resolutions };
}

test('conflicting duplicates require complete version-bound explicit resolutions', () => {
  const input = duplicateFixture();
  assert.throws(() => exportApproved({ ...input, resolutions: undefined }), /duplicate_key/);
  assert.throws(() => exportApproved({ ...input, resolutions: { ...input.resolutions, decisions: [] } }), /duplicate_key/);
  assert.throws(() => exportApproved({ ...input, targetText: input.targetText + '\n' }), /different source/);
  assert.throws(() => exportApproved({ ...input, resolutions: { ...input.resolutions, decisions: [{ ...input.resolutions.decisions[0], chosen_hash: hashText('Wrong') }] } }), /hash mismatch/);
  const result = exportApproved(input);
  assert.equal(readArb(result.text).groups.get('greeting')[0].value, 'Last');
  assert.equal(result.audit.release.resolved_duplicate_count, 1);
  assert.equal(result.audit.changed_count, 0);
  assert.equal(readArb(result.text).metadata.has('@greeting'), false);
});

test('earlier duplicate choice requires separate review bound to last original occurrence', () => {
  const input = duplicateFixture(1);
  assert.throws(() => exportApproved(input), /requires current translation approval/);
  input.reviews.decisions.push(decision('Hello', 'Last', 'First', 'greeting', 2));
  const result = exportApproved(input);
  assert.equal(readArb(result.text).groups.get('greeting')[0].value, 'First');
  assert.equal(result.audit.duplicate_audit.target[0].selected_occurrence, 1);
  assert.deepEqual(result.audit.applied_entry_ids, ['greeting#2']);
  const wrong = { ...input, reviews: { ...emptyReviews(), decisions: [decision('Hello', 'First', 'First', 'greeting', 1)] } };
  assert.throws(() => exportApproved(wrong), /identity|Stale/);
});

test('source conflicts and unresolved additional target conflicts still block export', () => {
  const input = duplicateFixture();
  assert.throws(() => exportApproved({ ...input, sourceText: '{"@@locale":"ru","greeting":"Early","greeting":"Hello"}', resolutions: undefined }), /source.*duplicate_key/);
  const targetText = input.targetText.slice(0, -1) + ',"extra":"One","extra":"Two"}';
  const resolutions = { ...input.resolutions, original_target_sha256: hashText(targetText) };
  assert.throws(() => exportApproved({ ...input, targetText, resolutions }), /extra.*duplicate_key/);
});

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
function run(args) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true }); }
async function cliInputs() {
  const dir = await mkdtemp(join(tmpdir(), 'locqa-core-test-'));
  await writeFile(join(dir, 'source.arb'), arb('ru', { greeting: 'Hello' }));
  await writeFile(join(dir, 'target.arb'), arb('kk', { greeting: 'Сәлем' }));
  await writeFile(join(dir, 'glossary.csv'), 'ru,kk\n');
  const args = ['--source', join(dir, 'source.arb'), '--target', join(dir, 'target.arb'), '--glossary', join(dir, 'glossary.csv')];
  return { dir, args };
}

test('CLI runs on a new ARB, persists schema outputs, and never overwrites a run', async () => {
  const { dir, args } = await cliInputs(), out = join(dir, 'result');
  assert.equal(run(['check', ...args, '--out', out]).status, 0);
  assertContract('bundle', JSON.parse(await readFile(join(out, 'bundle.json'), 'utf8')));
  assert.equal(JSON.parse(await readFile(join(out, 'baseline-plan.json'), 'utf8')).status, 'no_structural_decisions');
  const before = await readFile(join(out, 'bundle.json'), 'utf8');
  assert.equal(run(['check', ...args, '--out', out]).status, 2);
  assert.equal(await readFile(join(out, 'bundle.json'), 'utf8'), before);
  assert.equal(run(['check', ...args, '--out', join(dir, 'source.arb')]).status, 2);
  assert.equal(await readFile(join(dir, 'source.arb'), 'utf8'), arb('ru', { greeting: 'Hello' }));
});

test('CLI distinguishes findings, structure failure and unsafe public output paths', async () => {
  const { dir, args } = await cliInputs();
  await writeFile(join(dir, 'target.arb'), arb('kk', {}));
  assert.equal(run(['check', ...args, '--out', join(dir, 'missing')]).status, 1);
  await writeFile(join(dir, 'target.arb'), '{broken');
  assert.equal(run(['check', ...args, '--out', join(dir, 'broken')]).status, 2);
  assert.match(await readFile(join(dir, 'broken', 'failure.json'), 'utf8'), /invalid ARB/);
  assert.equal(run(['check', ...args, '--out', fileURLToPath(new URL('../public-results', import.meta.url))]).status, 2);
});

test('CLI rejects invalid UTF-8 instead of replacing bytes silently', async () => {
  const { dir, args } = await cliInputs();
  await writeFile(join(dir, 'target.arb'), Buffer.from([0xff, 0xfe]));
  assert.equal(run(['check', ...args, '--out', join(dir, 'invalid-utf8')]).status, 2);
});

test('CLI does not follow an output alias into tracked module directories', async t => {
  const { dir, args } = await cliInputs();
  const alias = join(dir, 'linked-core');
  try { await symlink(fileURLToPath(new URL('../', import.meta.url)), alias, 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Environment denies creating links'); return; } throw error; }
  const result = run(['check', ...args, '--out', join(alias, 'must-not-exist')]);
  assert.equal(result.status, 2);
});

test('CLI export writes a new ARB with an empty ledger and preserves source files', async () => {
  const { dir } = await cliInputs();
  const ledger = join(dir, 'reviews.json'); await writeFile(ledger, JSON.stringify(emptyReviews()));
  const result = run(['export', '--source', join(dir, 'source.arb'), '--target', join(dir, 'target.arb'), '--reviews', ledger, '--out', join(dir, 'fixed')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(dir, 'fixed', 'intl_kk_fixed.arb'), 'utf8'), await readFile(join(dir, 'target.arb'), 'utf8'));
});

test('Flutter evidence must bind exact bytes, all commands and successful exits', () => {
  const source = 'source', fixed = 'fixed';
  const valid = { status: 'passed', source_sha256: hashText(source), target_sha256: hashText(fixed),
    commands: ['flutter --version', 'flutter pub get', 'flutter gen-l10n'].map(command => ({ command, exit_code: 0 })) };
  assert.doesNotThrow(() => assertFlutterEvidence(valid, source, fixed));
  for (const bad of [null, {}, { ...valid, status: 'failed' }, { ...valid, source_sha256: hashText('changed') },
    { ...valid, target_sha256: hashText('changed') }, { ...valid, commands: valid.commands.slice(0, 2) },
    { ...valid, commands: [null, ...valid.commands.slice(1)] },
    { ...valid, commands: valid.commands.map(c => ({ ...c, exit_code: 1 })) }]) {
    assert.throws(() => assertFlutterEvidence(bad, source, fixed), /does not prove/);
  }
});

test('command-specific help works without requiring file arguments', () => {
  for (const name of ['check', 'export']) {
    const result = run([name, '--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--verify-flutter/);
  }
});

test('bundle detector matches raw detection and refuses inconsistent source bindings', async () => {
  const input = { sourceText: await fixture('source.arb'), targetText: await fixture('target.arb') };
  const glossaryText = await fixture('glossary.csv'), bundle = normalizeArbs(input).bundle;
  assert.deepEqual(checkBundle(bundle, { glossaryText }).report, checkArbs({ ...input, glossaryText }).report);
  const entry = bundle.entries.find(e => e.target !== null);
  const mutated = { ...entry, occurrence: 2, entry_id: entry.key + '#2', source: 'Different', source_hash: hashText('Different') };
  assert.throws(() => checkBundle({ ...bundle, entries: [...bundle.entries, mutated] }), /Conflicting source/);
});

test('real normalize/core adapters run in the integrator pipeline on newly added synthetic messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'locqa-pipeline-test-'));
  const source = JSON.parse(await fixture('source.arb')); source.newPipelineMessage = 'Fresh invented message';
  const target = await fixture('target.arb');
  await writeFile(join(dir, 'source.arb'), JSON.stringify(source));
  await writeFile(join(dir, 'target.arb'), target);
  await writeFile(join(dir, 'glossary.csv'), await fixture('glossary.csv'));
  const config = JSON.parse(await readFile(new URL('../../../contracts/examples/pipeline.json', import.meta.url), 'utf8'));
  config.mode = 'synthetic'; config.working_directory = fileURLToPath(new URL('../../../', import.meta.url));
  // Only the unavailable language/render stages use explicitly labelled fixtures.
  const synthetic = JSON.parse(await fixture('adapters/pipeline.json'));
  config.stages.language = synthetic.stages.language; config.stages.render = synthetic.stages.render;
  await writeFile(join(dir, 'pipeline.json'), JSON.stringify(config));
  const result = await runPipeline({ configPath: join(dir, 'pipeline.json'), source: join(dir, 'source.arb'), target: join(dir, 'target.arb'), glossary: join(dir, 'glossary.csv'), out: join(dir, 'run'), synthetic: true });
  assert.equal(result.evidence.status, 'analysis_passed');
  const report = JSON.parse(await readFile(join(dir, 'run', 'core-report.json'), 'utf8'));
  assert.ok(report.some(f => f.key === 'newPipelineMessage' && f.issue_type === 'untranslated'));
  assert.equal(report.length, 6);
});

test('file export adapter accepts agreed resolutions and never replaces existing outputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'locqa-stage-test-')), input = duplicateFixture();
  for (const [name, text] of [['source.arb', input.sourceText], ['target.arb', input.targetText], ['reviews.json', JSON.stringify(input.reviews)], ['resolutions.json', JSON.stringify(input.resolutions)]]) await writeFile(join(dir, name), text);
  const argv = ['--source', join(dir, 'source.arb'), '--target', join(dir, 'target.arb'), '--reviews', join(dir, 'reviews.json'), '--resolutions', join(dir, 'resolutions.json'), '--out', join(dir, 'fixed.arb')];
  const runExport = () => spawnSync(process.execPath, [fileURLToPath(new URL('../export.mjs', import.meta.url)), ...argv], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const result = runExport(); assert.equal(result.status, 0, result.stderr);
  const text = await readFile(join(dir, 'fixed.arb'), 'utf8');
  assert.equal(readArb(text).groups.get('greeting').length, 1);
  assert.equal(runExport().status, 2);
  assert.equal(await readFile(join(dir, 'fixed.arb'), 'utf8'), text);
  assert.equal(await readFile(join(dir, 'target.arb'), 'utf8'), input.targetText);
});
