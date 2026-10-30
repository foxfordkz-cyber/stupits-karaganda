import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectArb, technicalSignature } from '../src/arb-audit.mjs';

const requiredBy = (source, target) => {
  const expected = technicalSignature(source).icuRequirements;
  const actual = new Set(technicalSignature(target).icuRequirements);
  return expected.every(requirement => actual.has(requirement));
};

test('cannot replace a plural expression with a bare placeholder', () => {
  const source = '{count, plural, one{One} other{Many}}';
  assert.deepEqual(technicalSignature(source).placeholders, ['count']);
  assert.deepEqual(technicalSignature('{count}').placeholders, ['count']);
  assert.equal(requiredBy(source, '{count}'), false);
});

test('plural categories may differ by locale while other is required', () => {
  const source = '{count, plural, one{One} few{Few} many{Many} other{Other}}';
  const target = '{count, plural, one{One} other{Other}}';
  assert.equal(requiredBy(source, target), true);
  assert.throws(() => technicalSignature('{count, plural, one{One}}'), /MISSING_OTHER_CLAUSE/);
});

test('explicit plural selectors and offsets cannot disappear', () => {
  const source = '{count, plural, offset:1 =0{None} one{One} other{Many}}';
  assert.equal(requiredBy(source, '{count, plural, offset:1 one{One} other{Many}}'), false);
  assert.equal(requiredBy(source, '{count, plural, =0{None} one{One} other{Many}}'), false);
  assert.equal(requiredBy(source, '{count, plural, offset:1 =0{None} =2{Two} other{Many}}'), true);
});

test('select preserves case labels and is distinct from plural', () => {
  const source = '{role, select, pilot{Pilot} guest{Guest} other{Other}}';
  assert.equal(requiredBy(source, '{role, select, pilot{Pilot} other{Other}}'), false);
  assert.equal(requiredBy(source, '{role, plural, one{One} other{Many}}'), false);
  assert.equal(requiredBy(source, '{role, select, pilot{Pilot} guest{Guest} admin{Admin} other{Other}}'), true);
});

test('ordinal and cardinal arguments remain distinct', () => {
  const source = '{rank, selectordinal, one{First} two{Second} other{Later}}';
  assert.equal(requiredBy(source, '{rank, plural, one{One} other{Many}}'), false);
  assert.equal(requiredBy(source, '{rank, selectordinal, other{Later}}'), true);
});

test('nested argument requirements are visited and deduplicated', () => {
  const source = '{role, select, pilot{{count, plural, =0{None} other{Many}}} other{{count, plural, =0{None} other{Many}}}}';
  const changed = '{role, select, pilot{{count}} other{{count}}}';
  const signature = technicalSignature(source);
  assert.deepEqual(signature.placeholders, ['count', 'role']);
  assert.equal(new Set(signature.icuRequirements).size, signature.icuRequirements.length);
  assert.equal(requiredBy(source, changed), false);
});

test('formatted number, date and time cannot become bare arguments or lose style', () => {
  for (const [kind, style] of [['number', 'integer'], ['date', 'short'], ['time', 'short']]) {
    const source = '{value, ' + kind + ', ' + style + '}';
    assert.equal(requiredBy(source, '{value}'), false, kind);
    assert.equal(requiredBy(source, '{value, ' + kind + '}'), false, kind + ' style');
    assert.equal(requiredBy(source, source), true, kind);
  }
  assert.equal(requiredBy('{amount, number, ::currency/USD}', '{amount, number}'), false);
});

test('printf escaping consumes no argument and unnumbered argument order is preserved', () => {
  assert.deepEqual(technicalSignature('%%s and %%d').printf, []);
  assert.deepEqual(technicalSignature('%%%s').printf, ['%s']);
  assert.deepEqual(technicalSignature('%s %d').printf, ['%s', '%d']);
  assert.deepEqual(technicalSignature('%d %s').printf, ['%d', '%s']);
  assert.notDeepEqual(technicalSignature('%s %d').printf, technicalSignature('%d %s').printf);
});

test('fully numbered printf tokens may reorder but mixed or implicit star arguments may not', () => {
  assert.deepEqual(technicalSignature('%2$d %1$s').printf, technicalSignature('%1$s %2$d').printf);
  assert.deepEqual(technicalSignature('%2$*1$s %3$d').printf, technicalSignature('%3$d %2$*1$s').printf);
  assert.deepEqual(technicalSignature('%3$.*2$f %1$s').printf, technicalSignature('%1$s %3$.*2$f').printf);
  assert.notDeepEqual(technicalSignature('%s %2$d').printf, technicalSignature('%2$d %s').printf);
  assert.notDeepEqual(technicalSignature('%2$*s %3$d').printf, technicalSignature('%3$d %2$*s').printf);
});

test('paired markup nesting is validated even when token multisets match', () => {
  assert.doesNotThrow(() => technicalSignature('<b><i>text</i></b>'));
  assert.throws(() => technicalSignature('<b><i>text</b></i>'), /Unbalanced markup/);
  assert.throws(() => technicalSignature('text</b>'), /Unbalanced markup/);
  assert.throws(() => technicalSignature('<g>first</g><g>second'), /Unclosed markup/);
});

test('literal standalone tokens, void tags and self-closing tags are permitted', () => {
  assert.deepEqual(technicalSignature('Hello <nick>, use <value>').tags, ['<nick>', '<value>']);
  assert.doesNotThrow(() => technicalSignature('<g>Hello <nick><br><img alt="a>b"><icon/></g>'));
  assert.throws(() => technicalSignature('<br></br>'), /Void markup/);
  assert.deepEqual(technicalSignature('<g>A</g><b>B</b>').tags,
    technicalSignature('<b>B</b><g>A</g>').tags);
});

test('escaped ICU braces and apostrophes do not invent placeholders', () => {
  assert.deepEqual(technicalSignature("Show '{' and '}' beside {label}; apostrophe ''").placeholders, ['label']);
});

test('ARB inspection retains resource duplicates and nested metadata diagnostics', () => {
  const arb = inspectArb('{"@@locale":"kk","@@comment":"a","x":"one","@@comment":"b","x":"two","@x":{"placeholders":{"n":{"type":"num","type":"String"}}}}');
  assert.equal(arb.entries.length, 2);
  assert.equal(arb.duplicates.length, 1);
  assert.equal(arb.duplicates[0].conflicting, true);
  assert.deepEqual(arb.entries.map(entry => entry.occurrence), [1, 2]);
  assert.deepEqual(arb.nestedDuplicates, ['/@x/placeholders/n/type']);
});
