#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { evaluate } from '../src/evaluation.mjs';

async function aliasesInput(input, output) {
  const normalize = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (normalize(input) === normalize(output)) return true;
  try {
    const [a, b] = await Promise.all([stat(input), stat(output)]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    gold: { type: 'string' }, report: { type: 'string' },
    out: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/evaluate.mjs --gold gold.json --report report.json [--out metrics.json]\nScores exact key + issue_type pairs on a completely labelled LOCAL set, one locale per run.\nUndefined ratios are null. This does not measure recall on hidden organizer errors.');
    return;
  }
  if (!values.gold || !values.report) throw new Error('--gold and --report are required');
  if (values.out && (await Promise.all([values.gold, values.report].map((input) => aliasesInput(input, values.out)))).some(Boolean)) throw new Error('--out must not overwrite an input file');
  const [gold, report] = await Promise.all([values.gold, values.report].map(async (path) => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { throw new Error('Cannot read JSON from ' + path + ': ' + error.message); }
  }));
  const json = JSON.stringify(evaluate(gold, report), null, 2) + '\n';
  if (values.out) {
    await mkdir(dirname(resolve(values.out)), { recursive: true });
    await writeFile(values.out, json, 'utf8');
    console.error('Local evaluation written to ' + values.out);
  } else process.stdout.write(json);
}
main().catch((error) => { console.error('Evaluation failed: ' + error.message); process.exitCode = 1; });
