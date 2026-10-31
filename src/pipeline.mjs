import { readFile, writeFile, mkdir, stat, lstat, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { assertContract } from './contracts.mjs';
import { inspectArb } from './arb-audit.mjs';
import { mergeReports } from './report-merge.mjs';
import { checkRelease } from './release-gate.mjs';
import { verifyResolutions } from './duplicate-resolutions.mjs';

const schema = JSON.parse(readFileSync(new URL('../contracts/pipeline.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);
const tokens = new Set(['source','target','glossary','bundle','core_report','language_report','report','reviews','resolutions','fixed','html']);
const hash = data => createHash('sha256').update(data).digest('hex');
const json = data => JSON.stringify(data, null, 2) + '\n';

export function assertPipelineConfig(config) {
  if (!validate(config)) throw new Error('pipeline config: ' + ajv.errorsText(validate.errors));
  for (const [name,stage] of Object.entries(config.stages)) {
    if (!stage.executable.trim() || stage.executable.includes('\0')) throw new Error('Invalid executable for ' + name);
    if (/[{}]/.test(stage.executable)) throw new Error('Executable cannot contain template tokens');
    for (const arg of [...stage.argv,...Object.values(stage.optional_argv??{}).flat()]) {
      if (arg.includes('\0')) throw new Error('NUL argument in ' + name);
      for (const match of arg.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!tokens.has(match[1])) throw new Error('Unknown pipeline token: ' + match[1]);
    }
  }
  return config;
}
function substitute(arg, paths) {
  return arg.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (!paths[name]) throw new Error('Unavailable pipeline token: ' + name);
    return paths[name];
  });
}
async function regularOutput(file, directory) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Adapter output must be a regular, non-symlink file: ' + file);
  const root = await realpath(directory), actual = await realpath(file), rel = relative(root, actual);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Adapter output escapes run directory: ' + file);
  return readFile(file);
}
function matchBundle(bundle, source, target) {
  assertContract('bundle', bundle);
  if (source.duplicates.some(d => d.conflicting)) throw new Error('Conflicting source keys require explicit resolution before normalization');
  for (const [field, arb] of [['source_locale',source],['target_locale',target]]) {
    const declared = arb.metadata.get('@@locale');
    if (typeof declared === 'string' && Intl.getCanonicalLocales(declared.replaceAll('_','-'))[0] !== Intl.getCanonicalLocales(bundle[field].replaceAll('_','-'))[0]) throw new Error('Bundle ' + field + ' does not match ARB');
  }
  const expected = new Map();
  for (const [key,text] of source.strings) {
    const occurrences = target.entries.filter(e => e.key === key);
    if (!occurrences.length) expected.set(encodeURIComponent(key)+'#0',{key,source:text,target:null});
    for (const entry of occurrences) expected.set(encodeURIComponent(key)+'#'+entry.occurrence,{key,source:text,target:entry.text});
  }
  for (const entry of bundle.entries) {
    const e = expected.get(entry.entry_id);
    if (!e || e.key !== entry.key || e.source !== entry.source || e.target !== entry.target) throw new Error('Bundle does not match exact input occurrence: ' + entry.entry_id);
    expected.delete(entry.entry_id);
  }
  if (expected.size) throw new Error('Normalizer omitted input entries: ' + [...expected.keys()].join(', '));
}
function matchReport(report, source, target) {
  assertContract('report', report);
  for (const f of report) {
    if (f.reviewed_by_human) throw new Error('Machine stage cannot claim human review: ' + f.key);
    if (!source.strings.has(f.key) || source.strings.get(f.key) !== f.source) throw new Error('Finding source does not match input: ' + f.key);
    const values = target.entries.filter(e => e.key === f.key).map(e => e.text);
    if (!(values.length ? values : ['']).includes(f.target)) throw new Error('Finding target does not match input: ' + f.key);
  }
}
async function execute(stage, cwd, paths, timeoutMs) {
  const optional=Object.entries(stage.optional_argv??{}).flatMap(([input,argv])=>paths[input]?argv:[]);
  const argv = [...stage.argv,...optional].map(arg => substitute(arg,paths));
  const started = Date.now();
  const result = await new Promise(resolveRun => {
    let stdout='', stderr='', spawnError=null, timedOut=false, settled=false, stdoutTruncated=false, stderrTruncated=false;
    const child = spawn(stage.executable, argv, { cwd, shell:false, windowsHide:true, stdio:['ignore','pipe','pipe'] });
    const capture = (old,data) => (old + data.toString('utf8')).slice(-262144);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {stdoutTruncated ||= stdout.length+data.length>262144;stdout=capture(stdout,data);});
    child.stderr.on('data', data => {stderrTruncated ||= stderr.length+data.length>262144;stderr=capture(stderr,data);});
    const finish = code => {
      if (settled) return;
      settled=true; clearTimeout(timer); clearTimeout(killGuard);
      resolveRun({executable:stage.executable,argv,exit_code:code,spawn_error:spawnError,timed_out:timedOut,stdout_truncated:stdoutTruncated,stderr_truncated:stderrTruncated,stdout,stderr,duration_ms:Date.now()-started});
    };
    let killGuard;
    const timer=setTimeout(()=>{
      timedOut=true;
      if (process.platform === 'win32') {
        const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
        killer.on('error',()=>child.kill('SIGKILL'));
        killer.on('close',code=>{ if(code!==0) child.kill('SIGKILL'); });
      } else child.kill('SIGKILL');
      killGuard=setTimeout(()=>{child.kill('SIGKILL');finish(null);},2000);
    },timeoutMs);
    child.on('error', error=>{spawnError=error.message;finish(null);});
    child.on('close', finish);
  });
  return result;
}

