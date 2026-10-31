import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashText } from '../../src/contracts.mjs';

export function assertFlutterEvidence(evidence, sourceText, fixedText) {
  const commands = ['flutter --version', 'flutter pub get', 'flutter gen-l10n'];
  if (evidence?.status !== 'passed' || evidence.source_sha256 !== hashText(sourceText)
      || evidence.target_sha256 !== hashText(fixedText)
      || !Array.isArray(evidence.commands) || evidence.commands.length !== commands.length
      || commands.some((command, i) => evidence.commands[i]?.command?.replace(/^flutter --no-version-check /, 'flutter ') !== command || evidence.commands[i]?.exit_code !== 0)) {
    throw new Error('Flutter evidence does not prove successful generation for these exact source/fixed bytes.');
  }
}

// Reuse the integrator's real Flutter runner. Isolated snapshots prevent a file
// changing while Flutter runs from verifying a different version than export.
export async function verifyFlutterExport({ sourceText, fixedText, sourceLocale, targetLocale, out }) {
  const staging = join(out, 'flutter-inputs'), project = join(out, 'flutter');
  await mkdir(staging);
  const sourcePath = join(staging, 'source.arb'), fixedPath = join(staging, 'candidate.arb');
  await writeFile(sourcePath, sourceText, { flag: 'wx' });
  await writeFile(fixedPath, fixedText, { flag: 'wx' });
  const runner = fileURLToPath(new URL('../../scripts/flutter-smoke.mjs', import.meta.url));
  const code = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [runner, '--source', sourcePath, '--target', fixedPath,
      '--source-locale', sourceLocale, '--target-locale', targetLocale, '--out', project], {
      stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true
    });
    child.once('error', reject); child.once('close', code => resolveRun(code));
  });
  if (code !== 0) throw new Error('Flutter verification failed; no final ARB was released. Inspect flutter/flutter.log.');
  const evidence = JSON.parse(await readFile(join(project, 'evidence.json'), 'utf8'));
  assertFlutterEvidence(evidence, sourceText, fixedText);
  const [generated, copiedSource, copiedFixed, log] = await Promise.all([
    readFile(join(project, 'lib', 'generated', 'app_localizations.dart'), 'utf8'),
    readFile(join(project, 'lib', 'l10n', `app_${sourceLocale}.arb`), 'utf8'),
    readFile(join(project, 'lib', 'l10n', `app_${targetLocale}.arb`), 'utf8'),
    readFile(join(project, 'flutter.log'), 'utf8')
  ]);
  if (!generated.trim() || copiedSource !== sourceText || copiedFixed !== fixedText) {
    throw new Error('Flutter project has missing output or changed input bytes; no final ARB was released.');
  }
  if (evidence.generated_sha256 !== hashText(generated) || evidence.log_sha256 !== hashText(log)) throw new Error('Flutter output/log hashes no longer match the recorded evidence.');
  return { ...evidence, evidence_file: 'flutter/evidence.json', generated_sha256: hashText(generated) };
}
