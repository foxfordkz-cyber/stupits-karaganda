import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashText } from '../src/contracts.mjs';
import { sampleForReview } from '../src/evaluation.mjs';
import { scorePrecisionReview, prepareBlindReview, scoreBlindReview, wilson95 } from '../src/human-evaluation.mjs';

const finding = key => ({key,issue_type:'orthography',severity:'medium',source:'Invented source '+key,target:'Invented target '+key,evidence:'Synthetic spelling defect',suggestion:'Invented correction '+key,confidence:0.8,reviewed_by_human:false});
const report = () => ['first','second','third','fourth'].map(finding);
const sample = () => sampleForReview(report(),{size:3,seed:'frozen-test-seed'});
// Attestations below are unit-test data, not actual human review.
function answer(row,correct) { Object.assign(row,{reviewed:true,correct,reviewer:'TEST_ONLY',reviewed_at:'2026-10-30T12:00:00Z'}); }
function inputs() {
  return {
    sourceText:JSON.stringify({'@@locale':'ru',title:'Synthetic title',empty:'Synthetic empty',missing:'Synthetic missing',same:'Same brand'}),
    originalText:JSON.stringify({'@@locale':'kk',title:'Old synthetic target',empty:'',same:'Same brand'}),
    fixedText:JSON.stringify({'@@locale':'kk',title:'New synthetic target',empty:'Filled synthetic target',missing:'Added synthetic target',same:'Same brand'})
  };
}
function blind() { return prepareBlindReview(inputs(),{seed:'private-test-seed',size:150}); }
function preference(row,value) { Object.assign(row,{preference:value,reviewer:'TEST_ONLY',reviewed_at:'2026-10-30T12:00:00+06:00'}); }