/** Trusted adapter commands are supplied by the team; ARB text is never shell code. */
export async function runPipeline({configPath,source:sourcePath,target:targetPath,glossary:glossaryPath,reviews:reviewsPath,resolutions:resolutionsPath,out,synthetic=false,combineSameText=false}) {
  const configBytes=await readFile(configPath);
  const config=assertPipelineConfig(JSON.parse(configBytes.toString('utf8')));
  if (config.mode === 'synthetic' && !synthetic) throw new Error('Synthetic fixture adapters require explicit --synthetic');
  if (config.mode === 'production' && synthetic) throw new Error('--synthetic requires a config explicitly marked synthetic');
  if (reviewsPath && !config.stages.export) throw new Error('Reviews supplied but no export adapter configured');
  const cwd=resolve(dirname(resolve(configPath)),config.working_directory);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Adapter working_directory must be a directory');
  const inputs = {source:sourcePath,target:targetPath,glossary:glossaryPath,...(reviewsPath?{reviews:reviewsPath}:{}),...(resolutionsPath?{resolutions:resolutionsPath}:{})};
  const bytes = Object.fromEntries(await Promise.all(Object.entries(inputs).map(async([name,path])=>[name,await readFile(path)])));
  const source=inspectArb(bytes.source.toString('utf8')), target=inspectArb(bytes.target.toString('utf8'));
  const reviews=reviewsPath?assertContract('reviews',JSON.parse(bytes.reviews.toString('utf8'))):null;
  const resolutions=resolutionsPath?JSON.parse(bytes.resolutions.toString('utf8')):undefined;
  verifyResolutions(resolutions,bytes.source.toString('utf8'),bytes.target.toString('utf8'),target);
  const directory=resolve(out);
  await mkdir(dirname(directory),{recursive:true});
  await mkdir(directory,{recursive:false});
  await mkdir(join(directory,'inputs'));
  const paths={
    source:join(directory,'inputs','source.arb'),target:join(directory,'inputs','target.arb'),
    glossary:join(directory,'inputs','glossary.csv'),
    bundle:join(directory,'bundle.json'),core_report:join(directory,'core-report.json'),
    language_report:join(directory,'language-report.json'),report:join(directory,'report.json'),
    html:join(directory,'report.html'),fixed:join(directory,'intl_fixed.arb'),
    ...(reviewsPath?{reviews:join(directory,'inputs','reviews.json')}:{}),
    ...(resolutionsPath?{resolutions:join(directory,'inputs','duplicate-resolutions.json')}:{})
  };
  for (const [name,data] of Object.entries(bytes)) await writeFile(paths[name],data,{flag:'wx'});
  const evidence={
    schema_version:'1.0',status:'running',mode:config.mode,
    scope:config.mode==='synthetic'?'synthetic_fixture_playback':'module_pipeline',
    warning:config.mode==='synthetic'?'Prepared fixture playback; detector quality is not measured.':null,
    config_sha256:hash(configBytes),
    inputs:Object.fromEntries(Object.entries(bytes).map(([name,data])=>[name,{path:resolve(inputs[name]),sha256:hash(data)}])),
    started_at:new Date().toISOString(),stages:[],outputs:{},flutter_verified:false
  };
  const evidencePath=join(directory,'pipeline-evidence.json');
  const save=()=>writeFile(evidencePath,json(evidence));
  async function unchangedInputs() {
    for (const [name,data] of Object.entries(bytes)) {
      const current=await regularOutput(paths[name],directory);
      if (hash(current)!==hash(data)) throw new Error('Adapter modified immutable input snapshot: ' + name);
    }
  }
  async function stage(name) {
    const spec=config.stages[name];
    const result=await execute(spec,cwd,paths,spec.timeout_ms??config.timeout_ms??120000);
    const stdoutPath=join(directory,name+'.stdout.log'),stderrPath=join(directory,name+'.stderr.log');
    await writeFile(stdoutPath,result.stdout);await writeFile(stderrPath,result.stderr);
    const {stdout,stderr,...details}=result;
    evidence.stages.push({name,...details,stdout_log:relative(directory,stdoutPath),stderr_log:relative(directory,stderrPath),stdout_sha256:hash(stdout),stderr_sha256:hash(stderr)});
    await save();
    await unchangedInputs();
    for (const [artifact,record] of Object.entries(evidence.outputs)) {
      if (hash(await regularOutput(paths[artifact],directory)) !== record.sha256) throw new Error('Adapter changed an earlier stage output: ' + artifact);
    }
    if (result.spawn_error) throw new Error('Cannot start '+name+' adapter: '+result.spawn_error);
    if (result.timed_out) throw new Error('Stage '+name+' timed out; see '+stderrPath);
    if (result.exit_code!==0) throw new Error('Stage '+name+' failed with exit code '+result.exit_code+'; see '+stderrPath);
  }
  async function readOutput(name,contract) {
    const data=await regularOutput(paths[name],directory);
    evidence.outputs[name]={path:relative(directory,paths[name]),sha256:hash(data),bytes:data.length};
    const value=JSON.parse(data.toString('utf8'));
    return assertContract(contract,value);
  }
  try {
    await save();
    await stage('normalize');
    const bundle=await readOutput('bundle','bundle');matchBundle(bundle,source,target);
    await stage('core');
    const core=await readOutput('core_report','report');matchReport(core,source,target);
    await stage('language');
    const language=await readOutput('language_report','report');matchReport(language,source,target);
    const {report,duplicates,combinations}=mergeReports([core,language],{combineSameText});
    evidence.merge_policy=combineSameText?'combine_same_text_observations':'strict';
    if(combineSameText){
      paths.merge_audit=join(directory,'merge-audit.json');
      const audit=json({policy:evidence.merge_policy,input_reports:['core-report.json','language-report.json'],combinations});
      await writeFile(paths.merge_audit,audit,{flag:'wx'});
      evidence.outputs.merge_audit={path:'merge-audit.json',sha256:hash(audit),bytes:Buffer.byteLength(audit)};
    }
    await writeFile(paths.report,json(report),{flag:'wx'});
    evidence.identical_findings_deduplicated=duplicates;
    await readOutput('report','report');
    await stage('render');
    const html=await regularOutput(paths.html,directory);
    if (!/<html[\s>]/i.test(html.toString('utf8'))||!/<body[\s>]/i.test(html.toString('utf8'))) throw new Error('Renderer must create standalone HTML with html/body elements');
    evidence.outputs.html={path:relative(directory,paths.html),sha256:hash(html),bytes:html.length};
    if (reviews) {
      await stage('export');
      const fixed=await regularOutput(paths.fixed,directory);
      inspectArb(fixed.toString('utf8'));
      const preflight=checkRelease({sourceText:bytes.source.toString('utf8'),originalText:bytes.target.toString('utf8'),fixedText:fixed.toString('utf8'),report,reviews,resolutions});
      await writeFile(join(directory,'export-preflight.json'),json(preflight));
      if (preflight.status!=='preflight_passed') throw new Error('Export failed independent preflight: '+preflight.errors.join('; '));
      evidence.outputs.fixed={path:relative(directory,paths.fixed),sha256:hash(fixed),bytes:fixed.length};
    } else evidence.export_skipped='No human review decisions supplied; corrected ARB was not produced.';
    evidence.status=reviews?'export_preflight_passed':'analysis_passed';
    evidence.finished_at=new Date().toISOString();
    await save();
    return {directory,evidencePath,evidence};
  } catch(error) {
    evidence.status='failed';evidence.error=error.message;evidence.finished_at=new Date().toISOString();await save();
    error.message += '; evidence: '+evidencePath;
    throw error;
  }
}
