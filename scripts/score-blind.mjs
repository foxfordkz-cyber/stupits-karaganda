import { readFile } from 'node:fs/promises';
import { scoreBlindReview } from '../src/human-evaluation.mjs';
import { args, main, readJson, writeJson, assertSafeOutput } from '../src/io.mjs';
await main(async () => {
  const names=['source','original-target','fixed','sheet','key','out'];
  const a=args({...Object.fromEntries(names.map(n=>[n,{type:'string'}])),resolutions:{type:'string'}},names);
  await assertSafeOutput(a.out,[...names.filter(n=>n!=='out').map(n=>a[n]),...(a.resolutions?[a.resolutions]:[])]);
  const [sourceText,originalText,fixedText]=await Promise.all([a.source,a['original-target'],a.fixed].map(p=>readFile(p,'utf8')));
  const result=scoreBlindReview(await readJson(a.sheet),await readJson(a.key),{sourceText,originalText,fixedText,resolutions:a.resolutions?await readJson(a.resolutions):undefined});
  await writeJson(a.out,result);
  console.log(`Blind review: ${result.better} better, ${result.worse} worse, ${result.tied} tied; ${result.unreviewed} awaiting review`);
});
