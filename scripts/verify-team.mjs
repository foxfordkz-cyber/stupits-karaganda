// Reproducible verification of the merged team. Synthetic inputs only.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { privatePath } from '../modules/language/review-io.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node scripts/verify-team.mjs [--out NEW_DIRECTORY_OUTSIDE_GIT]\nRuns tests (including Python), contracts, all real team modules on synthetic inputs, Flutter and packaging. No real approvals or network model calls.');
} else {
  const out = values.out ? privatePath(values.out) : await mkdtemp(join(tmpdir(), 'locqa-team-verification-'));
  if (values.out) { await mkdir(dirname(out), { recursive: true }); await mkdir(out); }
  const evidence = { status: 'running', scope: 'merged_team_synthetic_verification', started_at: new Date().toISOString(),
    node: process.version, human_reviews_created: 0, real_data_used: false, steps: [] };
  const save = () => writeFile(join(out, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  await save();
  console.log('Team verification: ' + out);
  const npm = args => process.platform === 'win32'
    ? { executable: 'cmd.exe', argv: ['/d', '/s', '/c', 'npm ' + args.join(' ')] }
    : { executable: 'npm', argv: args };
  const node = (script, args = []) => ({ executable: process.execPath, argv: [join(root, script), ...args] });
  const steps = [
    { name: 'tests', ...npm(['test']) },
    { name: 'contracts', ...npm(['run', 'check']) },
    { name: 'team-pipeline', ...node('modules/language/review-smoke.mjs', ['--out', join(out, 'team-pipeline'), '--core-root', root, '--report-root', root, '--linguistics-root', root]) },
    { name: 'core-flutter', ...node('modules/core/scripts/flutter-smoke.mjs') },
    { name: 'packaging', ...node('scripts/integration-smoke.mjs', ['--out', join(out, 'packaging')]) },
  ];
  try {
    for (const step of steps) {
      console.log('RUN  ' + step.name);
      const started = Date.now();
      const result = await new Promise((done, reject) => {
        let output = '', truncated = false;
        const child = spawn(step.executable, step.argv, { cwd: root, windowsHide: true, shell: false,
          env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        const capture = data => { output += data; if (output.length > 2_000_000) { output = output.slice(-2_000_000); truncated = true; } };
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', capture); child.stderr.on('data', capture);
        child.once('error', reject); child.once('close', code => done({ code, output, truncated }));
      });
      await writeFile(join(out, step.name + '.log'), result.output, { flag: 'wx' });
      evidence.steps.push({ name: step.name, executable: step.executable, argv: step.argv, exit_code: result.code,
        duration_ms: Date.now() - started, log_file: step.name + '.log', log_truncated: result.truncated });
      await save();
      if (result.code !== 0) throw new Error(step.name + ' failed; see ' + join(out, step.name + '.log'));
      if (step.name === 'core-flutter') {
        const original = /^CORE FLUTTER TEST PASSED: (.+)$/m.exec(result.output)?.[1]?.trim();
        if (!original) throw new Error('Core Flutter evidence path absent');
        await cp(original, join(out, 'core-flutter'), { recursive: true, errorOnExist: true, force: false });
      }
      console.log('PASS ' + step.name);
    }
    const read = async name => JSON.parse(await readFile(join(out, name), 'utf8'));
    const pipeline = await read('team-pipeline/review-smoke-summary.json');
    const flutter = await read('core-flutter/result.json');
    const packaging = await read('packaging/integration-evidence.json');
    if ([pipeline, flutter, packaging].some(v => v.status !== 'passed') || pipeline.human_review_status !== 'HUMAN_REVIEW_PENDING'
      || !flutter.approved_export_flutter || !flutter.compiler_failure_withheld_final_arb || !packaging.package_verified) throw new Error('Incomplete verification evidence');
    evidence.status = 'passed';
    evidence.human_review_status = 'HUMAN_REVIEW_PENDING';
    console.log('TEAM VERIFICATION PASSED\nEvidence: ' + join(out, 'verification.json'));
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error.message; process.exitCode = 1; console.error(error.message);
  } finally { evidence.finished_at = new Date().toISOString(); await save(); }
}
