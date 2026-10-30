import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, unlink, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { packageSubmission, verifySubmission, verifyFlutterEvidence, sha256 } from '../src/submission.mjs';
import { hashText } from '../src/contracts.mjs';

const COMMANDS=['flutter --version','flutter pub get','flutter gen-l10n'];
const stringify=value=>JSON.stringify(value,null,2)+'\n';
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'locqa-package-'));
  const source={'@@locale':'ru',syntheticButton:'Open {item}'};
  const original={'@@locale':'kk',syntheticButton:'Old {item}'};
  // Test-only attestations. These are not actual human approvals or a Flutter run.
  const decision={key:'syntheticButton',entry_id:'syntheticButton#1',decision:'edited',
    original_text:original.syntheticButton,approved_text:'New {item}',
    source_hash:hashText(source.syntheticButton),original_hash:hashText(original.syntheticButton),
    approved_hash:hashText('New {item}'),reviewer:'TEST_ONLY',reviewed_at:'2026-10-30T00:00:00Z',reviewed_by_human:true};
  const stamp=Object.fromEntries(['reviewed_by_human','reviewer','reviewed_at','source_hash','original_hash','approved_hash'].map(k=>[k,decision[k]]));
  const fixed={'@@locale':'kk',syntheticButton:'New {item}','@syntheticButton':{'x-locqa':stamp}};
  const report=[{key:'syntheticButton',issue_type:'orthography',severity:'medium',source:source.syntheticButton,
    target:original.syntheticButton,evidence:'Synthetic unit test only',suggestion:fixed.syntheticButton,confidence:0.7,reviewed_by_human:false}];
  const sourceText=stringify(source),fixedText=stringify(fixed);
  const logText=COMMANDS.map(c=>'\n$ '+c+'\nTEST_ONLY mock runner output\n').join('');
  const evidence={status:'passed',started_at:'2026-10-30T00:00:00Z',finished_at:'2026-10-30T00:00:03Z',
    source_sha256:hashText(sourceText),target_sha256:hashText(fixedText),log_sha256:hashText(logText),
    generated_sha256:hashText('TEST_ONLY generated Dart'),
    commands:COMMANDS.map(command=>({command,exit_code:0,duration_ms:1}))};
  const values={source:sourceText,originalTarget:stringify(original),fixed:fixedText,
    report:stringify(report),reviews:stringify({schema_version:'1.0',target_locale:'kk',decisions:[decision]}),
    glossary:'ru,kk,en,comment\nterm,term,term,"Synthetic, invented term"\n',
    html:'<!doctype html><html><body>Synthetic unit test only</body></html>',
    methodology:'TEST_ONLY synthetic unit test methodology',
    flutterEvidence:stringify(evidence),flutterLog:logText};
  const options={out:join(dir,'package')};
  for(const [role,value] of Object.entries(values)){
    options[role]=join(dir,role+'.input');
    await writeFile(options[role],value);
  }
  return {dir,options,values,evidence,sourceText,fixedText,logText};
}
async function cleanup(dir){
  const root=resolve(tmpdir())+sep;
  if(!resolve(dir).startsWith(root))throw new Error('Unsafe test cleanup');
  await rm(dir,{recursive:true,force:true});
}
async function withFixture(fn){
  const f=await fixture();
  try{return await fn(f);}finally{await cleanup(f.dir);}
}
async function manifest(dir){return JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));}
async function rewriteManifest(dir,value){await writeFile(join(dir,'manifest.json'),stringify(value));}

test('packages exact snapshots and re-verifies complete semantic checks',()=>withFixture(async f=>{
  const before=Object.fromEntries(await Promise.all(Object.entries(f.options).filter(([k])=>k!=='out').map(async([k,path])=>[k,await readFile(path)])));
  const result=await packageSubmission(f.options);
  assert.equal(result.status,'packaged');assert.equal(result.files,11);
  const verified=await verifySubmission(f.options.out);
  assert.equal(verified.status,'verified');assert.equal(verified.changed_count,1);
  assert.equal(verified.flutter_evidence,'bound_to_inputs');
  for(const item of result.manifest.files){
    const data=await readFile(join(f.options.out,item.path));
    assert.equal(item.bytes,data.length);assert.equal(item.sha256,sha256(data));
    if(before[item.role])assert.deepEqual(data,before[item.role]);
  }
  for(const [role,data] of Object.entries(before))assert.deepEqual(await readFile(f.options[role]),data);
}));

