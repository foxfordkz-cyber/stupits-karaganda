import { spawn } from 'node:child_process';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args,main,writeJson } from '../src/io.mjs';
import { packageSubmission,verifySubmission } from '../src/submission.mjs';

await main(async()=>{
 const a=args({out:{type:'string'},offline:{type:'boolean'}},['out']);
 const out=resolve(a.out);
 await mkdir(dirname(out),{recursive:true});await mkdir(out,{recursive:false});
 const fixtures=fileURLToPath(new URL('../fixtures/synthetic/',import.meta.url));
 const source=join(fixtures,'flutter-valid/source.arb'),target=join(fixtures,'flutter-valid/target.arb');
 const report=join(out,'report.json'),reviews=join(out,'reviews.json'),html=join(out,'report.html'),methodology=join(out,'methodology.md');
 await writeJson(report,[]);
 await writeJson(reviews,{schema_version:'1.0',target_locale:'kk',decisions:[]});
 await writeFile(html,'<!doctype html><html><body><h1>Synthetic integration validation</h1><p>No detector was run. Zero corrected strings; no human review asserted.</p></body></html>');
 await writeFile(methodology,'# Synthetic integration validation\nThis scenario verifies real Flutter generation and submission packaging on invented clean ARB files. It performs no detection or human translation review, and reports no model quality.\n');
 const evidence={scenario:'synthetic_integration_validation',status:'running',started_at:new Date().toISOString(),corrected_strings:0,detector_executed:false};
 await writeJson(join(out,'integration-evidence.json'),evidence);
 const exitCode=await new Promise(resolveRun=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./flutter-smoke.mjs',import.meta.url)),'--source',source,'--target',target,'--out',join(out,'flutter'),...(a.offline?['--offline']:[])],{shell:false,windowsHide:true,stdio:'inherit'});
  child.on('error',error=>{console.error(error.message);resolveRun(1);});
  child.on('close',code=>resolveRun(code??1));
 });
 if(exitCode!==0){evidence.status='failed';evidence.failure='flutter';await writeJson(join(out,'integration-evidence.json'),evidence);process.exitCode=1;return;}
 try{
  await packageSubmission({source,originalTarget:target,fixed:target,report,reviews,glossary:join(fixtures,'glossary.csv'),html,methodology,flutterEvidence:join(out,'flutter/evidence.json'),flutterLog:join(out,'flutter/flutter.log'),out:join(out,'package')});
  await verifySubmission(join(out,'package'));
  evidence.status='passed';evidence.flutter_verified=true;evidence.package_verified=true;evidence.finished_at=new Date().toISOString();
  await writeJson(join(out,'integration-evidence.json'),evidence);
  console.log('SYNTHETIC INTEGRATION VERIFIED: '+join(out,'integration-evidence.json'));
 }catch(error){
  evidence.status='failed';evidence.failure='packaging';evidence.error=error.message;
  await writeJson(join(out,'integration-evidence.json'),evidence);throw error;
 }
});
