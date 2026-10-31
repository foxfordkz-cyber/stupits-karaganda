import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runSmoke } from '../smoke.mjs';

const moduleDir = dirname(fileURLToPath(new URL('../check.mjs', import.meta.url)));
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'bekzat-quality-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('real language detector works inside the shared synthetic pipeline', async t => {
  const out = join(directory(t), 'smoke');
  const result = await runSmoke(out);
  assert.equal(result.status, 'passed');
  assert.equal(result.language_stage, 'actual_local_detection');
  assert.equal(result.human_approvals_created, 0);
  assert.equal(result.exported_arb, false);
  await assert.rejects(runSmoke(out), /must be new/);
});

test('benchmark CLI scores unchanged development labels and reports their limited provenance', t => {
  const out = join(directory(t), 'evaluation');
  const python = process.env.LOCQA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, [join(moduleDir, 'benchmark/run.py'), '--out', out, '--sizes', ''],
    { cwd: moduleDir, encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(result.status, 0);
  const report = JSON.parse(readFileSync(join(out, 'evaluation.json'), 'utf8'));
  assert.equal(report.cases, 77);
  assert.equal(report.provenance.native_speaker_validated, false);
  assert.equal(report.quality.current.metrics.micro.fp, 0);
  assert.equal(report.quality.current.metrics.micro.fn, 0);
  assert.equal(report.quality.current.metrics.micro.tp, 42);
  assert.equal(report.quality.current.measurement.provider_requests, 0);
  assert.equal(report.quality.current.measurement.llm_cost_per_1000, null);
});

test('requested real core must exist; smoke never silently substitutes a fixture', async t => {
  const root = directory(t);
  await assert.rejects(runSmoke(join(root, 'smoke'), { coreRoot: join(root, 'missing-core') }), /core adapters unavailable/);
});
