// Make language Python regressions part of existing npm CI without changing shared CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('complete Python language regressions pass, including provider/cache failures', () => {
  const python = process.env.LOCQA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-q'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
    timeout: 180000, maxBuffer: 2_000_000, windowsHide: true,
  });
  assert.equal(result.status, 0, `Python regression failure: ${result.error?.code || ''}\n${result.stderr}`);
});
