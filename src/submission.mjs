import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { hashText } from './contracts.mjs';
import { checkRelease } from './release-gate.mjs';

const ROLES = Object.freeze({
  source: 'source.arb', originalTarget: 'original-target.arb',
  fixed: 'fixed.arb', report: 'report.json', reviews: 'reviews.json',
  glossary: 'glossary.csv', html: 'report.html', methodology: 'methodology.md',
  flutterEvidence: 'flutter/evidence.json', flutterLog: 'flutter/flutter.log',
});
const OPTIONAL_ROLES = Object.freeze({ resolutions: 'resolutions.json' });
const DIGEST = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const REQUIRED_COMMANDS = [['flutter --version','flutter --no-version-check --version'], ['flutter pub get','flutter pub get --offline','flutter --no-version-check pub get','flutter --no-version-check pub get --offline'], ['flutter gen-l10n','flutter --no-version-check gen-l10n']];
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function text(buffer, role) {
  const value = buffer.toString('utf8');
  if (!Buffer.from(value,'utf8').equals(buffer)) throw new Error('Invalid UTF-8 in ' + role);
  return value;
}
function json(buffer, role) {
  try { return JSON.parse(text(buffer,role)); }
  catch(error) { throw new Error('Invalid JSON in ' + role + ': ' + error.message); }
}
function validTimestamp(value) {
  return typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

export function verifyFlutterEvidence(evidence, { sourceText, fixedText, logText }) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.status !== 'passed') {
    throw new Error('Flutter evidence must have status passed');
  }
  if (!DIGEST.test(evidence.source_sha256 ?? '') || evidence.source_sha256 !== hashText(sourceText)) {
    throw new Error('Flutter evidence source hash does not match packaged source');
  }
  if (!DIGEST.test(evidence.target_sha256 ?? '') || evidence.target_sha256 !== hashText(fixedText)) {
    throw new Error('Flutter evidence target hash does not match packaged fixed ARB');
  }
  if (!validTimestamp(evidence.started_at) || !validTimestamp(evidence.finished_at)
      || Date.parse(evidence.finished_at) < Date.parse(evidence.started_at)) {
    throw new Error('Flutter evidence must contain ordered ISO timestamps');
  }
  if (!Array.isArray(evidence.commands) || evidence.commands.length !== REQUIRED_COMMANDS.length) {
    throw new Error('Flutter evidence must contain all three required commands');
  }
  for (const [index,command] of REQUIRED_COMMANDS.entries()) {
    const entry=evidence.commands[index];
    if (!entry || !command.includes(entry.command) || entry.exit_code !== 0
        || !Number.isFinite(entry.duration_ms) || entry.duration_ms < 0) {
      throw new Error('Flutter evidence has invalid command result: ' + command);
    }
  }
  if (typeof logText !== 'string' || !logText.trim()) throw new Error('Flutter log is empty');
  for (const {command} of evidence.commands) {
    if (!logText.includes('$ ' + command + '\n') && !logText.includes('$ ' + command + '\r\n')) {
      throw new Error('Flutter log is missing command marker: ' + command);
    }
  }
  if (!DIGEST.test(evidence.log_sha256 ?? '') || evidence.log_sha256 !== hashText(logText)) {
    throw new Error('Flutter evidence log hash does not match supplied log');
  }
  if (!DIGEST.test(evidence.generated_sha256 ?? '')) throw new Error('Flutter evidence generated hash is missing or invalid');
  return { status:'bound_to_inputs', source_sha256:evidence.source_sha256, target_sha256:evidence.target_sha256 };
}

function parseCsv(value) {
  const rows=[], row=[]; let field='', quoted=false, afterQuote=false;
  value=value.replace(/^\uFEFF/,'');
  for(let i=0;i<value.length;i++){
    const c=value[i];
    if(quoted){
      if(c === '"'){
        if(value[i+1] === '"'){field+='"';i++;} else {quoted=false;afterQuote=true;}
      }else field+=c;
    }else if(c === ','){row.push(field);field='';afterQuote=false;}
    else if(c === '\n' || c === '\r'){
      if(c === '\r' && value[i+1] === '\n')i++;
      row.push(field);if(row.some(v=>v.length))rows.push([...row]);row.length=0;field='';afterQuote=false;
    }else if(c === '"' && field === '' && !afterQuote){quoted=true;}
    else{
      if(afterQuote || c === '"')throw new Error('Malformed glossary CSV quoting');
      field+=c;
    }
  }
  if(quoted)throw new Error('Unclosed glossary CSV quote');
  if(field.length || row.length || afterQuote){row.push(field);if(row.some(v=>v.length))rows.push([...row]);}
  return rows;
}

