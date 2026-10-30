import { readFile } from 'node:fs/promises';
import { auditInputs } from '../src/duplicate-resolutions.mjs';
import { args, main, writeJson, assertSafeOutput } from '../src/io.mjs';
await main(async()=>{
 const a=args({source:{type:'string'},target:{type:'string'},out:{type:'string'}},['source','target','out']);
 await assertSafeOutput(a.out,[a.source,a.target]);
 const [source,target]=await Promise.all([readFile(a.source,'utf8'),readFile(a.target,'utf8')]);
 const result=auditInputs(source,target);
 await writeJson(a.out,result);
 console.log(JSON.stringify({source_strings:result.source_unique_strings,target_strings:result.target_unique_strings,missing:result.missing_target_keys.length,empty:result.empty_target_keys.length,conflicting_target_keys:result.duplicate_review_queue.length,output:a.out}));
});
