import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPipeline, assertPipelineConfig } from '../src/pipeline.mjs';
import { hashText } from '../src/contracts.mjs';

const hashUrl=new URL('../src/contracts.mjs',import.meta.url).href;
const arbUrl=new URL('../src/arb-audit.mjs',import.meta.url).href;
const cli=fileURLToPath(new URL('../scripts/run-pipeline.mjs',import.meta.url));
const adapterSource=[
  "import {readFile,writeFile,symlink} from 'node:fs/promises';",
  "import {hashText} from "+JSON.stringify(hashUrl)+";",
  "import {inspectArb} from "+JSON.stringify(arbUrl)+";",
  "const stage=process.argv[2], a={};for(let i=3;i<process.argv.length;i+=2)a[process.argv[i].slice(2)]=process.argv[i+1];",
  "const read=async p=>JSON.parse(await readFile(p,'utf8'));",
  "if(a.literal) console.log(a.literal);",
  "if(a.behavior==='fail'){console.error('intentional stage failure');process.exit(7);}",
  "if(a.behavior==='sleep') await new Promise(resolve=>setTimeout(resolve,30000));",
  "if(a.behavior==='invalid'){await writeFile(a.out,'{}');process.exit(0);}",
  "if(a.behavior==='symlink'){await symlink(a.source,a.out,'file');process.exit(0);}",
  "if(stage==='normalize'){",
  " const s=inspectArb(await readFile(a.source,'utf8')),t=inspectArb(await readFile(a.target,'utf8'));",
  " let entries=[...s.strings].flatMap(([key,source])=>{const found=t.entries.filter(e=>e.key===key);return(found.length?found:[{text:null,occurrence:0}]).map(({text:target,occurrence})=>({key,entry_id:encodeURIComponent(key)+'#'+occurrence,occurrence,source,target,source_hash:hashText(source),target_hash:hashText(target),context:{}}));});",
  " if(a.behavior==='omit')entries=entries.slice(1);",
  " if(a.behavior==='mutate')await writeFile(a.source,'{}');",
  " await writeFile(a.out,JSON.stringify({schema_version:'1.0',source_locale:s.metadata.get('@@locale'),target_locale:t.metadata.get('@@locale'),entries}));",
  "}else if(stage==='core'||stage==='language'){",
  " if(a.behavior==='mutate-bundle')await writeFile(a.bundle,'{}');",
  " let findings=[];",
  " if(a.behavior==='two-observations'){const e=(await read(a.bundle)).entries[0];const f={key:e.key,issue_type:'orthography',severity:'low',source:e.source,target:e.target,evidence:'Synthetic first observation',suggestion:'First proposal',confidence:0.7,reviewed_by_human:false};findings=[f,{...f,evidence:'Synthetic second observation',suggestion:'Second proposal'}];}",
  " if(a.behavior==='fake-human'){const e=(await read(a.bundle)).entries[0];findings=[{key:e.key,issue_type:'same_as_source',severity:'low',source:e.source,target:e.target,evidence:'unit test only',suggestion:'',confidence:0.5,reviewed_by_human:true}];}",
  " await writeFile(a.out,JSON.stringify(findings));",
  "}else if(stage==='render'){await writeFile(a.out,'<!doctype html><html><body>UNIT TEST</body></html>');}",
  "else if(stage==='export'){await writeFile(a.out,JSON.stringify(await read(a.target)));if(a.resolutions)console.log('RESOLUTIONS_RECEIVED');}"
].join('\n');

