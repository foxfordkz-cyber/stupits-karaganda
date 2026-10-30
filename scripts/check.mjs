import { readFile, readdir } from 'node:fs/promises';
import { assertContract } from '../src/contracts.mjs';
import { inspectArb } from '../src/arb-audit.mjs';
import { main, readJson } from '../src/io.mjs';
await main(async () => {
  const base = new URL('../fixtures/synthetic/',import.meta.url);
  const report = await readJson(new URL('report.sample.json',base));
  assertContract('report',report);
  if (report.some(f=>f.reviewed_by_human)) throw new Error('Synthetic fixture must not claim human review');
  const gold = await readJson(new URL('gold.json',base));
  const identity = rows=>rows.map(r=>JSON.stringify([r.key,r.issue_type])).sort();
  if (JSON.stringify(identity(gold)) !== JSON.stringify(identity(report))) throw new Error('Fixture gold/report identities disagree');
  for (const name of ['source.arb','target.arb']) inspectArb(await readFile(new URL(name,base),'utf8'));
  for (const name of ['bundle','reviews']) {
    const sample = new URL('../contracts/examples/'+name+'.json',import.meta.url);
    assertContract(name,await readJson(sample));
  }
  console.log('Contracts and synthetic fixtures valid. Detector quality is NOT measured by this check.');
});