test('Flutter evidence must bind exact source, fixed, log and generated artifact hash',()=>withFixture(async f=>{
  const inputs={sourceText:f.sourceText,fixedText:f.fixedText,logText:f.logText};
  assert.equal(verifyFlutterEvidence(f.evidence,inputs).status,'bound_to_inputs');
  for(const [field,value] of [['source_sha256',hashText('changed')],['target_sha256',hashText('changed')],['log_sha256',hashText('changed')],['generated_sha256','not-a-sha']]){
    assert.throws(()=>verifyFlutterEvidence({...f.evidence,[field]:value},inputs),/hash/i);
  }
  const missingLog=structuredClone(f.evidence);delete missingLog.log_sha256;
  assert.throws(()=>verifyFlutterEvidence(missingLog,inputs),/log hash/i);
  assert.throws(()=>verifyFlutterEvidence(f.evidence,{...inputs,fixedText:f.fixedText+'\n'}),/target hash/i);
}));

test('Flutter evidence cannot fake a passed command sequence or exit code',()=>withFixture(async f=>{
  const inputs={sourceText:f.sourceText,fixedText:f.fixedText,logText:f.logText};
  for(const mutate of [
    e=>e.status='running',
    e=>e.commands.pop(),
    e=>e.commands[2].command='echo flutter gen-l10n',
    e=>e.commands[1].exit_code='0',
    e=>e.commands[0].exit_code=1,
    e=>e.commands.reverse(),
    e=>e.commands[2].duration_ms=-1,
    e=>e.finished_at='invalid',
    e=>e.finished_at='2026-10-29T00:00:00Z',
  ]){
    const e=structuredClone(f.evidence);mutate(e);
    assert.throws(()=>verifyFlutterEvidence(e,inputs));
  }
  const noMarker=f.logText.replace('$ flutter gen-l10n','not-the-command');
  assert.throws(()=>verifyFlutterEvidence({...f.evidence,log_sha256:hashText(noMarker)},{...inputs,logText:noMarker}),/marker/i);
}));

test('stale Flutter evidence blocks packaging before any output is created',()=>withFixture(async f=>{
  await writeFile(f.options.fixed,f.fixedText+'\n');
  await assert.rejects(packageSubmission(f.options),/target hash/i);
  await assert.rejects(lstat(f.options.out),{code:'ENOENT'});
}));

test('preflight is recomputed and unapproved changes cannot be packaged',()=>withFixture(async f=>{
  await writeFile(f.options.reviews,stringify({schema_version:'1.0',target_locale:'kk',decisions:[]}));
  await assert.rejects(packageSubmission(f.options),/preflight failed.*human approval/i);
  await assert.rejects(lstat(f.options.out),{code:'ENOENT'});
}));

test('conflicting original duplicate remains a release blocker',()=>withFixture(async f=>{
  await writeFile(f.options.originalTarget,'{"@@locale":"kk","syntheticButton":"First {item}","syntheticButton":"Old {item}"}');
  await assert.rejects(packageSubmission(f.options),/conflicting key/i);
}));

test('missing input and invalid UTF-8 fail without creating a package',()=>withFixture(async f=>{
  await unlink(f.options.flutterLog);
  await assert.rejects(packageSubmission(f.options),{code:'ENOENT'});
  await writeFile(f.options.flutterLog,f.logText);
  await writeFile(f.options.methodology,Buffer.from([0xff]));
  await assert.rejects(packageSubmission(f.options),/Invalid UTF-8/i);
  await assert.rejects(lstat(f.options.out),{code:'ENOENT'});
}));

