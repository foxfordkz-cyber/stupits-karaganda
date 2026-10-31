import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnvironment } from '../scripts/verify.mjs';

const runner = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));
const launcher = fileURLToPath(new URL('../verify.cmd', import.meta.url));

test('absolute verification command works outside the repository without changing cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'locqa-other-folder-'));
  const result = spawnSync(process.execPath, [runner, '--help'], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /from ANY directory/);
  assert.match(result.stdout, /npm test/);
});

test('Windows launcher quotes its own path including spaces', { skip: process.platform !== 'win32' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'locqa cmd test '));
  const module = join(cwd, 'checkout with spaces', 'modules', 'core');
  await mkdir(join(module, 'scripts'), { recursive: true });
  await copyFile(runner, join(module, 'scripts', 'verify.mjs'));
  await copyFile(launcher, join(module, 'verify.cmd'));
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${join(module, 'verify.cmd')}" --help"`],
    { cwd, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Core & CLI verification/);
});

test('verification reports unknown options and actionable dependency errors', async () => {
  const result = spawnSync(process.execPath, [runner, '--unknown'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Use --help/);
  const repository = await mkdtemp(join(tmpdir(), 'locqa-missing-deps-'));
  await writeFile(join(repository, 'package.json'), JSON.stringify({ dependencies: { 'locqa-deliberately-missing-test-package': '0.0.0' } }));
  await assert.rejects(checkEnvironment(repository), /Missing dependencies:[\s\S]*npm ci/);
});
