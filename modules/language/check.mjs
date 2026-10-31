// Team pipeline entry point. Shared contracts/dependencies remain owned by the integrator.
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { assertContract } from '../../src/contracts.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function runLanguage({ bundle, glossary, out, cache,
  providerConfig, maxRequests = 0, maxTokens = 0, maxCostUsd = 0, limit,
  timeoutMs = 120000,
  python = process.env.LOCQA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }) {
  for (const n of [maxRequests, maxTokens]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Budget counts must be nonnegative integers');
  }
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0 || maxCostUsd > 1e12) throw new Error('Invalid cost budget');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('Invalid pilot size');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('Invalid timeout');
  if (!providerConfig && (maxRequests || maxTokens || maxCostUsd)) throw new Error('Budget requires provider config');
  // The shared validator checks exact source/target hashes, entry_id and duplicates.
  const stat = statSync(bundle);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Bundle must be a regular file of at most 64 MiB');
  const parsed = JSON.parse(readFileSync(bundle, 'utf8').replace(/^\uFEFF/, ''));
  assertContract('bundle', parsed);
  const argv = [resolve(moduleDir, 'team_cli.py'), '--bundle', resolve(bundle),
    '--glossary', resolve(glossary), '--out', resolve(out)];
  if (cache) argv.push('--cache', resolve(cache));
  if (providerConfig) argv.push('--provider-config', resolve(providerConfig));
  if (limit !== undefined) argv.push('--limit', String(limit));
  argv.push('--max-requests', String(maxRequests), '--max-tokens', String(maxTokens),
    '--max-cost-usd', String(maxCostUsd));
  const result = spawnSync(python, argv, {
    cwd: moduleDir, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: timeoutMs, maxBuffer: 1_000_000,
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
      'provider-config': { type: 'string' }, limit: { type: 'string' },
      'max-requests': { type: 'string' }, 'max-tokens': { type: 'string' },
      'max-cost-usd': { type: 'string' }, 'timeout-ms': { type: 'string' },
    }});
    if (!values.bundle || !values.glossary || !values.out) {
      throw new Error('Use --bundle FILE --glossary FILE --out NEW_PRIVATE_REPORT [--cache DIR] [--python EXE]');
    }
    const options = { ...values, providerConfig: values['provider-config'] };
    for (const [flag, key] of [['max-requests', 'maxRequests'], ['max-tokens', 'maxTokens'],
      ['max-cost-usd', 'maxCostUsd'], ['limit', 'limit'], ['timeout-ms', 'timeoutMs']]) {
      if (values[flag] !== undefined) {
        if (!values[flag].trim()) throw new Error('Numeric options must not be blank');
        options[key] = Number(values[flag]);
      }
    }
    const result = runLanguage(options);
    const mode = options.providerConfig ? 'model_and_local' : 'local_only';
    console.log(`language: findings=${result.findings}; status=${result.status}; mode=${mode}`);
    process.exitCode = result.status;
  } catch {
    console.error('Language stage failed validation or execution; see modules/language/README.md');
    process.exitCode = 1;
  }
}
