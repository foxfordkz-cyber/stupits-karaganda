import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashText, assertContract } from '../../../src/contracts.mjs';
import { runLanguage } from '../check.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bekzat-team-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = { key: 'syntheticGift', entry_id: 'syntheticGift#1', occurrence: 1,
    source: 'Подарок для {name}', target: '{name}-ға сыйлық',
    source_hash: hashText('Подарок для {name}'), target_hash: hashText('{name}-ға сыйлық'),
    context: { section: 'synthetic', description: null, references: { en: 'Gift for {name}' } } };
  const bundle = { schema_version: '1.0', source_locale: 'ru', target_locale: 'kk', entries: [entry] };
  const input = join(dir, 'bundle.json'), glossary = join(dir, 'glossary.csv'), out = join(dir, 'language.json');
  writeFileSync(input, JSON.stringify(bundle));
  writeFileSync(glossary, 'ru,kk,en,comment\nподарок,сыйлық,gift,"Synthetic, no approvals"\n');
  return { dir, input, glossary, out, bundle };
}

test('language adapter produces shared report, preserves entry identity and uses cache', t => {
  const f = fixture(t);
  assert.deepEqual(runLanguage({ bundle: f.input, glossary: f.glossary, out: f.out }), { status: 0, findings: 1 });
  const report = JSON.parse(readFileSync(f.out, 'utf8'));
  assertContract('report', report);
  assert.equal(report[0].issue_type, 'suffix_harmony');
  assert.equal(report[0].reviewed_by_human, false);
  const index = JSON.parse(readFileSync(f.out + '.details/finding_index.json', 'utf8'));
  assert.equal(index[0].entry_id, 'syntheticGift#1');
  assert.equal(index[0].source_hash, f.bundle.entries[0].source_hash);
  const out2 = join(f.dir, 'again.json');
  runLanguage({ bundle: f.input, glossary: f.glossary, out: out2 });
  const metrics = JSON.parse(readFileSync(out2 + '.details/metrics.json', 'utf8'));
  assert.equal(metrics.local_cache_hits, 1);
  assert.equal(metrics.provider_requests, 0);
});

test('missing translation stays a core concern, not a language finding', t => {
  const f = fixture(t);
  f.bundle.entries[0] = { ...f.bundle.entries[0], entry_id: 'syntheticGift#0', occurrence: 0, target: null, target_hash: null };
  writeFileSync(f.input, JSON.stringify(f.bundle));
  assert.equal(runLanguage({ bundle: f.input, glossary: f.glossary, out: f.out }).findings, 0);
  const skipped = JSON.parse(readFileSync(f.out + '.details/skipped_entries.json', 'utf8'));
  assert.equal(skipped.length, 1);
});

test('shared validator rejects stale bundle hashes before analysis', t => {
  const f = fixture(t);
  f.bundle.entries[0].source = 'Changed without updating hash';
  writeFileSync(f.input, JSON.stringify(f.bundle));
  assert.throws(() => runLanguage({ bundle: f.input, glossary: f.glossary, out: f.out }), /Stale content hash/);
});

test('language adapter refuses to overwrite an existing report', t => {
  const f = fixture(t);
  writeFileSync(f.out, 'original');
  assert.throws(() => runLanguage({ bundle: f.input, glossary: f.glossary, out: f.out }));
  assert.equal(readFileSync(f.out, 'utf8'), 'original');
});

test('spelling candidates retain entry identity without becoming human decisions', t => {
  const f = fixture(t);
  f.bundle.entries[0].target = 'Сыйлык {name}';
  f.bundle.entries[0].target_hash = hashText('Сыйлык {name}');
  writeFileSync(f.input, JSON.stringify(f.bundle));
  runLanguage({ bundle: f.input, glossary: f.glossary, out: f.out });
  const [p] = JSON.parse(readFileSync(f.out + '.details/proposals.json', 'utf8'));
  assert.equal(p.entry_id, 'syntheticGift#1');
  assert.equal(p.original_target_hash, f.bundle.entries[0].target_hash);
  assert.equal(p.candidate_hash, hashText(p.candidate_text));
  assert.equal(p.candidate_text, 'Сыйлық {name}');
  assert.equal(p.reviewed_by_human, false);
  assert.equal(p.status, 'pending_human_review');
  assert.equal(p.technical_validation, 'pending_core');
});

test('pilot selection reports its scope and keeps original bundle indices', t => {
  const f = fixture(t);
  const empty = { ...f.bundle.entries[0], key: 'empty', entry_id: 'empty#0',
    occurrence: 0, target: null, target_hash: null };
  const later = { ...f.bundle.entries[0], key: 'later', entry_id: 'later#1' };
  f.bundle.entries = [empty, f.bundle.entries[0], later];
  writeFileSync(f.input, JSON.stringify(f.bundle));
  runLanguage({ bundle: f.input, glossary: f.glossary, out: f.out, limit: 1 });
  const metrics = JSON.parse(readFileSync(f.out + '.details/metrics.json', 'utf8'));
  const index = JSON.parse(readFileSync(f.out + '.details/finding_index.json', 'utf8'));
  assert.equal(metrics.bundle_entries, 3);
  assert.equal(metrics.available_input_records, 2);
  assert.equal(metrics.selected_records, 1);
  assert.equal(metrics.selection, 'first_n');
  assert.equal(index[0].bundle_index, 1);
});

