import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { hashText } from '../../../src/contracts.mjs';
import { sampleForReview } from '../../../src/evaluation.mjs';
import { renderHtml } from '../render.mjs';
import { createModel, createWorkspace, makeDraft, restoreWorkspace } from '../model.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = JSON.parse(await readFile(new URL('../../../contracts/examples/bundle.json', import.meta.url), 'utf8'));
const report = JSON.parse(await readFile(new URL('../../../fixtures/synthetic/report.sample.json', import.meta.url), 'utf8')).slice(0, 3);

async function temporary(t) {
  // Keep generated artifacts within ignored work/, including failed test runs.
  const base = join(root, 'work');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'report-test-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const reportPath = join(directory, 'report.json');
  const bundlePath = join(directory, 'bundle.json');
  await writeFile(reportPath, JSON.stringify(report));
  await writeFile(bundlePath, JSON.stringify(bundle));
  return { directory, reportPath, bundlePath };
}

function cli(paths, output, extra = []) {
  return spawnSync(process.execPath, [
    'modules/report/render.mjs', '--bundle', paths.bundlePath,
    '--report', paths.reportPath, '--out', output, ...extra,
  ], { cwd: root, encoding: 'utf8', timeout: 15000 });
}

test('renderer produces standalone HTML without changing source data or review flags', async () => {
  const snapshot = JSON.stringify({ bundle, report });
  const html = await renderHtml(bundle, report, { synthetic: true });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html\b/i);
  assert.match(html, /<body\b/i);
  assert.match(html, /<style\b/i);
  assert.match(html, /<script\b/i);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\brel\s*=\s*["']?stylesheet/i);
  const runtimeScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/type=["']application\/json["']/i.test(match[0]));
  assert.ok(runtimeScripts.length > 0);
  for (const script of runtimeScripts) assert.doesNotThrow(() => new Script(script[1]));
  assert.equal(JSON.stringify({ bundle, report }), snapshot);
  assert.ok(report.every(finding => finding.reviewed_by_human === false));
});

test('standalone HTML snapshots carry draft decisions that restore against embedded exact inputs', async () => {
  const current = createModel(bundle, report);
  const drafts = [
    await makeDraft(current.cards[0], 'accepted', undefined, 'Keep missing-target context'),
    await makeDraft(current.cards[1], 'edited', 'Synthetic edited target', 'Preserve edit'),
    await makeDraft(current.cards[2], 'rejected', undefined, 'Preserve rejection'),
  ];
  const workspace = createWorkspace(current, drafts);
  const html = await renderHtml(bundle, report, { workspace, synthetic: true });
  const data = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  assert.ok(data);
  const payload = JSON.parse(data[1]);
  assert.deepEqual(payload.bundle, bundle);
  assert.deepEqual(payload.report, report);
  assert.equal(payload.synthetic, true);
  const restored = await restoreWorkspace(payload.workspace, createModel(payload.bundle, payload.report));
  assert.deepEqual(restored.drafts, drafts);
  assert.deepEqual(restored.staleDrafts, []);
  assert.deepEqual(restored.reviews.applicable, []);
});

test('embedded translation and evidence cannot break out of JSON or inject executable markup', async () => {
  const attack = '</script><img src=x onerror="globalThis.syntheticXss=true"><script>alert(1)</script>\u2028\u2029';
  const hostileBundle = structuredClone(bundle);
  const hostileReport = structuredClone(report);
  hostileBundle.entries[0].source = attack;
  hostileBundle.entries[0].source_hash = hashText(attack);
  hostileBundle.entries[0].context.description = attack;
  hostileReport[0].source = attack;
  hostileReport[0].evidence = attack;
  hostileReport[0].suggestion = attack;
  const html = await renderHtml(hostileBundle, hostileReport);
  assert.ok(!html.includes(attack), 'raw script-closing data must never appear in output');
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  // Data is kept recoverable, rather than stripped or normalized to avoid injection.
  const dataScripts = [...html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(dataScripts.length > 0, 'a self-contained data payload is present');
  const decoded = dataScripts.map(match => JSON.parse(match[1]));
  assert.ok(decoded.some(value => JSON.stringify(value).includes(JSON.stringify(attack).slice(1, -1))));
});

test('CLI supports the integration pipeline argv and generates its output directory', async t => {
  const paths = await temporary(t);
  const output = join(paths.directory, 'nested', 'report.html');
  const result = cli(paths, output);
  assert.equal(result.status, 0, result.stderr);
  const html = await readFile(output, 'utf8');
  assert.match(html, /<html\b/i);
  assert.match(html, /<body\b/i);
  assert.equal(await readFile(paths.reportPath, 'utf8'), JSON.stringify(report));
  assert.equal(await readFile(paths.bundlePath, 'utf8'), JSON.stringify(bundle));
});

test('CLI rejects invalid schema before creating an HTML report', async t => {
  const paths = await temporary(t);
  const invalid = structuredClone(report); invalid[0].issue_type = 'invented_type';
  await writeFile(paths.reportPath, JSON.stringify(invalid));
  const output = join(paths.directory, 'invalid.html');
  const result = cli(paths, output);
  assert.notEqual(result.status, 0);
  await assert.rejects(() => readFile(output), { code: 'ENOENT' });
});

test('CLI cannot overwrite either original input path', async t => {
  const paths = await temporary(t);
  for (const input of [paths.reportPath, paths.bundlePath]) {
    const before = await readFile(input);
    const result = cli(paths, input);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readFile(input), before);
  }
});

for (const [kind, createAlias] of [['hard link', link], ['symbolic link', symlink]]) {
  test(`CLI cannot overwrite an original input through a ${kind}`, async t => {
    const paths = await temporary(t);
    const alias = join(paths.directory, 'alias.html');
    try { await createAlias(paths.reportPath, alias); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`Filesystem does not permit this ${kind}`); return;
      }
      throw error;
    }
    const before = await readFile(paths.reportPath);
    const result = cli(paths, alias);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readFile(paths.reportPath), before);
  });
}

