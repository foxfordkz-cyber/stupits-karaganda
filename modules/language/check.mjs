// Team pipeline entry point. Shared contracts/dependencies remain owned by the integrator.
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { assertContract } from '../../src/contracts.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function runLanguage({ bundle, glossary, out, cache,
  python = process.env.LOCQA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }) {
  // The shared validator checks exact source/target hashes, entry_id and duplicates.
  const stat = statSync(bundle);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Bundle must be a regular file of at most 64 MiB');
  const parsed = JSON.parse(readFileSync(bundle, 'utf8').replace(/^\uFEFF/, ''));
  assertContract('bundle', parsed);
  const argv = [resolve(moduleDir, 'team_cli.py'), '--bundle', resolve(bundle),
    '--glossary', resolve(glossary), '--out', resolve(out)];
  if (cache) argv.push('--cache', resolve(cache));
  const result = spawnSync(python, argv, {
    cwd: moduleDir, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: 120000, maxBuffer: 1_000_000,
  });
  if (result.error || ![0, 2].includes(result.status)) {
    // No raw stderr: a provider/system error could contain private text or credentials.
    throw new Error('Language process failed; check Python, private paths and module README');
  }
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assertContract('report', report);
  if (report.some(f => f.reviewed_by_human !== false)) throw new Error('Machine report cannot claim human review');
  for (const f of report) {
    if (!parsed.entries.some(e => e.key === f.key && e.source === f.source && e.target === f.target)) {
      throw new Error('Language finding does not match input bundle');
    }
  }
  return { status: result.status, findings: report.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      bundle: { type: 'string' }, glossary: { type: 'string' }, out: { type: 'string' },
      cache: { type: 'string' }, python: { type: 'string' },
    }});
    if (!values.bundle || !values.glossary || !values.out) {
      throw new Error('Use --bundle FILE --glossary FILE --out NEW_PRIVATE_REPORT [--cache DIR] [--python EXE]');
    }
    const result = runLanguage(values);
    console.log(`language: findings=${result.findings}; status=${result.status}; mode=local_only`);
    process.exitCode = result.status;
  } catch {
    console.error('Language stage failed validation or execution; see modules/language/README.md');
    process.exitCode = 1;
  }
}
