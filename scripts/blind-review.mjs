import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { prepareBlindReview } from '../src/human-evaluation.mjs';
import { args, main, assertSafeOutput, readJson } from '../src/io.mjs';
await main(async () => {
  const a=args({source:{type:'string'},'original-target':{type:'string'},fixed:{type:'string'},out:{type:'string'},'key-out':{type:'string'},seed:{type:'string'},resolutions:{type:'string'},size:{type:'string',default:'150'}},['source','original-target','fixed','out','key-out','seed']);
  if(!/^\d+$/.test(a.size)) throw new Error('--size must be a non-negative integer');
  const inputs=[a.source,a['original-target'],a.fixed];
  const protectedInputs=[...inputs,...(a.resolutions?[a.resolutions]:[])];
  await assertSafeOutput(a.out,[...protectedInputs,a['key-out']]);
  await assertSafeOutput(a['key-out'],[...protectedInputs,a.out]);
  for(const path of [a.out,a['key-out']]) {
    try { await stat(path); throw new Error('Refusing to replace an existing review file: '+path); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  const [sourceText,originalText,fixedText]=await Promise.all(inputs.map(path=>readFile(path,'utf8')));
  const result=prepareBlindReview({sourceText,originalText,fixedText,resolutions:a.resolutions?await readJson(a.resolutions):undefined},{size:Number(a.size),seed:a.seed});
  for(const path of [a.out,a['key-out']]) await mkdir(dirname(path),{recursive:true});
  // Write the private key first. Exclusive creation never overwrites human answers.
  await writeFile(a['key-out'],JSON.stringify(result.key,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  await writeFile(a.out,JSON.stringify(result.sheet,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(`Prepared ${result.sheet.sample_size} blind cases. Give only the sheet to the reviewer; keep key-out private.`);
});