async function harness(fn,{exporter=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'locqa pipeline '));
 try{
  const source=join(dir,'source with spaces & symbols.arb'),target=join(dir,'target.arb'),glossary=join(dir,'glossary.csv'),configPath=join(dir,'pipeline.json'),script=join(dir,'test adapter.mjs');
  await writeFile(source,JSON.stringify({'@@locale':'ru',demoLabel:'Hello {name}'}));
  await writeFile(target,JSON.stringify({'@@locale':'kk',demoLabel:'Welcome {name}'}));
  await writeFile(glossary,'ru,kk,en,comment\n');
  await writeFile(script,adapterSource);
  const command=(stage,output)=>({executable:process.execPath,argv:[script,stage,'--source','{source}','--target','{target}','--bundle','{bundle}','--out',output]});
  const config={schema_version:'1.0',mode:'synthetic',working_directory:'.',timeout_ms:30000,stages:{
   normalize:command('normalize','{bundle}'),core:command('core','{core_report}'),language:command('language','{language_report}'),render:command('render','{html}')
  }};
  if(exporter)config.stages.export=command('export','{fixed}');
  const writeConfig=()=>writeFile(configPath,JSON.stringify(config));
  await writeConfig();
  const input={configPath,source,target,glossary,out:join(dir,'new run'),synthetic:true};
  await fn({dir,source,target,glossary,configPath,script,config,input,writeConfig});
 }finally{await rm(dir,{recursive:true,force:true});}
}

test('runs actual child processes with space paths, contracts, evidence hashes and no automatic export',async()=>{
 await harness(async({input,source})=>{
  const original=await readFile(source,'utf8');
  const result=await runPipeline(input);
  assert.equal(result.evidence.status,'analysis_passed');
  assert.equal(result.evidence.scope,'synthetic_fixture_playback');
  assert.equal(result.evidence.flutter_verified,false);
  assert.deepEqual(result.evidence.stages.map(s=>s.name),['normalize','core','language','render']);
  for(const stage of result.evidence.stages){assert.equal(stage.exit_code,0);assert.match(stage.stdout_sha256,/^[a-f0-9]{64}$/);}
  assert.match(result.evidence.export_skipped,/No human/);
  await assert.rejects(access(join(result.directory,'intl_fixed.arb')));
  assert.equal(await readFile(source,'utf8'),original);
  assert.deepEqual(JSON.parse(await readFile(join(result.directory,'report.json'),'utf8')),[]);
 });
});

test('synthetic adapters require explicit flag and production cannot silently use synthetic mode',async()=>{
 await harness(async({input,config,writeConfig})=>{
  await assert.rejects(runPipeline({...input,synthetic:false}),/explicit --synthetic/);
  config.mode='production';await writeConfig();
  await assert.rejects(runPipeline(input),/requires a config/);
 });
});

test('pipeline records explicit same-text consolidation and binds the complete audit hash',async()=>{
 await harness(async({input,config,writeConfig})=>{
  config.stages.language.argv.push('--behavior','two-observations');await writeConfig();
  const result=await runPipeline({...input,combineSameText:true});
  assert.equal(result.evidence.status,'analysis_passed');
  assert.equal(result.evidence.merge_policy,'combine_same_text_observations');
  const audit=await readFile(join(result.directory,'merge-audit.json'),'utf8');
  assert.equal(hashText(audit),result.evidence.outputs.merge_audit.sha256);
  assert.equal(JSON.parse(audit).combinations[0].variants.length,2);
  const report=JSON.parse(await readFile(join(result.directory,'report.json'),'utf8'));
  assert.equal(report[0].suggestion,'');
  assert.equal(report[0].reviewed_by_human,false);
 });
});

test('rejects malformed config and unknown placeholders before starting modules',async()=>{
 await harness(async({config})=>{
  assert.throws(()=>assertPipelineConfig({...config,unknown:true}),/config/);
  const broken=structuredClone(config);delete broken.stages.language;
  assert.throws(()=>assertPipelineConfig(broken),/config/);
  broken.stages.language=config.stages.language;broken.stages.core.argv.push('{secret_token}');
  assert.throws(()=>assertPipelineConfig(broken),/Unknown pipeline token/);
  const nullArg=structuredClone(config);nullArg.stages.core.argv.push('\0');
  assert.throws(()=>assertPipelineConfig(nullArg),/NUL/);
 });
});

