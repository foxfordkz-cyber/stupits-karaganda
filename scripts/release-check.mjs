import { readFile } from 'node:fs/promises';
import { checkRelease } from '../src/release-gate.mjs';
import { args, main, readJson, writeJson, assertSafeOutput } from '../src/io.mjs';
await main(async () => {
  const names = ['source','original-target','fixed','report','reviews','glossary','html','methodology','out'];
  const a = args(Object.fromEntries(names.map(n => [n,{type:'string'}])), names);
  await assertSafeOutput(a.out, names.filter(n=>n!=='out').map(n=>a[n]));
  const [sourceText,originalText,fixedText,report,reviews,glossary,html,methodology] = await Promise.all([
    readFile(a.source,'utf8'), readFile(a['original-target'],'utf8'), readFile(a.fixed,'utf8'),
    readJson(a.report), readJson(a.reviews), readFile(a.glossary,'utf8'), readFile(a.html,'utf8'), readFile(a.methodology,'utf8')
  ]);
  const result = checkRelease({ sourceText,originalText,fixedText,report,reviews });
  const header = glossary.replace(/^\uFEFF/,'').split(/\r?\n/)[0].split(',').map(x=>x.trim());
  if (header.join(',') !== 'ru,kk,en,comment') result.errors.push('Glossary header must be ru,kk,en,comment');
  if (!/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) result.errors.push('Missing standalone HTML report');
  if (!methodology.trim()) result.errors.push('Empty methodology');
  result.status = result.errors.length ? 'failed' : 'preflight_passed';
  await writeJson(a.out,result);
  console.log(JSON.stringify(result,null,2));
  if (result.errors.length) process.exitCode = 1;
});
