import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hashText, assertContract } from '../../src/contracts.mjs';
import { readGlossary, pendingTermDecisions, csvTable, prepareQueue, inspectProposal, auditReviews } from './workflow.mjs';
import { annotateQueue, renderReviewPacket, renderTermPacket } from './review-packet.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const example = JSON.parse(await readFile(new URL('../../contracts/examples/bundle.json', import.meta.url), 'utf8'));
const sample = JSON.parse(await readFile(new URL('../../fixtures/synthetic/report.sample.json', import.meta.url), 'utf8'));
const report = sample.filter(f => example.entries.some(e => e.key === f.key));

function annotationDocument() {
  const entry = example.entries[2];
  return { workflow_version: '1.0', target_locale: 'kk', annotations: [{
    entry_id: entry.entry_id, source_hash: entry.source_hash, original_hash: entry.target_hash,
    proposed_text: 'Сәлемдеме алушы: {recipient}', author: 'AI draft',
    rationale: 'Name the recipient explicitly', questions: ['Is this a recipient label?'],
  }] };
}

// Invented in-memory test attestations only; no real reviewer or review file is created.
function syntheticReview(entry, text) {
  return { schema_version: '1.0', target_locale: 'kk', decisions: [{
    key: entry.key, entry_id: entry.entry_id, decision: 'edited', original_text: entry.target,
    approved_text: text, source_hash: entry.source_hash, original_hash: entry.target_hash,
    approved_hash: hashText(text), reviewer: 'SYNTHETIC TEST ONLY',
    reviewed_at: '2026-10-30T10:00:00+05:00', reviewed_by_human: true,
  }] };
}

test('40 glossary drafts with no human claims, exact version hash and strict four-column schema', async () => {
  const text = await readFile(new URL('./glossary.csv', import.meta.url), 'utf8');
  const terms = readGlossary(text), log = pendingTermDecisions(text);
  assert.equal(terms.length, 40);
  assert.ok(terms.every(t => t.comment.startsWith('Черновик.')));
  assert.ok(log.every(t => t.status === 'pending' && t.reviewer === null
    && t.reviewed_at === null && t.reviewed_by_human === false && t.glossary_hash === hashText(text)));
  assert.equal(readGlossary('ru,kk,en,comment\r\na,b,c,"x,""y""\nz"\r\n')[0].comment, 'x,"y"\nz');
  for (const invalid of ['ru,kk,en,note\na,b,c,d', 'ru,kk,en,comment\na,b,c,"d',
    'ru,kk,en,comment\na,b,c,"d"x', 'ru,kk,en,comment\na,b,c,d\na,b,c,d']) {
    assert.throws(() => readGlossary(invalid));
  }
});

test('shared examples create only pending rows and a valid empty reviews document', () => {
  const queue = prepareQueue(example, report);
  assert.equal(queue.rows.length, 3);
  assertContract('reviews', queue.reviews);
  assert.deepEqual(queue.reviews.decisions, []);
  assert.ok(queue.rows.every(r => r.reviewed_by_human === false && r.reviewer === null && r.decision === null));
  assert.equal(queue.rows.find(r => r.entry_id.endsWith('#0')).original_text, null);
  assert.deepEqual(queue.rows[0].context, example.entries.find(e => e.entry_id === queue.rows[0].entry_id).context);
  assert.equal(auditReviews(example, queue.reviews).status, 'empty');
});

test('batches keep every record exactly once and never pad the final batch', () => {
  const bundle = structuredClone(example); bundle.entries = [];
  const findings = [];
  for (let i = 0; i < 51; i++) {
    const key = 'synthetic' + i;
    bundle.entries.push({ ...example.entries[0], key, entry_id: key + '#0' });
    findings.push({ ...report[0], key });
  }
  const queue = prepareQueue(bundle, findings);
  assert.deepEqual(queue.batches.map(b => b.rows.length), [25, 25, 1]);
  assert.equal(new Set(queue.batches.flatMap(b => b.rows.map(r => r.entry_id))).size, 51);
  assert.deepEqual(prepareQueue(bundle, findings.slice().reverse()), queue);
  for (const batchSize of [0, 19, 31, 20.5, NaN]) assert.throws(() => prepareQueue(bundle, findings, { batchSize }));
});

test('all candidate variants survive; exact duplicate findings coalesce; conflicts block', () => {
  const second = { ...report[0], issue_type: 'wrong_language', suggestion: 'Басқа ұсыныс' };
  const rows = prepareQueue(example, [report[0], second, { ...report[0] }]).rows;
  assert.equal(rows[0].findings.length, 2);
  assert.equal(rows[0].proposals.length, 2);
  assert.throws(() => prepareQueue(example, [report[0], { ...report[0], suggestion: 'Қайшылық' }]), /Conflicting/);
});

test('stale source/target, unknown keys, wrong locale and ambiguous occurrences block preparation', () => {
  for (const patch of [{ source: 'changed' }, { target: 'changed' }, { key: 'unknown' }]) {
    assert.throws(() => prepareQueue(example, [{ ...report[0], ...patch }]));
  }
  const duplicate = structuredClone(example), original = duplicate.entries[1];
  duplicate.entries.push({ ...original, occurrence: 2, entry_id: original.key + '#2' });
  assert.throws(() => prepareQueue(duplicate, report), /ambiguous duplicate/);
  assert.throws(() => prepareQueue({ ...example, target_locale: 'uz' }, report), /locale kk/);
});

