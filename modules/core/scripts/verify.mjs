// Run from any working directory. This checks code and synthetic export only;
// it neither reads a real handout nor invents real human review decisions.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const help = `Core & CLI verification (synthetic data only)

Windows, from ANY directory:
  "${fileURLToPath(new URL('../verify.cmd', import.meta.url))}"

Node.js, from ANY directory:
  node "${fileURLToPath(import.meta.url)}"

Runs npm test, npm run check and the real Flutter export smoke test.
Expected rejection cases stay in logs; they do not mean the overall test failed.
Results are saved in a new outputs/core-verification-* directory.
Requires Node.js >=22, installed repository dependencies and Flutter in PATH.
Options: --help
`;

export async function checkEnvironment(repository = root) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const packagePath = join(repository, 'package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  const require = createRequire(packagePath), missing = [];
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    try { require.resolve(name); } catch { missing.push(name); }
  }
  if (missing.length) throw new Error(`Missing dependencies: ${missing.join(', ')}.\nRun these commands once:\n  cd /d "${repository}"\n  npm ci`);
}

async function runStep(step, directory) {
  console.log(`RUN  ${step.label}`);
  const start = Date.now();
  let output = '', truncated = false;
  const result = await new Promise(resolveRun => {
    const child = spawn(step.executable, step.argv, { cwd: root, windowsHide: true, shell: false,
      env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = text => {
      output += text;
      if (output.length > 2 * 1024 * 1024) { output = output.slice(-2 * 1024 * 1024); truncated = true; }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => resolveRun({ exit_code: null, error: error.message }));
    child.once('close', code => resolveRun({ exit_code: code }));
  });
  const logFile = step.name + '.log';
  await writeFile(join(directory, logFile), output, { flag: 'wx' });
  const record = { name: step.name, command: step.command, ...result, log_file: logFile, log_truncated: truncated, duration_ms: Date.now() - start };
  if (result.exit_code !== 0) {
    console.error(`FAIL ${step.label}\n${result.error ?? output.split(/\r?\n/).slice(-25).join('\n')}\nLog: ${join(directory, logFile)}`);
  } else console.log(`PASS ${step.label}`);
  return { record, output };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') { console.log(help); return 0; }
  if (argv.length) throw new Error('Unknown arguments. Use --help.');
  await checkEnvironment();
  await mkdir(join(root, 'outputs'), { recursive: true });
  const directory = await mkdtemp(join(root, 'outputs', 'core-verification-'));
  const evidence = { status: 'running', scope: 'core_cli_synthetic_verification', repository: root,
    node_version: process.version, started_at: new Date().toISOString(), real_human_reviews_created: 0, steps: [] };
  const save = () => writeFile(join(directory, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  await save();
  console.log(`Project: ${root}\nLogs: ${directory}\nScope: code checks and synthetic Flutter export; no real translations are reviewed.`);
  // npm commands below are fixed literals, never assembled from user data.
  const npm = (name, argv, label) => ({ name, label, command: 'npm ' + argv.join(' '),
    executable: process.platform === 'win32' ? 'cmd.exe' : 'npm',
    argv: process.platform === 'win32' ? ['/d', '/s', '/c', 'npm ' + argv.join(' ')] : argv });
  const steps = [npm('tests', ['test'], 'repository tests'), npm('contracts', ['run', 'check'], 'contracts and fixtures'),
    { name: 'flutter', label: 'real Flutter export and rejection tests', command: 'node modules/core/scripts/flutter-smoke.mjs',
      executable: process.execPath, argv: [fileURLToPath(new URL('./flutter-smoke.mjs', import.meta.url))] }];
  try {
    for (const step of steps) {
      const { record, output } = await runStep(step, directory);
      evidence.steps.push(record); await save();
      if (record.exit_code !== 0) { evidence.status = 'failed'; evidence.finished_at = new Date().toISOString(); await save(); return 1; }
      if (step.name === 'flutter') {
        const resultDirectory = /^CORE FLUTTER TEST PASSED: (.+)$/m.exec(output)?.[1]?.trim();
        if (!resultDirectory) throw new Error('Flutter runner did not report its evidence directory.');
        const result = JSON.parse(await readFile(join(resultDirectory, 'result.json'), 'utf8'));
        if (result.status !== 'passed' || !result.approved_export_flutter || !result.compiler_failure_withheld_final_arb || !result.originals_unchanged) throw new Error('Flutter result is incomplete.');
        evidence.flutter_evidence_directory = resultDirectory;
      }
    }
    evidence.status = 'passed'; evidence.finished_at = new Date().toISOString(); await save();
    console.log(`\nCORE VERIFICATION PASSED\nEvidence: ${join(directory, 'verification.json')}`);
    return 0;
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error.message; evidence.finished_at = new Date().toISOString(); await save(); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
