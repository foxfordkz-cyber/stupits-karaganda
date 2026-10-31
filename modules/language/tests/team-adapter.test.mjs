import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashText, assertContract } from '../../../src/contracts.mjs';
import { runLanguage } from '../check.mjs';

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