test('Wilson interval handles known values, boundary counts and undefined denominator',()=>{
  const interval=wilson95(5,10);
  assert.ok(Math.abs(interval.lower-0.2365930905)<1e-9);
  assert.ok(Math.abs(interval.upper-0.7634069095)<1e-9);
  assert.ok(wilson95(0,10).lower>=0);
  assert.ok(wilson95(10,10).upper<=1);
  assert.equal(wilson95(0,0).lower,null);
  for(const pair of [[-1,10],[11,10],[1.5,2],[0,-1]]) assert.throws(()=>wilson95(...pair));
});
test('precision scorer leaves unreviewed answers unset and does not claim recall',()=>{
  const value=scorePrecisionReview(sample(),report());
  assert.equal(value.reviewed,0);assert.equal(value.unreviewed,3);
  assert.equal(value.precision_on_reviewed,null);assert.equal(value.report_precision_estimate,null);
  assert.equal(Object.hasOwn(value,'recall'),false);
});
test('partial precision counts confirmed and rejected but withholds whole-report estimate',()=>{
  const s=sample();answer(s.rows[0],true);answer(s.rows[1],false);
  const value=scorePrecisionReview(s,report());
  assert.deepEqual([value.reviewed,value.confirmed,value.rejected,value.unreviewed],[2,1,1,1]);
  assert.equal(value.precision_on_reviewed,0.5);assert.equal(value.report_precision_estimate,null);
  answer(s.rows[2],true);
  assert.equal(scorePrecisionReview(s,report()).report_precision_estimate,2/3);
});
test('precision scorer accepts reordered rows but forbids deletion, replacement and report drift',()=>{
  const s=sample();s.rows.reverse();
  assert.doesNotThrow(()=>scorePrecisionReview(s,report().reverse()));
  const missing=sample();missing.rows.pop();assert.throws(()=>scorePrecisionReview(missing,report()),/every/);
  const repeated=sample();repeated.rows[1]=structuredClone(repeated.rows[0]);assert.throws(()=>scorePrecisionReview(repeated,report()),/duplicate/);
  const mutated=sample();mutated.rows[0].finding.target+='!';
  assert.throws(()=>scorePrecisionReview(mutated,report()),/Finding changed/);
  const current=report();current[0].evidence='new explanation';
  assert.throws(()=>scorePrecisionReview(sample(),current),/report_sha256 is stale/);
});
test('population fingerprint catches edits to a finding outside the selected sample',()=>{
  const s=sample(),current=report();
  const selected=new Set(s.rows.map(row=>row.finding.key));
  const unselected=current.find(f=>!selected.has(f.key));
  assert.ok(unselected);
  unselected.evidence='Unsampled explanation changed after the report was frozen';
  assert.throws(()=>scorePrecisionReview(s,current),/report_sha256 is stale/);
});
test('legacy samples remain readable but cannot claim a fingerprint-bound report estimate',()=>{
  const s=sample();delete s.report_sha256;
  for(const row of s.rows) { delete row.finding_sha256; answer(row,true); }
  const value=scorePrecisionReview(s,report());
  assert.equal(value.precision_on_reviewed,1);
  assert.equal(value.report_precision_estimate,null);
  assert.equal(value.population_binding,'legacy_selected_findings_only');
});
test('precision scorer rejects manipulated sample metadata and stale optional hashes',()=>{
  for(const field of ['sample_size','population_size','duplicate_report_rows']) {
    const s=sample();s[field]++;
    assert.throws(()=>scorePrecisionReview(s,report()),/metadata/);
  }
  const s=sample();s.report_sha256='0'.repeat(64);
  assert.throws(()=>scorePrecisionReview(s,report()),/report_sha256/);
  delete s.report_sha256;s.rows[0].finding_sha256='0'.repeat(64);
  assert.throws(()=>scorePrecisionReview(s,report()),/finding_sha256/);
});
test('reviewed precision answers require complete, valid human attestation',()=>{
  for(const patch of [
    {reviewed:true,correct:true},
    {reviewed:true,correct:true,reviewer:' ',reviewed_at:'2026-10-30T12:00:00Z'},
    {reviewed:true,correct:true,reviewer:'TEST_ONLY',reviewed_at:'2026-02-30T12:00:00Z'},
    {reviewed:true,correct:true,reviewer:'TEST_ONLY',reviewed_at:'2026-10-30'},
    {reviewed:true,correct:null,reviewer:'TEST_ONLY',reviewed_at:'2026-10-30T12:00:00Z'},
    {reviewed:null,correct:false},
    {reviewed:null,reviewer:'TEST_ONLY'},
    {reviewed:false,correct:null}
  ]) {
    const s=sample();Object.assign(s.rows[0],patch);
    assert.throws(()=>scorePrecisionReview(s,report()));
  }
});
test('empty report and zero-size sample have undefined precision, not perfect quality',()=>{
  const empty=sampleForReview([],{size:100,seed:'zero'});
  const result=scorePrecisionReview(empty,[]);
  assert.equal(result.sample_size,0);assert.equal(result.report_precision_estimate,null);
  const zero=sampleForReview(report(),{size:0,seed:'zero'});
  assert.equal(scorePrecisionReview(zero,report()).report_precision_estimate,null);
});
test('blind preparation is deterministic, only samples changed strings and keeps answer key private',()=>{
  const {sheet,key}=blind();
  assert.deepEqual(blind(),{sheet,key});
  assert.equal(sheet.sample_size,3);assert.equal(key.changed_population_size,3);
  assert.equal(Object.hasOwn(sheet,'seed'),false);
  assert.equal(Object.hasOwn(sheet,'inputs'),false);
  for(const row of sheet.rows) {
    assert.equal(row.preference,null);assert.equal(row.reviewer,null);assert.equal(row.reviewed_at,null);
    assert.equal(Object.hasOwn(row,'corrected_side'),false);assert.equal(Object.hasOwn(row,'key'),false);
  }
  assert.equal(key.answers.some(a=>a.key==='same'),false);
});
test('blind preparation preserves missing target versus empty string',()=>{
  const {sheet,key}=blind();
  for(const [name,expected] of [['missing',null],['empty','']]) {
    const answer=key.answers.find(a=>a.key===name),row=sheet.rows.find(r=>r.case_id===answer.case_id);
    const originalSide=answer.corrected_side==='A'?'B':'A';
    assert.equal(row[originalSide],expected);
  }
});
test('blind preparation rejects ambiguous input and invented/dropped keys',()=>{
  const ambiguous=inputs();ambiguous.originalText='{"@@locale":"kk","title":"one","title":"two"}';
  assert.throws(()=>prepareBlindReview(ambiguous,{seed:'x'}),/ambiguous/);
  const dropped=inputs();dropped.fixedText='{"@@locale":"kk","title":"new"}';
  assert.throws(()=>prepareBlindReview(dropped,{seed:'x'}),/dropped/);
  const unknown=inputs();const f=JSON.parse(unknown.fixedText);f.unknown='new';unknown.fixedText=JSON.stringify(f);
  assert.throws(()=>prepareBlindReview(unknown,{seed:'x'}),/no source/);
  const locale=inputs();locale.fixedText=locale.fixedText.replace('"kk"','"de"');
  assert.throws(()=>prepareBlindReview(locale,{seed:'x'}),/locales/);
});
test('resolved duplicate originals use runtime baseline and bind the resolution record',()=>{
  const v=inputs();
  v.originalText='{"@@locale":"kk","title":"Earlier variant","title":"Old synthetic target","empty":"","same":"Same brand"}';
  v.resolutions={schema_version:'1.0',source_sha256:hashText(v.sourceText),original_target_sha256:hashText(v.originalText),decisions:[{
    key:'title',occurrence:1,chosen_hash:hashText('Earlier variant'),reviewer:'TEST_ONLY',reviewed_at:'2026-10-30T12:00:00Z',reviewed_by_human:true
  }]};
  const {sheet,key}=prepareBlindReview(v,{seed:'resolved-test'});
  const answer=key.answers.find(a=>a.key==='title'),row=sheet.rows.find(r=>r.case_id===answer.case_id);
  assert.equal(row[answer.corrected_side==='A'?'B':'A'],'Old synthetic target');
  assert.match(key.inputs.resolutions_sha256,/^[a-f0-9]{64}$/);
  assert.doesNotThrow(()=>scoreBlindReview(sheet,key,v));
  const stale=structuredClone(v);stale.resolutions.decisions[0].reviewer='DIFFERENT_TEST_ONLY';
  assert.throws(()=>scoreBlindReview(sheet,key,stale),/answer key/);
  const incomplete=structuredClone(v);incomplete.resolutions.decisions=[];
  assert.throws(()=>prepareBlindReview(incomplete,{seed:'resolved-test'}),/explicit resolution/);
});
test('blind scoring counts real preferences without automatically choosing corrected text',()=>{
  const {sheet,key}=blind();
  for(let i=0;i<sheet.rows.length;i++) {
    const r=sheet.rows[i],a=key.answers.find(x=>x.case_id===r.case_id);
    preference(r,i===0?a.corrected_side:i===1?(a.corrected_side==='A'?'B':'A'):'tie');
  }
  const result=scoreBlindReview(sheet,key,inputs());
  assert.deepEqual([result.better,result.worse,result.tied,result.reviewed],[1,1,1,3]);
  assert.equal(result.correction_win_rate,1/3);assert.equal(result.net_preference,0);
});
test('blind scoring handles unassessable and incomplete reviews explicitly',()=>{
  const {sheet,key}=blind();preference(sheet.rows[0],'cannot_assess');
  const result=scoreBlindReview(sheet,key,inputs());
  assert.deepEqual([result.reviewed,result.cannot_assess,result.unreviewed,result.assessed],[1,1,2,0]);
  assert.equal(result.correction_win_rate,null);assert.equal(result.complete,false);
});
test('blind scoring binds exact text, private key, input files and full selected population',()=>{
  for(const mutate of [
    s=>s.rows[0].A='tampered',
    s=>s.rows.pop(),
    s=>s.rows.push(structuredClone(s.rows[0])),
    s=>s.sample_size++,
    s=>s.instructions='The corrected answer is shown first',
    s=>s.rows[0].corrected_side='A',
    s=>s.seed='exposed-private-seed'
  ]) {
    const {sheet,key}=blind();mutate(sheet);
    assert.throws(()=>scoreBlindReview(sheet,key,inputs()));
  }
  const {sheet,key}=blind();
  key.answers[0].corrected_side=key.answers[0].corrected_side==='A'?'B':'A';
  assert.throws(()=>scoreBlindReview(sheet,key,inputs()),/answer key/);
  const original=blind(),changed=inputs();changed.fixedText+=' ';
  assert.throws(()=>scoreBlindReview(original.sheet,original.key,changed),/stale/);
});
test('blind scoring requires named dated review and accepts row reorder',()=>{
  const {sheet,key}=blind();sheet.rows.reverse();
  assert.doesNotThrow(()=>scoreBlindReview(sheet,key,inputs()));
  sheet.rows[0].preference='A';
  assert.throws(()=>scoreBlindReview(sheet,key,inputs()),/reviewer/);
  preference(sheet.rows[0],'unsupported');
  assert.throws(()=>scoreBlindReview(sheet,key,inputs()),/Invalid blind preference/);
});
test('blind preparation caps sampling and zero changed rows do not imply success',()=>{
  assert.equal(prepareBlindReview(inputs(),{seed:'small',size:1}).sheet.sample_size,1);
  const v=inputs();v.fixedText=v.originalText;
  const {sheet,key}=prepareBlindReview(v,{seed:'empty'});
  assert.equal(sheet.sample_size,0);
  assert.equal(scoreBlindReview(sheet,key,v).correction_win_rate,null);
});

