import test from 'node:test';
import assert from 'node:assert/strict';
import { auditInputs, verifyResolutions } from '../src/duplicate-resolutions.mjs';
import { checkRelease } from '../src/release-gate.mjs';
import { hashText } from '../src/contracts.mjs';

const serialize=value=>JSON.stringify(value);
function fixture(){
  const sourceText=serialize({'@@locale':'ru',button:'Take {item}',brand:'StarPebble'});
  const originalText='{"@@locale":"kk","button":"First {item}","button":"Last {item}","brand":"StarPebble"}';
  const fixed={'@@locale':'kk',button:'Last {item}',brand:'StarPebble'};
  const reviews={schema_version:'1.0',target_locale:'kk',decisions:[]};
  return {sourceText,originalText,fixedText:serialize(fixed),report:[],reviews};
}
function resolutions(f,occurrence=2,text=occurrence===2?'Last {item}':'First {item}'){
  return {schema_version:'1.0',source_sha256:hashText(f.sourceText),original_target_sha256:hashText(f.originalText),
    decisions:[{key:'button',occurrence,chosen_hash:hashText(text),reviewer:'TEST_ONLY',
      reviewed_at:'2026-10-30T01:00:00Z',reviewed_by_human:true}]};
}
function correction(f,text){
  const source=JSON.parse(f.sourceText);
  const original=JSON.parse(f.originalText);
  const d={key:'button',entry_id:'button#2',decision:'edited',original_text:original.button,approved_text:text,
    source_hash:hashText(source.button),original_hash:hashText(original.button),approved_hash:hashText(text),
    reviewer:'TEST_ONLY',reviewed_at:'2026-10-30T01:01:00Z',reviewed_by_human:true};
  f.reviews.decisions=[d];
  const stamp=Object.fromEntries(['reviewed_by_human','reviewer','reviewed_at','source_hash','original_hash','approved_hash'].map(k=>[k,d[k]]));
  f.fixedText=serialize({'@@locale':'kk',button:text,brand:'StarPebble','@button':{'x-locqa':stamp}});
  return f;
}
const errors=result=>result.errors.join('\n');

test('input audit preserves all conflicting candidates and creates no human decisions',()=>{
  const f=fixture(),audit=auditInputs(f.sourceText,f.originalText);
  assert.equal(audit.source_sha256,hashText(f.sourceText));
  assert.equal(audit.original_target_sha256,hashText(f.originalText));
  assert.equal(audit.target_unique_strings,2);
  assert.equal(audit.duplicate_review_queue.length,1);
  const row=audit.duplicate_review_queue[0];
  assert.deepEqual(row.candidates.map(c=>[c.occurrence,c.text]),[[1,'First {item}'],[2,'Last {item}']]);
  for(const candidate of row.candidates)assert.equal(candidate.chosen_hash,hashText(candidate.text));
  assert.equal(row.selected_occurrence,null);assert.equal(row.reviewer,null);
  assert.equal(row.reviewed_at,null);assert.equal(row.reviewed_by_human,false);
  assert.ok(audit.same_as_source_candidates.includes('brand'));
  assert.match(audit.notes.join(' '),/not confirmed errors/);
});

test('resolution is bound to the exact source and original file bytes',()=>{
  const f=fixture(),r=resolutions(f);
  assert.equal(verifyResolutions(r,f.sourceText,f.originalText).get('button').chosen_text,'Last {item}');
  assert.throws(()=>verifyResolutions(r,f.sourceText+'\n',f.originalText),/different source\/original/);
  assert.throws(()=>verifyResolutions(r,f.sourceText,f.originalText+'\n'),/different source\/original/);
  assert.equal(verifyResolutions(undefined,f.sourceText,f.originalText).size,0);
});

test('unknown key and nonconflicting key are never accepted as resolutions',()=>{
  const f=fixture();
  for(const key of ['missing','brand']){
    const r=resolutions(f);r.decisions[0].key=key;
    assert.throws(()=>verifyResolutions(r,f.sourceText,f.originalText),/conflicting target key/);
  }
});

test('selected occurrence and its exact hash must agree',()=>{
  const f=fixture();
  for(const patch of [{occurrence:3},{occurrence:1},{chosen_hash:hashText('different')}]){
    const r=resolutions(f);Object.assign(r.decisions[0],patch);
    assert.throws(()=>verifyResolutions(r,f.sourceText,f.originalText),/occurrence\/hash/);
  }
});

test('duplicate decisions and blank reviewers are refused',()=>{
  const f=fixture(),duplicate=resolutions(f);
  duplicate.decisions.push(structuredClone(duplicate.decisions[0]));
  assert.throws(()=>verifyResolutions(duplicate,f.sourceText,f.originalText),/Repeated duplicate resolution/);
  for(const patch of [{reviewer:' '},{key:'\t'}]){
    const r=resolutions(f);Object.assign(r.decisions[0],patch);
    assert.throws(()=>verifyResolutions(r,f.sourceText,f.originalText),/must not be blank/);
  }
});

