#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sampleForReview } from '../src/evaluation.mjs';

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
    report: { type: 'string' }, out: { type: 'string' },
    size: { type: 'string', default: '100' }, seed: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/sample-review.mjs --report report.json --out sample.json --seed fixed-seed [--size 100]\nCreates a reproducible sample without replacement. Human answers start as null.\nConflicting duplicate key + issue_type findings must be resolved before sampling.');
    return;
  }
  if (!values.report || !values.out || !values.seed) throw new Error('--report, --out and --seed are required');
  if (!/^\d+$/.test(values.size)) throw new Error('--size must be a non-negative integer');
  if (await aliasesInput(values.report, values.out)) throw new Error('--out must not overwrite the report');
  let report;
  try { report = JSON.parse(await readFile(values.report, 'utf8')); }
  catch (error) { throw new Error('Cannot read report JSON: ' + error.message); }
  const sample = sampleForReview(report, { size: Number(values.size), seed: values.seed });
  await mkdir(dirname(resolve(values.out)), { recursive: true });
  await writeFile(values.out, JSON.stringify(sample, null, 2) + '\n', 'utf8');
  console.error('Review sample written to ' + values.out + ': ' + sample.sample_size + '/' + sample.population_size + ' unique findings');
}
main().catch((error) => { console.error('Sampling failed: ' + error.message); process.exitCode = 1; });