test('CLI also protects optional workspace and review inputs from overwrite', async t => {
  const paths = await temporary(t);
  const reviewsPath = join(paths.directory, 'reviews.json');
  const emptyReviews = { schema_version: '1.0', target_locale: 'kk', decisions: [] };
  await writeFile(reviewsPath, JSON.stringify(emptyReviews));
  const result = cli(paths, reviewsPath, ['--reviews', reviewsPath]);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(reviewsPath, 'utf8'), JSON.stringify(emptyReviews));
  const workspacePath = join(paths.directory, 'workspace.json');
  const workspace = createWorkspace(createModel(bundle, report), []);
  await writeFile(workspacePath, JSON.stringify(workspace));
  const workspaceResult = cli(paths, workspacePath, ['--workspace', workspacePath]);
  assert.notEqual(workspaceResult.status, 0);
  assert.equal(await readFile(workspacePath, 'utf8'), JSON.stringify(workspace));
});

test('renderer rejects simultaneous workspace and reviews to prevent implicit journal replacement', async t => {
  const reviews = { schema_version: '1.0', target_locale: 'kk', decisions: [] };
  const workspace = createWorkspace(createModel(bundle, report), [], reviews);
  await assert.rejects(() => renderHtml(bundle, report, { workspace, reviews }), /workspace|reviews/i);
  const paths = await temporary(t);
  const workspacePath = join(paths.directory, 'workspace.json');
  const reviewsPath = join(paths.directory, 'reviews.json');
  await writeFile(workspacePath, JSON.stringify(workspace));
  await writeFile(reviewsPath, JSON.stringify(reviews));
  const output = join(paths.directory, 'conflicting.html');
  const result = cli(paths, output, ['--workspace', workspacePath, '--reviews', reviewsPath]);
  assert.notEqual(result.status, 0);
  await assert.rejects(() => readFile(output), { code: 'ENOENT' });
});

