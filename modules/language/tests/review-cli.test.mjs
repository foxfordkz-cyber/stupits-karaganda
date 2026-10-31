import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashText } from '../../../src/contracts.mjs';
import { runLanguage } from '../check.mjs';
import { runReviewGate } from '../review-gate.mjs';

function fixture(t, limit) {
  const dir = mkdtempSync(join(tmpdir(), 'bekzat-gate-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = 'Подарок', target = 'Сыйлык';
  const entries = ['a', 'b'].map(key => ({ key, entry_id: key+'#1', occurrence:1, source, target,
    source_hash:hashText(source), target_hash:hashText(target), context:{} }));
  const paths = Object.fromEntries(['bundle','source','target','glossary','reviews'].map(k=>[k,join(dir,k+'.json')]));
  for (const [k,value] of Object.entries({ bundle:{schema_version:'1.0',source_locale:'ru',target_locale:'kk',entries},
    source:{'@@locale':'ru',a:source,b:source},target:{'@@locale':'kk',a:target,b:target},reviews:{schema_version:'1.0',target_locale:'kk',decisions:[]} })) writeFileSync(paths[k],JSON.stringify(value));
  writeFileSync(paths.glossary,'ru,kk,en,comment\n');
  const report = join(dir,'report.json');
  assert.equal(runLanguage({bundle:paths.bundle,glossary:paths.glossary,out:report,limit}).status,0);
  return {...paths,dir,report,details:report+'.details',state:join(dir,'ledger'),out:join(dir,'gate.json')};
}
test('real language snapshots verify across Python/JS; missing owners remain explicit and no approvals created', async t => {
  const f=fixture(t); const before=readFileSync(f.target);
  const result=await runReviewGate(f); assert.equal(result.status,'HUMAN_REVIEW_PENDING');
  const artifact=JSON.parse(readFileSync(f.out,'utf8'));
  assert.deepEqual(artifact.gate.components,{core:false,linguistics:false});
  assert.equal(artifact.gate.technical.length,0); assert.equal(artifact.receipt,null);
  assert.equal(artifact.gate.unconfirmed_entry_ids.length,2); assert.deepEqual(readFileSync(f.target),before);
  await assert.rejects(runReviewGate(f),/output_exists/);
});
test('pilot selection reconstructs only selected records', async t => {
  const f=fixture(t,1); const result=await runReviewGate(f); assert.equal(result.unconfirmed_entries,1);
});
test('tampered candidate/queue cannot be published even if shared report still validates', async t => {
  const f=fixture(t),file=join(f.details,'review_queue.json');const q=JSON.parse(readFileSync(file,'utf8'));
  q.rows[0].candidates[0].text='Подмена';q.rows[0].candidates[0].text_hash=hashText('Подмена');
  writeFileSync(file,JSON.stringify(q)); await assert.rejects(runReviewGate(f),/queue_snapshot/); assert.equal(existsSync(f.out),false);
});
test('incomplete scan blocks handoff and input/ledger overlap is rejected', async t => {
  const f=fixture(t),file=join(f.details,'metrics.json'),metrics=JSON.parse(readFileSync(file,'utf8'));
  metrics.status='partial';writeFileSync(file,JSON.stringify(metrics));
  assert.equal((await runReviewGate(f)).status,'BLOCKED');
  const artifact=JSON.parse(readFileSync(f.out,'utf8')); assert.equal(artifact.gate.approved_reviews,null);
  await assert.rejects(runReviewGate({...f,out:join(f.dir,'another.json'),state:f.dir}),/inside_ledger|overlap/);
});