test('child failure stops later stages and preserves stderr plus failed evidence',async()=>{
 await harness(async({input,config,writeConfig})=>{
  config.stages.core.argv.push('--behavior','fail');await writeConfig();
  await assert.rejects(runPipeline(input),/Stage core failed with exit code 7/);
  const evidence=JSON.parse(await readFile(join(input.out,'pipeline-evidence.json'),'utf8'));
  assert.equal(evidence.status,'failed');
  assert.deepEqual(evidence.stages.map(s=>s.name),['normalize','core']);
  assert.match(await readFile(join(input.out,'core.stderr.log'),'utf8'),/intentional stage failure/);
  await assert.rejects(access(join(input.out,'report.html')));
 });
});

test('invalid module output and omitted entries fail before downstream consumers',async()=>{
 for(const [stage,behavior,pattern] of [['core','invalid',/report:/],['normalize','omit',/omitted input/]]){
  await harness(async({input,config,writeConfig})=>{
   config.stages[stage].argv.push('--behavior',behavior);await writeConfig();
   await assert.rejects(runPipeline(input),pattern);
   const evidence=JSON.parse(await readFile(join(input.out,'pipeline-evidence.json'),'utf8'));
   assert.equal(evidence.status,'failed');
   assert.equal(evidence.stages.at(-1).name,stage);
  });
 }
});

test('adapters cannot claim native review or mutate immutable input snapshots',async()=>{
 for(const [stage,behavior,pattern] of [['core','fake-human',/cannot claim human review/],['normalize','mutate',/immutable input snapshot/],['core','mutate-bundle',/earlier stage output/]]){
  await harness(async({input,source,config,writeConfig})=>{
   const original=await readFile(source,'utf8');
   config.stages[stage].argv.push('--behavior',behavior);await writeConfig();
   await assert.rejects(runPipeline(input),pattern);
   assert.equal(await readFile(source,'utf8'),original);
  });
 }
});

test('arguments containing shell syntax remain one literal argument',async()=>{
 await harness(async({input,config,writeConfig,dir})=>{
  const literal='hello; echo INJECTION > SHOULD_NOT_EXIST & $(echo surprise)';
  config.stages.core.argv.push('--literal',literal);await writeConfig();
  const result=await runPipeline(input);
  assert.equal((await readFile(join(result.directory,'core.stdout.log'),'utf8')).trim(),literal);
  await assert.rejects(access(join(dir,'SHOULD_NOT_EXIST')));
  assert.ok(result.evidence.stages[1].argv.includes(literal));
 });
});

test('timeouts stop the pipeline and are recorded without a successful status',async()=>{
 await harness(async({input,config,writeConfig})=>{
  config.stages.normalize.timeout_ms=150;
  config.stages.normalize.argv.push('--behavior','sleep');await writeConfig();
  const start=Date.now();
  await assert.rejects(runPipeline(input),/timed out/);
  assert.ok(Date.now()-start<5000);
  const evidence=JSON.parse(await readFile(join(input.out,'pipeline-evidence.json'),'utf8'));
  assert.equal(evidence.stages[0].timed_out,true);
  assert.equal(evidence.status,'failed');
 });
});

test('existing run directory is never reused or overwritten',async()=>{
 await harness(async({input})=>{
  await mkdir(input.out);
  await writeFile(join(input.out,'keep.txt'),'KEEP');
  await assert.rejects(runPipeline(input),/EEXIST/);
  assert.equal(await readFile(join(input.out,'keep.txt'),'utf8'),'KEEP');
 });
});

test('missing adapter fails clearly and never falls back to fixtures',async()=>{
 await harness(async({input,config,writeConfig})=>{
  config.mode='production';config.stages.normalize.argv[0]='missing-real-adapter.mjs';await writeConfig();
  await assert.rejects(runPipeline({...input,synthetic:false}),/Stage normalize failed/);
  const evidence=JSON.parse(await readFile(join(input.out,'pipeline-evidence.json'),'utf8'));
  assert.equal(evidence.mode,'production');
  assert.equal(evidence.status,'failed');
  assert.equal(evidence.stages.length,1);
 });
});