function validateSnapshot(buffers) {
  const sourceText=text(buffers.source,'source'), originalText=text(buffers.originalTarget,'originalTarget');
  const fixedText=text(buffers.fixed,'fixed'), report=json(buffers.report,'report'), reviews=json(buffers.reviews,'reviews');
  const resolutions=buffers.resolutions ? json(buffers.resolutions,'resolutions') : undefined;
  const preflight=checkRelease({sourceText,originalText,fixedText,report,reviews,resolutions});
  if(preflight.status !== 'preflight_passed' || preflight.errors?.length) {
    throw new Error('Release preflight failed: ' + (preflight.errors ?? ['invalid preflight result']).join('; '));
  }
  const rows=parseCsv(text(buffers.glossary,'glossary'));
  if(rows[0]?.map(v=>v.trim()).join(',') !== 'ru,kk,en,comment') throw new Error('Glossary header must be ru,kk,en,comment');
  if(rows.some(row=>row.length !== 4))throw new Error('Every glossary CSV row must have four columns');
  if(rows.slice(1).some(row=>row.slice(0,3).some(v=>!v.trim())))throw new Error('Glossary terms ru,kk,en must not be blank');
  const html=text(buffers.html,'html');
  if(!/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html))throw new Error('Standalone HTML report is missing');
  if(!text(buffers.methodology,'methodology').trim())throw new Error('Methodology is empty');
  const flutter=verifyFlutterEvidence(json(buffers.flutterEvidence,'flutterEvidence'),{
    sourceText,fixedText,logText:text(buffers.flutterLog,'flutterLog')
  });
  return {preflight,flutter,targetLocale:reviews.target_locale};
}

function safeRelativePath(value) {
  if(typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.includes(':')
    || value.split('/').some(part=>!part || part === '.' || part === '..')
    || !/^[A-Za-z0-9._/-]+$/.test(value))throw new Error('Unsafe package path: ' + value);
  return value;
}
function within(root, candidate) {
  const rel=relative(root,candidate);
  return rel === '' || (!rel.startsWith('..'+sep) && rel !== '..' && !isAbsolute(rel));
}
async function readPackagedFile(root,path){
  safeRelativePath(path);
  let current=root;
  const parts=path.split('/');
  for(let i=0;i<parts.length;i++){
    current=join(current,parts[i]);
    const info=await lstat(current);
    if(info.isSymbolicLink())throw new Error('Symbolic links are not permitted in package: '+path);
    if(i<parts.length-1 && !info.isDirectory())throw new Error('Package parent is not a directory: '+path);
    if(i===parts.length-1 && !info.isFile())throw new Error('Package artifact is not a regular file: '+path);
  }
  const actual=await realpath(current);
  if(!within(root,actual))throw new Error('Package path escapes directory: '+path);
  return readFile(current);
}
async function inventory(root,dir=root){
  const result=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,entry.name), info=await lstat(path);
    if(info.isSymbolicLink())throw new Error('Symbolic links are not permitted in package');
    if(info.isDirectory())result.push(...await inventory(root,path));
    else if(info.isFile())result.push(relative(root,path).split(sep).join('/'));
    else throw new Error('Unexpected non-regular package entry');
  }
  return result.sort();
}

