// EXPLICIT TEST FIXTURE PLAYBACK. This is not a localization detector.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { inspectArb } from '../../../src/arb-audit.mjs';
import { hashText } from '../../../src/contracts.mjs';
const {values:a,positionals}=parseArgs({allowPositionals:true,options:{
  source:{type:'string'},target:{type:'string'},bundle:{type:'string'},report:{type:'string'},out:{type:'string'}
}});
const mode=positionals[0];
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const write=async data=>writeFile(a.out,JSON.stringify(data,null,2)+'\n');
if(mode==='normalize'){
 const source=inspectArb(await readFile(a.source,'utf8')),target=inspectArb(await readFile(a.target,'utf8'));
 const entries=[];
 for(const [key,text] of source.strings){
  const targets=target.entries.filter(e=>e.key===key);
  for(const entry of targets.length?targets:[{text:null,occurrence:0}]) entries.push({
   entry_id:encodeURIComponent(key)+'#'+entry.occurrence,key,occurrence:entry.occurrence,
   source:text,target:entry.text,source_hash:hashText(text),target_hash:hashText(entry.text),
   context:{section:'Synthetic fixture playback'}
  });
 }
 await write({schema_version:'1.0',source_locale:source.metadata.get('@@locale'),target_locale:target.metadata.get('@@locale'),entries});
}else if(mode==='core'||mode==='language'){
 const prepared=await read(new URL('../report.sample.json',import.meta.url));
 const structural=new Set(['untranslated','same_as_source','placeholder_mismatch','plural_mismatch','length_overflow']);
 await write(prepared.filter(f=>structural.has(f.issue_type)===(mode==='core')));
}else if(mode==='render'){
 const report=await read(a.report);
 const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 await writeFile(a.out,'<!doctype html><html lang="ru"><meta charset="utf-8"><body><h1>Синтетическое воспроизведение</h1><p>Подготовленные находки; детектор не запускался, качество модели не измерено.</p><ul>'+report.map(f=>'<li>'+esc(f.key)+' — '+esc(f.issue_type)+'</li>').join('')+'</ul></body></html>');
}else throw new Error('Unknown synthetic adapter mode');