test('existing output is refused and left untouched',()=>withFixture(async f=>{
  await mkdir(f.options.out);
  const marker=join(f.options.out,'keep.txt');await writeFile(marker,'keep');
  await assert.rejects(packageSubmission(f.options),/already exists/i);
  assert.equal(await readFile(marker,'utf8'),'keep');
}));

test('malformed glossary, missing HTML body and empty methodology are refused',()=>withFixture(async f=>{
  for(const [role,value] of [
    ['glossary','ru,kk,en,comment\nwrong,columns\n'],
    ['glossary','ru,kk,en,comment\na,b,c,"unclosed\n'],
    ['glossary','ru,kk,en,comment\na,,c,comment\n'],
    ['html','<!doctype html><html>no body</html>'],
    ['methodology','   \n'],
  ]){
    await writeFile(f.options[role],value);
    await assert.rejects(packageSubmission(f.options));
    await writeFile(f.options[role],f.values[role]);
  }
}));

test('tampered file is rejected even when it is still valid JSON',()=>withFixture(async f=>{
  await packageSubmission(f.options);
  await writeFile(join(f.options.out,'report.json'),'[]\n');
  await assert.rejects(verifySubmission(f.options.out),/checksum mismatch/i);
}));

test('missing artifact or manifest cannot be mistaken for a complete package',()=>withFixture(async f=>{
  await packageSubmission(f.options);
  const path=join(f.options.out,'flutter','flutter.log');await unlink(path);
  await assert.rejects(verifySubmission(f.options.out),{code:'ENOENT'});
  await unlink(join(f.options.out,'manifest.json'));
  await assert.rejects(verifySubmission(f.options.out),{code:'ENOENT'});
}));

test('missing required role, duplicate role and traversal path are rejected',()=>withFixture(async f=>{
  await packageSubmission(f.options);const original=await manifest(f.options.out);
  for(const change of [
    m=>m.files=m.files.filter(x=>x.role!=='source'),
    m=>m.files.push(m.files[0]),
    m=>m.files[0].path='../outside.arb',
    m=>m.files[0].path='C:\\outside.arb',
    m=>m.files[0].path='source/../../outside.arb',
    m=>m.checks.preflight='skipped'
  ]){
    const value=structuredClone(original);change(value);
    await rewriteManifest(f.options.out,value);
    await assert.rejects(verifySubmission(f.options.out));
  }
}));

test('unlisted files are rejected',()=>withFixture(async f=>{
  await packageSubmission(f.options);
  await writeFile(join(f.options.out,'unlisted-private-file.txt'),'must not travel unnoticed');
  await assert.rejects(verifySubmission(f.options.out),/unlisted files/i);
}));

test('recomputed preflight detects rewritten stored status despite a valid checksum',()=>withFixture(async f=>{
  await packageSubmission(f.options);const m=await manifest(f.options.out);
  const entry=m.files.find(x=>x.role==='preflight');
  const value=JSON.parse(await readFile(join(f.options.out,entry.path),'utf8'));value.changed_count=999;
  const bytes=Buffer.from(stringify(value));
  await writeFile(join(f.options.out,entry.path),bytes);entry.bytes=bytes.length;entry.sha256=sha256(bytes);
  await rewriteManifest(f.options.out,m);
  await assert.rejects(verifySubmission(f.options.out),/preflight does not match/i);
}));

test('rewritten evidence with updated checksum still fails semantic validation',()=>withFixture(async f=>{
  await packageSubmission(f.options);const m=await manifest(f.options.out);
  const entry=m.files.find(x=>x.role==='flutterEvidence');
  const e=JSON.parse(await readFile(join(f.options.out,entry.path),'utf8'));e.commands[2].exit_code=1;
  const bytes=Buffer.from(stringify(e));
  await writeFile(join(f.options.out,entry.path),bytes);entry.bytes=bytes.length;entry.sha256=sha256(bytes);
  await rewriteManifest(f.options.out,m);
  await assert.rejects(verifySubmission(f.options.out),/invalid command result/i);
}));

