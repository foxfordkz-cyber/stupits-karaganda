import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { args, main, writeJson } from '../src/io.mjs';
import { inspectArb } from '../src/arb-audit.mjs';
import { hashText } from '../src/contracts.mjs';

await main(async () => {
  const a = args({
    source:{type:'string'},target:{type:'string'},out:{type:'string'},
    'source-locale':{type:'string'},'target-locale':{type:'string'},offline:{type:'boolean'}
  },['source','target','out']);
  const sourceText = await readFile(a.source,'utf8'), targetText = await readFile(a.target,'utf8');
  function locale(text,explicit) {
    const value = explicit ?? inspectArb(text).metadata.get('@@locale');
    if (typeof value !== 'string' || !/^[A-Za-z]{2,8}(?:[_-][A-Za-z0-9]{2,8})*$/.test(value)) throw new Error('Provide valid --source-locale/--target-locale when @@locale is absent');
    Intl.getCanonicalLocales(value.replaceAll('_','-'));
    return value;
  }
  const sourceLocale = locale(sourceText,a['source-locale']), targetLocale = locale(targetText,a['target-locale']);
  if (sourceLocale.toLowerCase() === targetLocale.toLowerCase()) throw new Error('Source and target locales must differ for smoke test');
  const out = resolve(a.out);
  // Never overwrite a previous run or an input directory.
  await mkdir(dirname(out),{recursive:true});
  await mkdir(out,{recursive:false});
  await mkdir(join(out,'lib','l10n'),{recursive:true});
  const sourceName = 'app_' + sourceLocale + '.arb', targetName = 'app_' + targetLocale + '.arb';
  await copyFile(resolve(a.source),join(out,'lib','l10n',sourceName));
  await copyFile(resolve(a.target),join(out,'lib','l10n',targetName));
  await writeFile(join(out,'pubspec.yaml'), 'name: locqa_smoke\npublish_to: none\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_localizations:\n    sdk: flutter\n  intl: any\nflutter:\n  generate: true\n');
  await writeFile(join(out,'l10n.yaml'), 'arb-dir: lib/l10n\ntemplate-arb-file: ' + JSON.stringify(sourceName) + '\noutput-localization-file: app_localizations.dart\noutput-dir: lib/generated\nuse-escaping: true\n');
  const evidence = { status:'running', source_sha256:hashText(sourceText), target_sha256:hashText(targetText), commands:[], started_at:new Date().toISOString() };
  let log = '';
  async function run(argv) {
    const command = 'flutter ' + argv.join(' ');
    console.log(command);
    const start = Date.now();
    const result = await new Promise(resolveRun => {
      const child = process.platform === 'win32'
        ? spawn('cmd.exe',['/d','/s','/c',command],{cwd:out,windowsHide:true,env:{...process.env,CI:'true',FLUTTER_SUPPRESS_ANALYTICS:'true'},stdio:['ignore','pipe','pipe']})
        : spawn('flutter',argv,{cwd:out,env:{...process.env,CI:'true',FLUTTER_SUPPRESS_ANALYTICS:'true'},stdio:['ignore','pipe','pipe']});
      let output = '', settled = false;
      const finish = value => { if (!settled) { settled=true; clearTimeout(timer); resolveRun(value); } };
      const timer = setTimeout(() => {
        if (process.platform === 'win32') spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        else child.kill('SIGTERM');
        finish({code:1,output:output + '\nTIMEOUT after 180 seconds'});
      },180000);
      child.stdout.on('data',data => {output += data; process.stdout.write(data);});
      child.stderr.on('data',data => {output += data; process.stderr.write(data);});
      child.on('error',error => finish({code:1,output:output+'\n'+error.message}));
      child.on('close',code => finish({code:code ?? 1,output}));
    });
    log += '\n$ ' + command + '\n' + result.output;
    evidence.commands.push({command,exit_code:result.code,duration_ms:Date.now()-start});
    await writeFile(join(out,'flutter.log'),log);
    await writeJson(join(out,'evidence.json'),evidence);
    return result.code === 0;
  }
  const commands = a.offline ? [['--no-version-check','--version'],['--no-version-check','pub','get','--offline'],['--no-version-check','gen-l10n']] : [['--no-version-check','--version'],['--no-version-check','pub','get'],['--no-version-check','gen-l10n']];
  for (const argv of commands) {
    if (!await run(argv)) {
      evidence.status='failed'; evidence.finished_at=new Date().toISOString();
      await writeJson(join(out,'evidence.json'),evidence);
      process.exitCode=1; return;
    }
  }
  // Confirm generation happened, rather than accepting a silent no-op.
  try { evidence.generated_sha256=hashText(await readFile(join(out,'lib','generated','app_localizations.dart'),'utf8')); }
  catch (error) {
    evidence.status='failed'; evidence.error='Generated Dart output missing: '+error.message;
    await writeJson(join(out,'evidence.json'),evidence); throw error;
  }
  evidence.log_sha256=hashText(log);
  evidence.status='passed'; evidence.finished_at=new Date().toISOString();
  await writeJson(join(out,'evidence.json'),evidence);
  console.log('FLUTTER VERIFIED: ' + join(out,'evidence.json'));
});
