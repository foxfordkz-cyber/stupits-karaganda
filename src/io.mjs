import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
export function args(options, required = []) {
  const parsed = parseArgs({ options, strict: true });
  for (const name of required) if (!parsed.values[name]) throw new Error(`Missing --${name}`);
  return parsed.values;
}
export async function main(run) {
  try { await run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

export async function assertSafeOutput(output, inputs) {
  const normalize = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  for (const input of inputs) {
    if (normalize(output) === normalize(input)) throw new Error('Output must not overwrite input: ' + input);
    try {
      const [a,b] = await Promise.all([stat(input),stat(output)]);
      if (a.dev === b.dev && a.ino === b.ino) throw new Error('Output must not overwrite input alias: ' + input);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
