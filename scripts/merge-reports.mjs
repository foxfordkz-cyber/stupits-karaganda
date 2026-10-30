import { mergeReports } from '../src/report-merge.mjs';
import { args, main, readJson, writeJson, assertSafeOutput } from '../src/io.mjs';
await main(async () => {
  const a = args({ input: { type: 'string', multiple: true }, out: { type: 'string' } }, ['input','out']);
  await assertSafeOutput(a.out, a.input);
  const result = mergeReports(await Promise.all(a.input.map(readJson)));
  await writeJson(a.out, result.report);
  console.log(`Merged ${result.report.length} findings; ${result.duplicates} identical duplicates removed`);
});
