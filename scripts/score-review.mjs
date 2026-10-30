import { scorePrecisionReview } from '../src/human-evaluation.mjs';
import { args, main, readJson, writeJson, assertSafeOutput } from '../src/io.mjs';
await main(async () => {
  const a=args({sample:{type:'string'},report:{type:'string'},out:{type:'string'}},['sample','report','out']);
  await assertSafeOutput(a.out,[a.sample,a.report]);
  const result=scorePrecisionReview(await readJson(a.sample),await readJson(a.report));
  await writeJson(a.out,result);
  console.log(`Human precision: ${result.confirmed}/${result.reviewed} confirmed; ${result.unreviewed} awaiting review`);
});
