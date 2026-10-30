import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, TextDecoder } from 'node:util';
import { assertContract } from '../../src/contracts.mjs';
import { readArb, localeOf, createBundle, arbSnapshot } from './arb.mjs';
import { baselinePlan } from './baseline-plan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const isDirect = url => Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url));
export async function stageMain(run) {
  try { await run(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
const read = async path => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path));
const json = value => JSON.stringify(value, null, 2) + '\n';
function args(names, required) {
  const { values } = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' }])), strict: true });
  for (const name of required) if (!values[name]) throw new Error('Missing --' + name);
  return values;
}
function inside(parent, path) {
  const rel = relative(parent, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel));
}
async function physical(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await physical(parent), relative(parent, path));
  }
}
async function writeNew(path, value) {
  const absolute = resolve(path), repository = await realpath(root);
  for (const candidate of [absolute, await physical(absolute)]) if (inside(repository, candidate)
    && !['outputs', 'private', 'data', 'submission'].some(dir => inside(join(repository, dir), candidate))) throw new Error('Stage output must remain in an ignored data/output directory.');
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, value, { flag: 'wx' });
}

export function normalizeArbs({ sourceText, targetText, sourceLocale, targetLocale }) {
  const source = readArb(sourceText, 'source'), target = readArb(targetText, 'target');
  const diagnostics = [...source.diagnostics, ...target.diagnostics];
  if ([...source.groups.values()].some(group => new Set(group.map(p => p.value)).size > 1)) throw new Error('Conflicting source keys require integrator resolution before normalization.');
  if (diagnostics.some(d => ['non_string_resource', 'duplicate_attribute', 'invalid_metadata'].includes(d.code))) throw new Error('Invalid ARB structure; run locqa check for the full diagnostic audit.');
  const bundle = createBundle(source, target, localeOf(source, sourceLocale), localeOf(target, targetLocale), diagnostics);
  assertContract('bundle', bundle);
  // A stage must not silently omit records the integrator expects to receive.
  if ([...source.groups.keys()].some(key => !key.trim() || !key.isWellFormed())) throw new Error('Invalid key identity prevents complete normalization.');
  return { bundle, diagnostics, baselinePlan: baselinePlan(source, target), audit: { source: arbSnapshot(source), target: arbSnapshot(target) } };
}

export async function runNormalizeStage() {
  const a = args(['source', 'target', 'out', 'source-locale', 'target-locale'], ['source', 'target', 'out']);
  const [sourceText, targetText] = await Promise.all([read(a.source), read(a.target)]);
  const result = normalizeArbs({ sourceText, targetText, sourceLocale: a['source-locale'], targetLocale: a['target-locale'] });
  for (const [name, data] of [['diagnostics', result.diagnostics], ['baseline-plan', result.baselinePlan], ['audit', result.audit]]) await writeNew(a.out + '.' + name + '.json', json(data));
  await writeNew(a.out, json(result.bundle));
}

export async function runCheckStage(checkBundle) {
  const a = args(['bundle', 'glossary', 'out'], ['bundle', 'glossary', 'out']);
  const [bundle, glossaryText] = await Promise.all([read(a.bundle).then(JSON.parse), read(a.glossary)]);
  const result = checkBundle(bundle, { glossaryText });
  await writeNew(a.out + '.diagnostics.json', json(result.diagnostics));
  await writeNew(a.out + '.trace.json', json(result.trace));
  await writeNew(a.out, json(result.report));
  // Stage success means a valid produced artifact, not an absence of findings.
}

export async function runExportStage(exportApproved) {
  const a = args(['source', 'target', 'reviews', 'resolutions', 'out', 'source-locale', 'target-locale'], ['source', 'target', 'reviews', 'out']);
  const [sourceText, targetText, reviews, resolutions] = await Promise.all([
    read(a.source), read(a.target), read(a.reviews).then(JSON.parse), a.resolutions ? read(a.resolutions).then(JSON.parse) : undefined
  ]);
  const result = exportApproved({ sourceText, targetText, reviews, resolutions, sourceLocale: a['source-locale'], targetLocale: a['target-locale'] });
  await writeNew(a.out + '.audit.json', json(result.audit));
  await writeNew(a.out, result.text);
}