test('precision sample embeds in standalone HTML unchanged and cannot be overwritten through CLI', async t => {
  const precisionSample = sampleForReview(report, { size: 2, seed: 'report-render-synthetic' });
  const before = JSON.stringify(precisionSample);
  const html = await renderHtml(bundle, report, { precisionSample });
  const script = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  assert.ok(script);
  const payload = JSON.parse(script[1]);
  assert.deepEqual(payload.precisionSample, precisionSample);
  assert.equal(JSON.stringify(precisionSample), before);
  const paths = await temporary(t);
  const samplePath = join(paths.directory, 'precision.json');
  await writeFile(samplePath, before);
  const output = join(paths.directory, 'precision.html');
  const result = cli(paths, output, ['--precision-sample', samplePath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(output, 'utf8'), /human_precision_sample/);
  assert.notEqual(cli(paths, samplePath, ['--precision-sample', samplePath]).status, 0);
  assert.equal(await readFile(samplePath, 'utf8'), before);
});

test('renderer rejects stale precision attestations instead of displaying confirmed counts', async t => {
  const precisionSample = sampleForReview(report, { size: 2, seed: 'report-render-stale-synthetic' });
  precisionSample.report_sha256 = '0'.repeat(64);
  await assert.rejects(() => renderHtml(bundle, report, { precisionSample }));
  const paths = await temporary(t);
  const samplePath = join(paths.directory, 'stale-precision.json');
  await writeFile(samplePath, JSON.stringify(precisionSample));
  const output = join(paths.directory, 'stale.html');
  assert.notEqual(cli(paths, output, ['--precision-sample', samplePath]).status, 0);
  await assert.rejects(() => readFile(output), { code: 'ENOENT' });
});

test('explicit falsey optional API inputs are rejected rather than treated as absent', async () => {
  for (const option of ['workspace', 'reviews', 'precisionSample']) {
    for (const invalid of [null, false, 0, '']) {
      await assert.rejects(() => renderHtml(bundle, report, { [option]: invalid }),
        `${option}=${JSON.stringify(invalid)} must not be silently ignored`);
    }
  }
});

test('CLI rejects supplied null workspace, reviews and precision files without creating output', async t => {
  const paths = await temporary(t);
  const nullPath = join(paths.directory, 'null.json');
  await writeFile(nullPath, 'null\n');
  for (const flag of ['--workspace', '--reviews', '--precision-sample']) {
    const output = join(paths.directory, `${flag.slice(2)}-null.html`);
    const result = cli(paths, output, [flag, nullPath]);
    assert.notEqual(result.status, 0, `${flag} must reject a supplied null document`);
    await assert.rejects(() => readFile(output), { code: 'ENOENT' });
  }
  assert.equal(await readFile(nullPath, 'utf8'), 'null\n');
});

test('demo defaults to a fresh output directory on each run and protects explicit existing output', async t => {
  const paths = await temporary(t);
  const script = join(root, 'modules', 'report', 'demo.mjs');
  const run = args => spawnSync(process.execPath, [script, ...args], {
    cwd: paths.directory, encoding: 'utf8', timeout: 15000,
  });
  const outputs = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    const match = /Synthetic review UI: ([^\r\n]+)/.exec(result.stdout);
    assert.ok(match, 'demo must print the concrete report path');
    outputs.push(match[1]);
    const html = await readFile(match[1], 'utf8');
    const dataScript = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    assert.ok(dataScript);
    const data = JSON.parse(dataScript[1]);
    assert.equal(data.report.length, 11);
    assert.equal(data.synthetic, true);
    assert.ok(data.report.every(finding => finding.reviewed_by_human === false));
  }
  assert.notEqual(outputs[0], outputs[1]);
  const explicit = join(paths.directory, 'existing-demo');
  await mkdir(explicit);
  const marker = join(explicit, 'keep.txt');
  await writeFile(marker, 'Preserve this previous output.');
  const refused = run(['--out', explicit]);
  assert.notEqual(refused.status, 0);
  assert.equal(await readFile(marker, 'utf8'), 'Preserve this previous output.');
  await assert.rejects(() => readFile(join(explicit, 'report.html')), { code: 'ENOENT' });
});