test('symlink escape is rejected where filesystem supports symlinks',async t=>withFixture(async f=>{
  await packageSubmission(f.options);
  const target=join(f.options.out,'report.json');await unlink(target);
  try{await symlink(f.options.report,target,'file');}
  catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Sandbox/filesystem does not permit symlinks');return;}throw error;}
  await assert.rejects(verifySubmission(f.options.out),/Symbolic links/i);
}));

test('CLI creates and verifies package, with nonzero result on invalid usage',()=>withFixture(async f=>{
  const script=fileURLToPath(new URL('../scripts/package-submission.mjs',import.meta.url));
  const flags={source:'source',originalTarget:'original-target',fixed:'fixed',report:'report',reviews:'reviews',
    glossary:'glossary',html:'html',methodology:'methodology',flutterEvidence:'flutter-evidence',flutterLog:'flutter-log',out:'out'};
  const params=Object.entries(flags).flatMap(([key,flag])=>['--'+flag,f.options[key]]);
  const create=spawnSync(process.execPath,[script,...params],{encoding:'utf8',timeout:20000});
  assert.equal(create.status,0,create.stderr);
  const verify=spawnSync(process.execPath,[script,'--verify',f.options.out],{encoding:'utf8',timeout:20000});
  assert.equal(verify.status,0,verify.stderr);assert.equal(JSON.parse(verify.stdout).status,'verified');
  const invalid=spawnSync(process.execPath,[script,'--verify',f.options.out,'--out',join(f.dir,'another')],{encoding:'utf8',timeout:20000});
  assert.equal(invalid.status,1);assert.match(invalid.stderr,/cannot be combined/);
}));


test('explicit duplicate resolutions are preserved and checked again after packaging',()=>withFixture(async f=>{
  const originalText='{"@@locale":"kk","syntheticButton":"First {item}","syntheticButton":"Old {item}"}';
  await writeFile(f.options.originalTarget,originalText);
  const reviews=JSON.parse(await readFile(f.options.reviews,'utf8'));
  reviews.decisions[0].entry_id='syntheticButton#2';
  await writeFile(f.options.reviews,stringify(reviews));
  const resolutions={schema_version:'1.0',source_sha256:hashText(f.sourceText),original_target_sha256:hashText(originalText),decisions:[{
    key:'syntheticButton',occurrence:2,chosen_hash:hashText('Old {item}'),reviewer:'TEST_ONLY',reviewed_at:'2026-10-30T00:00:00Z',reviewed_by_human:true
  }]};
  f.options.resolutions=join(f.dir,'resolutions.input');
  await writeFile(f.options.resolutions,stringify(resolutions));
  const result=await packageSubmission(f.options);
  assert.equal(result.manifest.files.find(x=>x.role==='resolutions').path,'resolutions.json');
  assert.equal((await verifySubmission(f.options.out)).status,'verified');
  await writeFile(join(f.options.out,'resolutions.json'),'{}');
  await assert.rejects(verifySubmission(f.options.out),/checksum mismatch/);
}));


test('explicit offline Flutter commands bind the exact real command log',()=>withFixture(async f=>{
  const evidence=structuredClone(f.evidence);
  const commands=['flutter --no-version-check --version','flutter --no-version-check pub get --offline','flutter --no-version-check gen-l10n'];
  evidence.commands=commands.map(command=>({command,exit_code:0,duration_ms:1}));
  const logText=commands.map(command=>'\n$ '+command+'\nTEST_ONLY offline output\n').join('');
  evidence.log_sha256=hashText(logText);
  assert.equal(verifyFlutterEvidence(evidence,{sourceText:f.sourceText,fixedText:f.fixedText,logText}).status,'bound_to_inputs');
  assert.throws(()=>verifyFlutterEvidence(evidence,{sourceText:f.sourceText,fixedText:f.fixedText,logText:f.logText}),/marker|hash/i);
}));