test('explicit review file enables export followed by independent preflight',async()=>{
 await harness(async({input,dir})=>{
  const reviews=join(dir,'reviews.json');
  await writeFile(reviews,JSON.stringify({schema_version:'1.0',target_locale:'kk',decisions:[]}));
  const result=await runPipeline({...input,reviews});
  assert.equal(result.evidence.status,'export_preflight_passed');
  assert.equal(result.evidence.stages.at(-1).name,'export');
  assert.equal(result.evidence.flutter_verified,false);
  assert.ok(result.evidence.outputs.fixed.sha256);
 },{exporter:true});
});

test('reviews cannot be silently ignored when export adapter is absent',async()=>{
 await harness(async({input,dir})=>{
  const reviews=join(dir,'reviews.json');await writeFile(reviews,'{}');
  await assert.rejects(runPipeline({...input,reviews}),/no export adapter/);
 });
});

test('CLI executes the same pipeline and returns a failing exit for missing arguments',async()=>{
 await harness(async({input})=>{
  const result=spawnSync(process.execPath,[cli,'--config',input.configPath,'--source',input.source,'--target',input.target,'--glossary',input.glossary,'--out',input.out,'--synthetic'],{encoding:'utf8',shell:false});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/analysis_passed/);
  const missing=spawnSync(process.execPath,[cli],{encoding:'utf8',shell:false});
  assert.equal(missing.status,1);assert.match(missing.stderr,/Missing --config/);
 });
});


test('explicit duplicate resolutions are snapshot-bound and passed to exporter and release gate',async()=>{
 await harness(async({input,dir,source,target,config,writeConfig})=>{
  const rawTarget='{"@@locale":"kk","demoLabel":"First {name}","demoLabel":"Welcome {name}"}';
  await writeFile(target,rawTarget);
  const reviews=join(dir,'reviews.json'),resolutions=join(dir,'resolutions.json');
  await writeFile(reviews,JSON.stringify({schema_version:'1.0',target_locale:'kk',decisions:[]}));
  const data={schema_version:'1.0',source_sha256:hashText(await readFile(source,'utf8')),original_target_sha256:hashText(rawTarget),decisions:[{key:'demoLabel',occurrence:2,chosen_hash:hashText('Welcome {name}'),reviewer:'TEST_ONLY',reviewed_at:'2026-10-30T00:00:00Z',reviewed_by_human:true}]};
  await writeFile(resolutions,JSON.stringify(data));
  config.stages.export.optional_argv={resolutions:['--resolutions','{resolutions}']};await writeConfig();
  const result=await runPipeline({...input,reviews,resolutions});
  assert.equal(result.evidence.status,'export_preflight_passed');
  assert.ok(result.evidence.inputs.resolutions.sha256);
  assert.match(await readFile(join(input.out,'export.stdout.log'),'utf8'),/RESOLUTIONS_RECEIVED/);
  const preflight=JSON.parse(await readFile(join(input.out,'export-preflight.json'),'utf8'));
  assert.equal(preflight.resolved_duplicate_count,1);
 },{exporter:true});
});

test('optional resolution argv is omitted explicitly and stale resolutions fail before adapters',async()=>{
 await harness(async({input,dir,config,writeConfig})=>{
  config.stages.core.optional_argv={resolutions:['--resolutions','{resolutions}']};await writeConfig();
  const result=await runPipeline(input);
  assert.equal(result.evidence.stages[1].argv.includes('--resolutions'),false);
  const resolutions=join(dir,'stale-resolutions.json');
  await writeFile(resolutions,JSON.stringify({schema_version:'1.0',source_sha256:'0'.repeat(64),original_target_sha256:'0'.repeat(64),decisions:[]}));
  const other=join(dir,'should-not-exist');
  await assert.rejects(runPipeline({...input,out:other,resolutions}),/refer to different/);
  await assert.rejects(access(other));
 });
});