test('technical checks preserve tokens, styles, ICU requirements and private-use glyphs', () => {
  const failures = [
    ['Для {name}', 'Алушы: {other}'], ['%s: %d', '%d: %s'], ['<b>Текст</b>', 'Мәтін'],
    ['{n, plural, =0{Нет} other{Есть}}', '{n, plural, other{Бар}}'],
    ['{n, plural, offset:1 other{Есть}}', '{n, plural, other{Бар}}'],
    ['{kind, select, a{Да} other{Нет}}', '{kind, select, other{Жоқ}}'],
    ['{price, number, currency/USD}', '{price}'], ['Иконка \uE001', 'Белгі'],
    ['{n, plural, other{Есть}}', '{n, plural, one{Бар}}'],
  ];
  for (const [source, text] of failures) assert.equal(inspectProposal(source, text).status, 'failed');
  assert.equal(inspectProposal('{n, plural, one{Один} few{Мало} many{Много} other{Есть}}',
    '{n, plural, other{Бар}}').status, 'technical_checks_passed');
  assert.equal(inspectProposal('Привет\n{name}', 'Сәлем {name}').warnings.length, 1);
  assert.equal(inspectProposal('Для {name}', 'Алушы: {name}').meaning_verified, false);
});

test('audit checks exact source/original/approved versions, identity, locale and missing versus empty', () => {
  const entry = example.entries[0], good = syntheticReview(entry, report[0].suggestion);
  assert.equal(auditReviews(example, good).status, 'consistent');
  for (const patch of [{ source_hash: hashText('changed') },
    { original_text: '', original_hash: hashText('') }, { entry_id: 'other#0' }, { key: 'other' }]) {
    const changed = structuredClone(good); Object.assign(changed.decisions[0], patch);
    assert.equal(auditReviews(example, changed).status, 'failed');
  }
  const changed = structuredClone(good); changed.decisions[0].approved_text += ' ';
  assert.throws(() => auditReviews(example, changed), /hash/);
  assert.throws(() => auditReviews(example, { ...good, target_locale: 'kk-KZ' }), /locale differs/);
  assert.throws(() => auditReviews(example, { ...good, decisions: [...good.decisions, ...good.decisions] }), /Multiple decisions/);
  assert.throws(() => auditReviews(example, { ...good, decisions: [{ ...good.decisions[0], reviewed_by_human: false }] }));
  const rejected = structuredClone(good);
  Object.assign(rejected.decisions[0], { decision: 'rejected', approved_text: null, approved_hash: null });
  assert.equal(auditReviews(example, rejected).status, 'consistent');
  assert.equal(auditReviews(example, syntheticReview(example.entries[2], 'Жоқ')).status, 'failed');
});

test('display CSV escapes formulas and quotes without changing the JSON source', () => {
  assert.equal(csvTable([['=2+2', '@SUM(A1)', '"quoted"', 'екі\nжол']]),
    '"\'=2+2","\'@SUM(A1)","""quoted""","екі\nжол"\r\n');
});

