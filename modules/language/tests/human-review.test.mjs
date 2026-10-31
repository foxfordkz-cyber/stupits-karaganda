import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPacket, scorePacket, preparePacket } from '../human-review.mjs';

test('blind synthetic packet leaves all human metrics unset and never labels corrected side', () => {
  const packet=buildPacket('synthetic-unit-test-seed'),result=scorePacket({packet});
  assert.equal(packet.blind.sheet.rows.length,12);assert.equal(packet.precision.rows.length,12);
  assert.equal(result.status,'HUMAN_REVIEW_PENDING');
  for(const field of ['acceptance_rate','rejection_rate','false_positive_review_rate','correction_quality']) assert.equal(result[field],null);
  for(const row of packet.blind.sheet.rows){assert.equal(row.preference,null);assert.equal(row.reviewer,null);assert.equal('corrected_side' in row,false);assert.equal('key' in row,false);}
  assert.ok(packet.report.every(f=>f.reviewed_by_human===false));
});
test('shared scorer rejects stale text/key, unauthorized answers and forged attestation', () => {
  let packet=buildPacket('test');packet.blind.sheet.rows[0].A='Changed';assert.throws(()=>scorePacket({packet}),/changed/i);
  packet=buildPacket('test');packet.blind.sheet.rows[0].preference='A';assert.throws(()=>scorePacket({packet}),/policy/);
  const row=packet.blind.sheet.rows[0];row.reviewer='SYNTHETIC_TEST_DOUBLE_NOT_HUMAN';row.reviewed_at='invalid';
  assert.throws(()=>scorePacket({packet,authorizedReviewers:[row.reviewer]}),/ISO/);
});
test('test-double partial ratings use explicit denominators and never become translation approvals', () => {
  const packet=buildPacket('test'),reviewer='SYNTHETIC_TEST_DOUBLE_NOT_HUMAN';
  for(const row of packet.blind.sheet.rows.slice(0,2)){row.preference='cannot_assess';row.reviewer=reviewer;row.reviewed_at='2026-10-31T00:00:00Z';}
  packet.blind.sheet.rows[0].preference=packet.blind.key.answers[0].corrected_side;
  Object.assign(packet.precision.rows[0],{reviewed:true,correct:false,reviewer,reviewed_at:'2026-10-31T00:00:00Z'});
  const result=scorePacket({packet,authorizedReviewers:[reviewer]});
  assert.equal(result.correction_quality,1);assert.equal(result.denominators.correction_quality,1);
  assert.equal(result.false_positive_review_rate,1);assert.equal(result.acceptance_rate,null);
  assert.equal(result.blind.complete,false);assert.equal(result.human_decisions_created,0);
});
test('prepared packet separates coordinator key and second pass; never overwrites answers', t => {
  const dir=mkdtempSync(join(tmpdir(),'bekzat-human-packet-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const out=join(dir,'packet');const result=preparePacket(out);assert.equal(result.status,'HUMAN_REVIEW_PENDING');
  assert.ok(existsSync(join(out,'ready.json')));assert.ok(existsSync(join(out,'coordinator','packet.json')));
  const sheet=readFileSync(join(out,'reviewer','blind-sheet.json'),'utf8');
  assert.ok(!sheet.includes('corrected_side'));assert.ok(!sheet.includes('false_positive_and_bad_correction'));
  assert.throws(()=>preparePacket(out),/new/);
});
