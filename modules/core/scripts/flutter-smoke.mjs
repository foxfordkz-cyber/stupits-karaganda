// Opt-in integration test: all messages and approval records here are test
// doubles. Nothing is loaded from a real handout or a real review ledger.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hashText } from '../../../src/contracts.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = resolve(root, 'outputs', 'core-flutter-test-' + Date.now());
await mkdir(dirname(out), { recursive: true });
await mkdir(out, { recursive: false });
const fixture = name => readFile(new URL('../../../fixtures/synthetic/flutter-valid/' + name, import.meta.url), 'utf8');
const sourceText = await fixture('source.arb'), targetText = await fixture('target.arb');
const source = JSON.parse(sourceText), target = JSON.parse(targetText), approved = 'TEST ONLY: {visitor}!';
const reviews = { schema_version: '1.0', target_locale: 'kk', decisions: [{
  key: 'smokeWelcome', entry_id: 'smokeWelcome#1', decision: 'accepted',
  original_text: target.smokeWelcome, approved_text: approved, source_hash: hashText(source.smokeWelcome),
  original_hash: hashText(target.smokeWelcome), approved_hash: hashText(approved),
  reviewer: 'TEST_DOUBLE_NOT_A_HUMAN_REVIEW', reviewed_at: '2026-10-30T00:00:00Z', reviewed_by_human: true
}] };
await writeFile(join(out, 'source.arb'), sourceText);
await writeFile(join(out, 'original.arb'), targetText);
await writeFile(join(out, 'mock-reviews.json'), JSON.stringify(reviews));
await writeFile(join(out, 'TEST_ONLY.json'), JSON.stringify({ synthetic_test_data: true, real_human_reviews: 0 }, null, 2));
async function run(script, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('close', resolveRun);
  });
}
const cli = join(root, 'modules', 'core', 'cli.mjs'), verified = join(out, 'approved-export');
assert.equal(await run(cli, ['export', '--source', join(out, 'source.arb'), '--target', join(out, 'original.arb'),
  '--reviews', join(out, 'mock-reviews.json'), '--out', verified, '--verify-flutter']), 0, 'Synthetic approved export must pass real Flutter generation');
const fixed = await readFile(join(verified, 'intl_kk_fixed.arb'), 'utf8');
const audit = JSON.parse(await readFile(join(verified, 'export-audit.json'), 'utf8'));
assert.equal(audit.flutter_verified, true);
assert.equal(audit.flutter.target_sha256, hashText(fixed));
assert.equal(audit.flutter.source_sha256, hashText(sourceText));
assert.equal(JSON.parse(fixed)['@smokeWelcome']['x-locqa'].reviewer, 'TEST_DOUBLE_NOT_A_HUMAN_REVIEW');
assert.equal(await readFile(join(out, 'source.arb'), 'utf8'), sourceText);
assert.equal(await readFile(join(out, 'original.arb'), 'utf8'), targetText);

// FormatJS accepts offsets; this Flutter parser rejects them. A failed real
// compiler must leave diagnostics but never the final intl_kk_fixed.arb.
const failed = join(out, 'compiler-failure-inputs'); await mkdir(failed);
for (const locale of ['ru', 'kk']) await writeFile(join(failed, locale + '.arb'), JSON.stringify({
  '@@locale': locale, message: '{n, plural, offset:1 other{INVENTED TEST ONLY}}', '@message': { placeholders: { n: { type: 'num' } } }
}));
await writeFile(join(failed, 'reviews.json'), JSON.stringify({ schema_version: '1.0', target_locale: 'kk', decisions: [] }));
const blocked = join(out, 'compiler-failure');
assert.equal(await run(cli, ['export', '--source', join(failed, 'ru.arb'), '--target', join(failed, 'kk.arb'),
  '--reviews', join(failed, 'reviews.json'), '--out', blocked, '--verify-flutter']), 2);
await assert.rejects(access(join(blocked, 'intl_kk_fixed.arb')), { code: 'ENOENT' });
assert.equal(JSON.parse(await readFile(join(blocked, 'failure.json'), 'utf8')).flutter_verified, false);
assert.equal(JSON.parse(await readFile(join(blocked, 'flutter', 'evidence.json'), 'utf8')).status, 'failed');
// Isolate the suspicious key independently of all other baseline defects.
const probe = join(out, 'invalid-name'); await mkdir(probe);
for (const locale of ['ru', 'kk']) await writeFile(join(probe, locale + '.arb'), JSON.stringify({ '@@locale': locale, 'inventoryEquipped@description': 'INVENTED TEST ONLY' }));
assert.notEqual(await run(join(root, 'scripts', 'flutter-smoke.mjs'), ['--source', join(probe, 'ru.arb'), '--target', join(probe, 'kk.arb'), '--out', join(out, 'invalid-name-flutter')]), 0);
const log = await readFile(join(out, 'invalid-name-flutter', 'flutter.log'), 'utf8');
assert.match(log, /Invalid ARB resource name "inventoryEquipped@description"/);
await writeFile(join(out, 'result.json'), JSON.stringify({ status: 'passed', scope: 'synthetic_verified_cli_export_and_failure_probes', approved_export_flutter: true, compiler_failure_withheld_final_arb: true, invalid_name_rejected: true, originals_unchanged: true, real_human_reviews: 0 }, null, 2));
console.log('CORE FLUTTER TEST PASSED: ' + out);