test('CLI writes only new ignored runs, keeps inputs intact and produces empty approvals', async () => {
  const parent = resolve(root, 'private'); await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(resolve(parent, 'linguistics-test-'));
  try {
    const bundlePath = resolve(temp, 'bundle.json'), reportPath = resolve(temp, 'report.json');
    await writeFile(bundlePath, JSON.stringify(example)); await writeFile(reportPath, JSON.stringify(report));
    const inputBefore = await readFile(bundlePath, 'utf8');
    const cli = (...args) => spawnSync(process.execPath, ['modules/linguistics/cli.mjs', ...args], { cwd: root, encoding: 'utf8' });
    const args = ['prepare', '--bundle', bundlePath, '--report', reportPath, '--out', resolve(temp, 'run')];
    const result = cli(...args); assert.equal(result.status, 0, result.stderr);
    assert.equal(cli(...args).status, 1);
    assert.equal(await readFile(bundlePath, 'utf8'), inputBefore);
    const reviews = resolve(temp, 'run', 'reviews.json');
    assert.deepEqual(JSON.parse(await readFile(reviews, 'utf8')).decisions, []);
    assert.equal(cli('audit', '--bundle', bundlePath, '--reviews', reviews, '--out', resolve(temp, 'audit')).status, 0);
    assert.equal(JSON.parse(await readFile(resolve(temp, 'audit', 'review-audit.json'), 'utf8')).status, 'empty');
    const noteFile = resolve(temp, 'notes.json'); await writeFile(noteFile, JSON.stringify(annotationDocument()));
    const annotated = cli('prepare', '--bundle', bundlePath, '--report', reportPath,
      '--annotations', noteFile, '--out', resolve(temp, 'annotated'));
    assert.equal(annotated.status, 0, annotated.stderr);
    const manifest = JSON.parse(await readFile(resolve(temp, 'annotated', 'manifest.json'), 'utf8'));
    assert.equal(manifest.annotation_count, 1);
    assert.equal(manifest.annotations_hash, hashText(JSON.stringify(annotationDocument())));
    assert.match(await readFile(resolve(temp, 'annotated', 'batch-001.md'), 'utf8'), /Сәлемдеме алушы/);
    assert.match(await readFile(resolve(temp, 'annotated', 'term-review.md'), 'utf8'), /Термин 40/);
    assert.deepEqual(JSON.parse(await readFile(resolve(temp, 'annotated', 'reviews.json'), 'utf8')).decisions, []);
    await writeFile(noteFile, 'null');
    assert.equal(cli('prepare', '--bundle', bundlePath, '--report', reportPath,
      '--annotations', noteFile, '--out', resolve(temp, 'null-notes')).status, 1);
    assert.equal(cli('audit', '--bundle', bundlePath, '--reviews', reviews,
      '--annotations', noteFile, '--out', resolve(temp, 'ignored-notes')).status, 1);
    assert.equal(cli('prepare', '--bundle', bundlePath, '--report', reportPath,
      '--out', 'modules/linguistics/should-not-exist').status, 1);
    assert.equal(cli('prepare', '--bundle', bundlePath, '--report', reportPath,
      '--out', resolve(temp, 'invalid'), '--batch-size', '25.5').status, 1);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('editorial variants preserve model proposals and never create human decisions', () => {
  const queue = prepareQueue(example, report), before = structuredClone(queue);
  const edited = annotateQueue(queue, annotationDocument());
  assert.deepEqual(queue, before);
  const row = edited.rows.find(r => r.key === 'demoParcelNotice');
  assert.equal(row.proposals.length, 2);
  assert.equal(row.proposals[0].text, 'Сәлемдеме: {recipient}');
  assert.equal(row.editorial_note.proposed_hash, hashText('Сәлемдеме алушы: {recipient}'));
  assert.equal(row.editorial_note.technical.status, 'technical_checks_passed');
  assert.equal(row.editorial_note.reviewed_by_human, false);
  assert.equal(row.reviewer, null); assert.equal(row.final_text, null); assert.equal(row.decision, null);
  assert.deepEqual(edited.reviews.decisions, []);
  assert.deepEqual(edited.batches[0].rows.find(r => r.entry_id === row.entry_id), row);
  assert.match(renderReviewPacket(edited.batches[0]), /Сәлемдеме алушы/);
});

test('stale notes, duplicates, unknown identities and injected approval fields are refused', () => {
  const queue = prepareQueue(example, report);
  for (const patch of [{ source_hash: hashText('new') }, { original_hash: null },
    { entry_id: 'unknown#1' }, { reviewed_by_human: true }, { reviewer: 'invented' },
    { rationale: '' }, { questions: [3] }, { proposed_text: '' }]) {
    const notes = annotationDocument(); Object.assign(notes.annotations[0], patch);
    assert.throws(() => annotateQueue(queue, notes));
  }
  const duplicate = annotationDocument(); duplicate.annotations.push({ ...duplicate.annotations[0] });
  assert.throws(() => annotateQueue(queue, duplicate), /Duplicate/);
  assert.throws(() => annotateQueue(queue, { ...annotationDocument(), target_locale: 'uz' }));
  assert.throws(() => annotateQueue(queue, { ...annotationDocument(), approved: true }));
});

test('question-only and technically failed notes remain visible without forcing an edit', () => {
  const queue = prepareQueue(example, report), notes = annotationDocument();
  notes.annotations[0].proposed_text = null;
  const question = annotateQueue(queue, notes).rows.find(r => r.key === 'demoParcelNotice');
  assert.equal(question.proposals.length, 1);
  assert.equal(question.editorial_note.proposed_hash, null);
  notes.annotations[0].proposed_text = 'Сәлемдеме алушы: {wrong}';
  const failed = annotateQueue(queue, notes).rows.find(r => r.key === 'demoParcelNotice');
  assert.equal(failed.editorial_note.technical.status, 'failed');
  assert.equal(failed.editorial_note.status, 'pending_human_review');
  assert.equal(failed.reviewed_by_human, false);
});

test('reading packets preserve escaped text, use safe fences and leave agreement fields empty', async () => {
  const queue = prepareQueue(example, report), notes = annotationDocument();
  notes.annotations[0].rationale = 'Literal `````\n# not a heading <script> & "quoted"';
  const edited = annotateQueue(queue, notes), packet = renderReviewPacket(edited.batches[0]);
  assert.ok(packet.includes(JSON.stringify(notes.annotations[0].rationale)));
  assert.match(packet, /``````json/);
  assert.match(packet, /Проверивший, время и комментарий: ____________________/);
  assert.match(packet, /null/);
  const glossary = await readFile(new URL('./glossary.csv', import.meta.url), 'utf8');
  const terms = renderTermPacket(pendingTermDecisions(glossary));
  assert.equal((terms.match(/## Термин /g) ?? []).length, 40);
  assert.ok(terms.includes(hashText(glossary)));
});
