// Opt-in integration test: all messages and approval records here are test
// doubles. Nothing is loaded from a real handout or a real review ledger.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { exportApproved } from '../export.mjs';
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
const exported = exportApproved({ sourceText, targetText, reviews });
await writeFile(join(out, 'source.arb'), sourceText);
await writeFile(join(out, 'intl_kk_fixed.arb'), exported.text);
await writeFile(join(out, 'TEST_ONLY.json'), JSON.stringify({ synthetic_test_data: true, real_human_reviews: 0, export_audit: exported.audit }, null, 2));
async function smoke(sourceFile, targetFile, output) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'flutter-smoke.mjs'), '--source', sourceFile, '--target', targetFile, '--out', output], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('close', resolveRun);
  });
}
assert.equal(await smoke(join(out, 'source.arb'), join(out, 'intl_kk_fixed.arb'), join(out, 'approved-export')), 0, 'Synthetic approved export must pass real Flutter generation');
// Isolate the suspicious key independently of all other baseline defects.
const probe = join(out, 'invalid-name'); await mkdir(probe);
for (const locale of ['ru', 'kk']) await writeFile(join(probe, locale + '.arb'), JSON.stringify({ '@@locale': locale, 'inventoryEquipped@description': 'INVENTED TEST ONLY' }));
assert.notEqual(await smoke(join(probe, 'ru.arb'), join(probe, 'kk.arb'), join(out, 'invalid-name-flutter')), 0);
const log = await readFile(join(out, 'invalid-name-flutter', 'flutter.log'), 'utf8');
assert.match(log, /Invalid ARB resource name "inventoryEquipped@description"/);
await writeFile(join(out, 'result.json'), JSON.stringify({ status: 'passed', scope: 'synthetic_export_and_invalid_name_probe', approved_export_flutter: true, invalid_name_rejected: true, real_human_reviews: 0 }, null, 2));
console.log('CORE FLUTTER TEST PASSED: ' + out);