test('model CLI respects request budget and reuses cached responses with zero budget', t => {
  const f = fixture(t);
  f.bundle.entries.push({ ...f.bundle.entries[0], key: 'second', entry_id: 'second#1' });
  writeFileSync(f.input, JSON.stringify(f.bundle));
  const adapter = join(f.dir, 'synthetic-provider.py');
  writeFileSync(adapter, 'import json, sys\njson.load(sys.stdin)\nprint(json.dumps({"issues": [], "usage": {"input_tokens": 10, "output_tokens": 5}}))\n');
  const python = process.env.LOCQA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const config = join(f.dir, 'provider.json');
  writeFileSync(config, JSON.stringify({
    command: [python, adapter], provider_id: 'synthetic', model_id: 'synthetic',
    revision: '1', max_output_tokens: 100, timeout_seconds: 5,
    input_usd_per_million: 1, output_usd_per_million: 2,
  }));
  const cli = fileURLToPath(new URL('../check.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--bundle', f.input, '--glossary', f.glossary,
    '--out', f.out, '--provider-config', config, '--max-requests', '1',
    '--max-tokens', '100000', '--max-cost-usd', '1', '--timeout-ms', '30000'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /mode=model_and_local/);
  const m = JSON.parse(readFileSync(f.out + '.details/metrics.json', 'utf8'));
  assert.equal(m.provider_requests, 1);
  assert.equal(m.model_records_completed, 1);
  assert.equal(m.model_records_skipped, 1);
  assert.equal(m.status, 'partial');
  assert.equal(m.cost_usd_total, 0.00002);
  const again = join(f.dir, 'cached.json');
  assert.equal(runLanguage({ bundle: f.input, glossary: f.glossary, out: again,
    providerConfig: config, limit: 1 }).status, 0);
  const cached = JSON.parse(readFileSync(again + '.details/metrics.json', 'utf8'));
  assert.equal(cached.model_cache_hits, 1);
  assert.equal(cached.provider_requests, 0);
  assert.equal(cached.cost_usd_total, 0);
});

test('numeric budgets and pilot size are validated before spawning', t => {
  const f = fixture(t);
  const options = { bundle: f.input, glossary: f.glossary, out: f.out };
  for (const invalid of [{ limit: 0 }, { maxRequests: 1.5 }, { maxCostUsd: NaN },
    { maxRequests: 1 }, { timeoutMs: 0 }]) {
    assert.throws(() => runLanguage({ ...options, ...invalid }));
  }
});

test('mixed-language sentence and printf suffix survive the shared report boundary', t => {
  const f = fixture(t);
  const entry = f.bundle.entries[0];
  entry.source = 'Добро пожаловать! Нажмите продолжить. Подарок для %1$s';
  entry.target = 'Қош келдіңіз! Please click continue. %1$s-ға сыйлық';
  entry.source_hash = hashText(entry.source);
  entry.target_hash = hashText(entry.target);
  writeFileSync(f.input, JSON.stringify(f.bundle));
  assert.equal(runLanguage({ bundle: f.input, glossary: f.glossary, out: f.out }).status, 0);
  const report = JSON.parse(readFileSync(f.out, 'utf8'));
  assertContract('report', report);
  assert.deepEqual(report.map(finding => finding.issue_type).sort(), ['suffix_harmony', 'wrong_language']);
  assert.ok(report.every(finding => finding.reviewed_by_human === false));
});

test('zero-budget relevant glossary mode exports a forecast without executing an adapter', t => {
  const f = fixture(t);
  writeFileSync(f.glossary, 'ru,kk,en,comment\nподарок,сыйлық,gift,Synthetic\nстул,орындық,chair,Synthetic\n');
  const config = join(f.dir, 'provider.json');
  // Nonexistent executable would fail if the zero-budget guard attempted a call.
  writeFileSync(config, JSON.stringify({
    command: ['never-execute-synthetic-adapter'], provider_id: 'synthetic', model_id: 'synthetic',
    revision: '1', max_output_tokens: 100, timeout_seconds: 5,
    input_usd_per_million: 1, output_usd_per_million: 2, glossary_scope: 'relevant',
  }));
  const result = runLanguage({ bundle: f.input, glossary: f.glossary, out: f.out, providerConfig: config });
  assert.equal(result.status, 2);
  const m = JSON.parse(readFileSync(f.out + '.details/metrics.json', 'utf8'));
  assert.equal(m.provider_requests, 0);
  assert.equal(m.provider_failures, 0);
  assert.equal(m.cost_usd_total, 0);
  assert.equal(m.budget_forecast.uncached_records, 1);
  assert.ok(m.budget_forecast.uncached_reserved_cost_usd > 0);
  assert.ok(m.budget_forecast.selected_glossary_bytes < m.budget_forecast.full_glossary_bytes);
  const event = JSON.parse(readFileSync(f.out + '.details/events.jsonl', 'utf8').trim());
  assert.equal(event.glossary_selection.selected_entries, 1);
  assert.equal(event.glossary_selection.omitted_entries, 1);
});