test('human evaluation CLI roundtrip and overwrite protection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'locqa-human-'));
  const run=(script,argv)=>spawnSync(process.execPath,[resolve('scripts',script),...argv],{encoding:'utf8'});
  try {
    const p=name=>join(dir,name),v=inputs();
    await Promise.all([
      writeFile(p('source.arb'),v.sourceText),writeFile(p('original.arb'),v.originalText),writeFile(p('fixed.arb'),v.fixedText),
      writeFile(p('report.json'),JSON.stringify(report())),writeFile(p('sample.json'),JSON.stringify(sample()))
    ]);
    const prepareArgs=['--source',p('source.arb'),'--original-target',p('original.arb'),'--fixed',p('fixed.arb'),'--out',p('sheet.json'),'--key-out',p('key.json'),'--seed','cli-seed'];
    const prepare=run('blind-review.mjs',prepareArgs);assert.equal(prepare.status,0,prepare.stderr);
    assert.notEqual(run('blind-review.mjs',prepareArgs).status,0,'must preserve an existing sheet');
    const score=run('score-blind.mjs',['--source',p('source.arb'),'--original-target',p('original.arb'),'--fixed',p('fixed.arb'),'--sheet',p('sheet.json'),'--key',p('key.json'),'--out',p('blind-result.json')]);
    assert.equal(score.status,0,score.stderr);
    assert.equal(JSON.parse(await readFile(p('blind-result.json'),'utf8')).reviewed,0);
    const precision=run('score-review.mjs',['--sample',p('sample.json'),'--report',p('report.json'),'--out',p('precision.json')]);
    assert.equal(precision.status,0,precision.stderr);
    const original=await readFile(p('sample.json'),'utf8');
    assert.notEqual(run('score-review.mjs',['--sample',p('sample.json'),'--report',p('report.json'),'--out',p('sample.json')]).status,0);
    assert.equal(await readFile(p('sample.json'),'utf8'),original);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));
    await rm(dir,{recursive:true,force:true});
  }
});
