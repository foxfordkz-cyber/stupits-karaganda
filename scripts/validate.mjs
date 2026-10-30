import { assertContract } from '../src/contracts.mjs';
import { args, main, readJson } from '../src/io.mjs';
await main(async () => {
  const a = args({ schema: { type: 'string' }, file: { type: 'string' } }, ['schema', 'file']);
  assertContract(a.schema, await readJson(a.file));
  console.log(`VALID ${a.schema}: ${a.file}`);
});
