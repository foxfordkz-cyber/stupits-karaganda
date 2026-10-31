import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { runSmoke } from './smoke.mjs';
import { runReviewGate } from './review-gate.mjs';
import { readJson, writeAtomicNew, privatePath } from './review-io.mjs';
import { verifyRealSafety } from './tests/real-review-safety.mjs';

export async function runReviewSmoke({ out, coreRoot, reportRoot, linguisticsRoot }) {
  if (![coreRoot, reportRoot, linguisticsRoot].every(Boolean)) throw new Error('All three real component roots are required');
  const started = performance.now(), directory = privatePath(out);
  const pipeline = await runSmoke(directory, { coreRoot, reportRoot });
  const run = join(directory, 'run'), reviews = join(directory, 'empty-human-reviews.json');
  writeAtomicNew(reviews, { schema_version: '1.0', target_locale: 'kk', decisions: [] });
  const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/synthetic');
  const gate = await runReviewGate({ bundle: join(run, 'bundle.json'), report: join(run, 'language-report.json'),
    details: join(run, 'language-report.json.details'), reviews, source: join(fixtures, 'source.arb'), target: join(fixtures, 'target.arb'),
    state: join(directory, 'gate-state'), out: join(directory, 'gate.json'), coreRoot, linguisticsRoot });
  assert.equal(gate.status, 'HUMAN_REVIEW_PENDING');
  const artifact = readJson(join(directory, 'gate.json'));
  assert.equal(artifact.gate.linguistics_audit.status, 'empty');
  assert.equal(artifact.receipt, null);
  const core = await import(pathToFileURL(resolve(coreRoot, 'modules/core/index.mjs')));
  const linguistics = await import(pathToFileURL(resolve(linguisticsRoot, 'modules/linguistics/workflow.mjs')));
  const safety = verifyRealSafety(core, linguistics);
  const summary = { status: 'passed', pipeline, gate, safety,
    elapsed_seconds: (performance.now() - started) / 1000, provider_requests: 0, provider_cost_usd: 0,
    human_review_status: 'HUMAN_REVIEW_PENDING', final_arb_written: false, flutter_verified: false,
    boundaries: ['Real core/language/shared merge/Tony renderer/Aidana audit on synthetic fixtures.',
      'Positive handoff and unsafe edit checks use explicitly named in-memory decision test doubles, not human evaluation.',
      'No browser interaction or deployment/uptime test. Queue v2 UI wiring remains Tony-owned.'] };
  writeAtomicNew(join(directory, 'review-smoke-summary.json'), summary);
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values: v } = parseArgs({ options: Object.fromEntries(['out','core-root','report-root','linguistics-root'].map(k => [k, { type: 'string' }])) });
    if (!v.out) throw Error('Missing out');
    console.log(JSON.stringify(await runReviewSmoke({ out: v.out, coreRoot: v['core-root'], reportRoot: v['report-root'], linguisticsRoot: v['linguistics-root'] })));
  } catch (e) { console.error('Synthetic real-component review smoke failed: ' + e.message); process.exitCode = 1; }
}