export async function packageSubmission(options) {
  if(!options || typeof options !== 'object')throw new Error('Package options are required');
  const buffers={};
  for(const role of Object.keys(ROLES)) {
    if(typeof options[role] !== 'string' || !options[role])throw new Error('Missing input artifact: '+role);
    const info=await lstat(options[role]);
    if(!info.isFile())throw new Error('Input must be a regular file: '+role);
    buffers[role]=await readFile(options[role]);
  }
  if(options.resolutions){
    const info=await lstat(options.resolutions);
    if(!info.isFile())throw new Error('Resolutions must be a regular file');
    buffers.resolutions=await readFile(options.resolutions);
  }
  if(typeof options.out !== 'string' || !options.out)throw new Error('Missing output directory');
  const out=resolve(options.out);
  try { await lstat(out); throw new Error('Output directory already exists: '+out); }
  catch(error) { if(error.code !== 'ENOENT')throw error; }
  const snapshot=validateSnapshot(buffers);
  buffers.preflight=Buffer.from(JSON.stringify(snapshot.preflight,null,2)+'\n','utf8');
  const paths={...ROLES,...OPTIONAL_ROLES,preflight:'checks/preflight.json'};
  paths.fixed='intl_'+snapshot.targetLocale+'_fixed.arb';
  safeRelativePath(paths.fixed);
  const files=Object.entries(buffers).map(([role,data])=>({role,path:paths[role],bytes:data.length,sha256:sha256(data)}));
  const manifest={
    schema_version:'1.0',kind:'localization_submission',created_at:new Date().toISOString(),
    target_locale:snapshot.targetLocale,checks:{preflight:'passed',flutter_evidence:'bound_to_inputs'},
    files,
    limitations:[
      'Checksums prove consistency, not provenance or human identity.',
      'Flutter evidence is an attestation from the runner, not a cryptographically signed build.',
      'Package validation does not measure translation quality or hidden-test recall.',
      'Contains private case artifacts; do not publish to a public repository or public CI artifacts.'
    ]
  };
  // Read and validate every input before creating output. All writes use that exact snapshot.
  await mkdir(dirname(out),{recursive:true});
  await mkdir(out,{recursive:false});
  for(const item of files){
    const destination=join(out,...item.path.split('/'));
    await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,buffers[item.role],{flag:'wx'});
  }
  // Written last: an interrupted directory without manifest is never a verified package.
  await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {status:'packaged',directory:out,files:files.length,manifest};
}

export async function verifySubmission(directory) {
  const requested=resolve(directory);
  const info=await lstat(requested);
  if(info.isSymbolicLink() || !info.isDirectory())throw new Error('Package root must be a regular directory');
  const root=await realpath(requested);
  const manifest=json(await readPackagedFile(root,'manifest.json'),'manifest');
  if(manifest?.schema_version !== '1.0' || manifest.kind !== 'localization_submission'
    || !validTimestamp(manifest.created_at) || typeof manifest.target_locale !== 'string'
    || !Array.isArray(manifest.files))throw new Error('Invalid package manifest');
  if(manifest.checks?.preflight !== 'passed' || manifest.checks?.flutter_evidence !== 'bound_to_inputs') {
    throw new Error('Manifest check declarations are invalid');
  }
  const paths={...ROLES,...OPTIONAL_ROLES,preflight:'checks/preflight.json',
    fixed:'intl_'+manifest.target_locale+'_fixed.arb'};
  const roles=new Set(),seenPaths=new Set(),buffers={};
  for(const item of manifest.files){
    if(!item || typeof item !== 'object' || !Object.hasOwn(paths,item.role)
      || item.path !== paths[item.role] || roles.has(item.role) || seenPaths.has(item.path)
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !DIGEST.test(item.sha256 ?? '')) {
      throw new Error('Invalid or duplicate artifact entry in manifest');
    }
    safeRelativePath(item.path);roles.add(item.role);seenPaths.add(item.path);
    const bytes=await readPackagedFile(root,item.path);
    if(bytes.length !== item.bytes || sha256(bytes) !== item.sha256)throw new Error('Package checksum mismatch: '+item.path);
    buffers[item.role]=bytes;
  }
  for(const role of [...Object.keys(ROLES),'preflight'])if(!roles.has(role))throw new Error('Required artifact missing from manifest: '+role);
  const actualFiles=await inventory(root);
  const expectedFiles=['manifest.json',...seenPaths].sort();
  if(JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))throw new Error('Package contains unlisted files');
  const snapshot=validateSnapshot(buffers);
  if(snapshot.targetLocale !== manifest.target_locale)throw new Error('Manifest locale differs from review locale');
  const storedPreflight=json(buffers.preflight,'preflight');
  if(JSON.stringify(canonical(storedPreflight)) !== JSON.stringify(canonical(snapshot.preflight))) {
    throw new Error('Stored preflight does not match recomputed checks');
  }
  return {status:'verified',files:manifest.files.length,target_locale:snapshot.targetLocale,
    changed_count:snapshot.preflight.changed_count,flutter_evidence:'bound_to_inputs',
    limitations:manifest.limitations};
}
