// Team fixture normalizer/core/renderer + actual Bekzat detector. No export or approvals.
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runPipeline } from '../../src/pipeline.mjs';
import { assertContract } from '../../src/contracts.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function privateNewDirectory(path) {
  const out = resolve(path);
  if (existsSync(out)) throw new Error('Smoke output must be new');
  let ancestor = dirname(out);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  ancestor = realpathSync(ancestor);
  for (;;) {
    if (existsSync(join(ancestor, '.git'))) throw new Error('Smoke output must be outside Git');
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return out;
}

export async function runSmoke(outPath, { coreRoot } = {}) {
  const out = privateNewDirectory(outPath);
  const fixtureDir = join(repo, 'fixtures/synthetic');
  const config = JSON.parse(await readFile(join(fixtureDir, 'adapters/pipeline.json'), 'utf8'));
  config.working_directory = repo;
  config.timeout_ms = 120000;
  for (const stage of Object.values(config.stages)) stage.executable = process.execPath;
  config.stages.language = { executable: process.execPath,
    argv: ['modules/language/check.mjs', '--bundle', '{bundle}', '--glossary', '{glossary}',
      '--out', '{language_report}'] };
  if (coreRoot) {
    const normalize = resolve(coreRoot, 'modules/core/normalize.mjs');
    const check = resolve(coreRoot, 'modules/core/check.mjs');
    if (!existsSync(normalize) || !existsSync(check)) throw new Error('Requested core adapters unavailable');
    config.stages.normalize = { executable: process.execPath, argv: [normalize,
      '--source', '{source}', '--target', '{target}', '--out', '{bundle}'] };
    config.stages.core = { executable: process.execPath, argv: [check,
      '--bundle', '{bundle}', '--glossary', '{glossary}', '--out', '{core_report}'] };
  }
  await mkdir(out, { recursive: true });
  const configPath = join(out, 'pipeline.json');
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  const result = await runPipeline({ configPath, source: join(fixtureDir, 'source.arb'),
    target: join(fixtureDir, 'target.arb'), glossary: join(fixtureDir, 'glossary.csv'),
    out: join(out, 'run'), synthetic: true });
  const read = async name => JSON.parse(await readFile(join(result.directory, name), 'utf8'));
  const report = await read('language-report.json');
  const merged = await read('report.json');
  const metrics = await read('language-report.json.details/metrics.json');
  assertContract('report', report);
  assertContract('report', merged);
  assert.equal(result.evidence.status, 'analysis_passed');
  assert.equal(metrics.mode, 'local_only');
  assert.equal(metrics.provider_requests, 0);
  assert.ok(report.some(f => f.key === 'demoInviteName' && f.issue_type === 'suffix_harmony'));
  assert.ok(merged.every(f => f.reviewed_by_human === false));
  assert.equal(existsSync(join(result.directory, 'intl_fixed.arb')), false);
  const summary = { status: 'passed', language_stage: 'actual_local_detection',
    core_stage: coreRoot ? 'actual_core_detection' : 'existing_team_synthetic_fixture',
    renderer: 'existing team synthetic fixture; placeholder HTML is not production UI',
    engine_version: metrics.engine_version, language_findings: report.length, merged_findings: merged.length,
    schema_validated: true, human_approvals_created: 0, exported_arb: false,
    provider_requests: 0, provider_cost_usd: 0,
    limitation: 'Only selected core/language stages and shared contracts are exercised; no production UI or deployment uptime claim.' };
  await writeFile(join(out, 'smoke-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { out: { type: 'string' }, 'core-root': { type: 'string' } } });
    if (!values.out) throw new Error('Use --out NEW_PRIVATE_DIRECTORY');
    console.log(JSON.stringify(await runSmoke(values.out, { coreRoot: values['core-root'] })));
  } catch {
    console.error('Language integration smoke failed; inspect private pipeline evidence');
    process.exitCode = 1;
  }
}
