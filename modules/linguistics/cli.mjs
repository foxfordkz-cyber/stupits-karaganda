#!/usr/bin/env node
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hashText } from '../../src/contracts.mjs';
import { prepareQueue, csvTable, pendingTermDecisions, auditReviews } from './workflow.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const help = `Linguistics workflow (no automatic approvals or ARB writes)
  prepare --bundle FILE --report FILE --out private/linguistics/run-001 [--batch-size 25]
  audit --bundle FILE --reviews FILE --out private/linguistics/audit-001
  hash --text-file FILE
Run from repository root. Every --out must be a NEW directory under private/,
outputs/ or submission/. Exact text/hash snapshots are JSON; queue.csv is display-only.`;

function inside(parent, path) {
  const rel = relative(parent, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function createOutput(path) {
  const output = resolve(path);
  const roots = ['private', 'outputs', 'submission'].map(name => resolve(root, name));
  if (!roots.some(base => inside(base, output))) throw new Error('--out must be inside private/, outputs/ or submission/');
  // Check the existing ancestor before mkdir, including junctions/symlinks.
  let ancestor = dirname(output);
  for (;;) {
    try {
      const actual = await realpath(ancestor), actualRoot = await realpath(root);
      if (!['private', 'outputs', 'submission'].some(name => {
        const base = resolve(actualRoot, name);
        return actual === base || inside(base, actual);
      }) && actual !== actualRoot) throw new Error('Output ancestor escapes private artifact directories');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Existing runs cannot be overwritten, even when empty.
  return output;
}

const read = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJSON = (directory, name, value) => writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

async function main() {
  const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
    bundle: { type: 'string' }, report: { type: 'string' }, reviews: { type: 'string' },
    out: { type: 'string' }, 'batch-size': { type: 'string', default: '25' },
    'text-file': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (args.help) { console.log(help); return; }
  if (positionals.length !== 1) throw new Error(help);
  const command = positionals[0];
  if (command === 'hash') {
    if (!args['text-file']) throw new Error('--text-file is required');
    console.log(hashText(await readFile(args['text-file'], 'utf8'))); return;
  }
  if (!['prepare', 'audit'].includes(command)) throw new Error(help);
  if (!args.bundle || !args.out) throw new Error('--bundle and --out are required');
  const bundle = await read(args.bundle);
  if (command === 'prepare') {
    if (!args.report) throw new Error('--report is required');
    if (!/^\d+$/.test(args['batch-size'])) throw new Error('--batch-size must be an integer from 20 to 30');
    const report = await read(args.report);
    const queue = prepareQueue(bundle, report, { batchSize: Number(args['batch-size']) });
    const glossaryText = await readFile(new URL('./glossary.csv', import.meta.url), 'utf8');
    const terms = pendingTermDecisions(glossaryText);
    const out = await createOutput(args.out);
    await writeJSON(out, 'bundle.snapshot.json', bundle);
    await writeJSON(out, 'report.snapshot.json', report);
    await writeJSON(out, 'reviews.json', queue.reviews);
    await writeFile(resolve(out, 'glossary.snapshot.csv'), glossaryText, { flag: 'wx' });
    await writeFile(resolve(out, 'term-decisions.jsonl'), terms.map(t => JSON.stringify(t)).join('\n') + '\n', { flag: 'wx' });
    for (const batch of queue.batches) await writeJSON(out, `batch-${batch.batch_id}.json`, batch);
    await writeFile(resolve(out, 'queue.csv'), csvTable([
      ['batch_id', 'entry_id', 'ru_source', 'kk_original', 'proposals_json', 'issues', 'status', 'reviewer', 'final_text', 'rationale'],
      ...queue.rows.map((row, i) => [String(Math.floor(i / Number(args['batch-size'])) + 1).padStart(3, '0'),
        row.entry_id, row.source, row.original_text, JSON.stringify(row.proposals.map(p => p.text)),
        row.findings.map(f => f.issue_type).join('; '), 'pending', '', '', '']),
    ]), { flag: 'wx' });
    await writeJSON(out, 'manifest.json', {
      workflow_version: '1.0', row_count: queue.rows.length, batch_count: queue.batches.length,
      glossary_count: terms.length, human_decision_count: 0,
      bundle_hash: hashText(JSON.stringify(bundle)), report_hash: hashText(JSON.stringify(report)),
      glossary_hash: hashText(glossaryText),
      hash_encoding: 'bundle/report: JSON.stringify(parsed JSON); glossary: exact UTF-8 text',
    });
    console.log(`Prepared ${queue.rows.length} rows in ${queue.batches.length} batches; ${terms.length} draft terms; 0 human decisions. ${out}`);
  } else {
    if (!args.reviews) throw new Error('--reviews is required');
    const reviews = await read(args.reviews), audit = auditReviews(bundle, reviews);
    const out = await createOutput(args.out);
    await writeJSON(out, 'review-audit.json', audit);
    await writeJSON(out, 'reviews.snapshot.json', reviews);
    await writeJSON(out, 'bundle.snapshot.json', bundle);
    console.log(`Audit: ${audit.status}; ${audit.decision_count} supplied decisions. ${out}`);
    if (audit.status === 'failed') process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