test('only complete human attestations match the resolution contract',()=>{
  const f=fixture();
  for(const patch of [{reviewed_by_human:false},{reviewed_at:'yesterday'},{occurrence:0},{chosen_hash:'bad'},{extra:true}]){
    const r=resolutions(f);Object.assign(r.decisions[0],patch);
    assert.throws(()=>verifyResolutions(r,f.sourceText,f.originalText));
  }
  const queue=auditInputs(f.sourceText,f.originalText).duplicate_review_queue;
  assert.throws(()=>verifyResolutions({...resolutions(f),decisions:queue},f.sourceText,f.originalText));
});

test('all conflicting target keys must be resolved, including when some are valid',()=>{
  const f=fixture();f.originalText=f.originalText.replace('"brand":"StarPebble"','"brand":"EarlierBrand","brand":"StarPebble"');
  const result=checkRelease({...f,resolutions:resolutions(f)});
  assert.equal(result.status,'failed');assert.match(errors(result),/conflicting key brand/);
  assert.equal(result.resolved_duplicate_count,1);
});

test('choosing the unchanged final occurrence resolves ambiguity without inventing a text edit',()=>{
  const f=fixture(),result=checkRelease({...f,resolutions:resolutions(f)});
  assert.equal(result.status,'preflight_passed');
  assert.equal(result.changed_count,0);assert.equal(result.reviewed_changed_count,0);
  assert.equal(result.resolved_duplicate_count,1);
});

test('selecting an earlier occurrence still requires normal exact-text review and stamp',()=>{
  const f=fixture();f.fixedText=serialize({'@@locale':'kk',button:'First {item}',brand:'StarPebble'});
  const result=checkRelease({...f,resolutions:resolutions(f,1)});
  assert.equal(result.status,'failed');assert.match(errors(result),/lacks current human approval/);
  assert.equal(result.reviewed_changed_count,0);
});

test('earlier selected variant with exact approval and stamp passes',()=>{
  const f=correction(fixture(),'First {item}');
  const result=checkRelease({...f,resolutions:resolutions(f,1)});
  assert.equal(result.status,'preflight_passed');
  assert.equal(result.changed_count,1);assert.equal(result.reviewed_changed_count,1);
});

test('resolution does not allow exporting a different unapproved variant',()=>{
  const f=fixture();
  const result=checkRelease({...f,resolutions:resolutions(f,1)});
  assert.equal(result.status,'failed');assert.match(errors(result),/Resolved variant not exported/);
});

test('a new translation after selection can pass only as a separate reviewed correction',()=>{
  const f=correction(fixture(),'Revised {item}');
  const valid=checkRelease({...f,resolutions:resolutions(f,1)});
  assert.equal(valid.status,'preflight_passed');
  f.reviews.decisions=[];
  const invalid=checkRelease({...f,resolutions:resolutions(f,1)});
  assert.equal(invalid.status,'failed');
  assert.match(errors(invalid),/lacks current human approval/);
});

test('source changes invalidate normal approval even with newly bound resolution',()=>{
  const f=correction(fixture(),'First {item}');
  f.sourceText=serialize({'@@locale':'ru',button:'Updated {item}',brand:'StarPebble'});
  const result=checkRelease({...f,resolutions:resolutions(f,1)});
  assert.equal(result.status,'failed');assert.match(errors(result),/Stale source review/);
  assert.equal(result.reviewed_changed_count,0);
});

test('original changes invalidate normal approval even with freshly selected last occurrence',()=>{
  const f=correction(fixture(),'First {item}');
  f.originalText=f.originalText.replace('Last {item}','Changed {item}');
  const result=checkRelease({...f,resolutions:resolutions(f,2,'Changed {item}')});
  assert.equal(result.status,'failed');assert.match(errors(result),/Stale original review/);
  assert.equal(result.reviewed_changed_count,0);
});

test('a resolution cannot replace missing or tampered ARB review stamp',()=>{
  const f=correction(fixture(),'First {item}'),fixed=JSON.parse(f.fixedText);
  delete fixed['@button'];f.fixedText=serialize(fixed);
  const result=checkRelease({...f,resolutions:resolutions(f,1)});
  assert.equal(result.status,'failed');assert.match(errors(result),/review stamp/);
  assert.equal(result.reviewed_changed_count,0);
});

test('source conflicts remain blockers even after valid target resolution',()=>{
  const f=fixture();
  f.sourceText='{"@@locale":"ru","button":"Earlier {item}","button":"Take {item}","brand":"StarPebble"}';
  const result=checkRelease({...f,resolutions:resolutions(f)});
  assert.equal(result.status,'failed');assert.match(errors(result),/source: conflicting key button/);
});

test('identical duplicates do not need a conflict resolution and cannot be falsely labelled conflicting',()=>{
  const f=fixture();f.originalText=f.originalText.replace('First {item}','Last {item}');
  assert.equal(checkRelease(f).status,'preflight_passed');
  assert.throws(()=>checkRelease({...f,resolutions:resolutions(f)}),/conflicting target key/);
});
