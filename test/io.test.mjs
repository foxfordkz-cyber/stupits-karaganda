import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeOutput } from '../src/io.mjs';
test('output cannot overwrite an input by path',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'locqa-io-'));
 try{
  const input=join(dir,'input.json'),alias=join(dir,'alias.json');
  await writeFile(input,'unchanged');
  await assert.rejects(assertSafeOutput(input,[input]),/overwrite/);
  await assert.doesNotReject(assertSafeOutput(join(dir,'new.json'),[input]));
  assert.equal(await readFile(input,'utf8'),'unchanged');
 } finally { await rm(dir,{recursive:true,force:true}); }
});

test('output cannot overwrite an input through a hard link',async(t)=>{
 const dir=await mkdtemp(join(tmpdir(),'locqa-alias-'));
 try {
  const input=join(dir,'input.json'),alias=join(dir,'alias.json');
  await writeFile(input,'unchanged');
  try { await link(input,alias); }
  catch(error) {
   if(['EPERM','EACCES','ENOTSUP'].includes(error.code)) {t.skip('Sandbox/filesystem does not allow hard links');return;}
   throw error;
  }
  await assert.rejects(assertSafeOutput(alias,[input]),/overwrite/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
