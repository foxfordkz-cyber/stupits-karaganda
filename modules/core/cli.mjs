#!/usr/bin/env node
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, TextDecoder } from 'node:util';
import { checkArbs } from './check.mjs';
import { exportApproved } from './export.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = `locqa check --source FILE --target FILE --glossary CSV --out NEW_DIRECTORY
locqa export --source FILE --target FILE --reviews JSON --out NEW_DIRECTORY

Options: --source-locale ru --target-locale kk (required if @@locale absent)
check: --length-ratio 2 --short-limit 20 --length-minimum 10

check writes report.json, bundle.json, diagnostics.json, trace.json, audit.json,
manifest.json. export writes intl_kk_fixed.arb and export-audit.json for kk.
Outputs inside this repository must be in ignored outputs/, private/, data/ or
submission/. Existing output directories are never overwritten.
Exit codes: 0 clean/success; 1 findings; 2 structural/export/input errors.
Run flutter gen-l10n on the exact exported files before release.`;

async function readUtf8(path) {
  const bytes = await readFile(path);
  // Preserve a BOM so a malformed baseline is not silently rewritten.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && rel !== '..' && !isAbsolute(rel));
}
async function physicalPath(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await physicalPath(parent), relative(parent, path));
  }
}
async function newOutput(path) {
  const out = resolve(path), physical = await physicalPath(out), repository = await realpath(root);
  for (const candidate of [out, physical]) {
    if (inside(repository, candidate) && !['outputs', 'private', 'data', 'submission'].some(folder => inside(join(repository, folder), candidate) && candidate !== join(repository, folder))) {
      throw new Error('Use a NEW subdirectory in outputs/, private/, data/ or submission/ to keep generated/private data out of Git.');
    }
  }
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out); // atomic reservation; rejects files, links and existing runs
  return out;
}
const writeJson = (out, name, value) => writeFile(join(out, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv[0] === '--help' || argv[0] === 'help') { console.log(usage); return 0; }
  const command = argv[0];
  if (!['check', 'export'].includes(command)) throw new Error('Unknown command. Use locqa --help.');
  const options = Object.fromEntries(['source', 'target', 'out', 'source-locale', 'target-locale', ...(command === 'check' ? ['glossary', 'length-ratio', 'short-limit', 'length-minimum'] : ['reviews'])].map(name => [name, { type: 'string' }]));
  const { values: a } = parseArgs({ args: argv.slice(1), options, strict: true, allowPositionals: false });
  for (const key of ['source', 'target', 'out', command === 'check' ? 'glossary' : 'reviews']) if (!a[key]) throw new Error('Missing --' + key);
  const [sourceText, targetText, extraText] = await Promise.all([readUtf8(a.source), readUtf8(a.target), readUtf8(a.glossary ?? a.reviews)]);
  const inputs = { sourceText, targetText, sourceLocale: a['source-locale'], targetLocale: a['target-locale'] };
  const out = await newOutput(a.out);
  try {
    if (command === 'check') {
      const result = checkArbs({ ...inputs, glossaryText: extraText,
        ...(a['length-ratio'] !== undefined ? { lengthRatio: Number(a['length-ratio']) } : {}),
        ...(a['short-limit'] !== undefined ? { shortLimit: Number(a['short-limit']) } : {}),
        ...(a['length-minimum'] !== undefined ? { lengthMinimum: Number(a['length-minimum']) } : {}) });
      for (const name of ['report', 'bundle', 'diagnostics', 'trace', 'audit', 'manifest']) await writeJson(out, name, result[name]);
      console.log(`${result.report.length} findings; ${result.manifest.structural_errors} structural errors. Results: ${out}`);
      return result.manifest.structural_errors ? 2 : result.report.length ? 1 : 0;
    }
    const result = exportApproved({ ...inputs, reviews: JSON.parse(extraText) });
    const locale = JSON.parse(extraText).target_locale;
    if (!/^[A-Za-z0-9_-]+$/.test(locale)) throw new Error('Unsafe locale for export filename.');
    await writeFile(join(out, `intl_${locale}_fixed.arb`), result.text, { flag: 'wx' });
    await writeJson(out, 'export-audit', result.audit);
    console.log(`Exported ${result.audit.changed_count} approved changes. Flutter verification required: ${out}`);
    return 0;
  } catch (error) {
    await writeJson(out, 'failure', { status: 'failed', error: error.message, flutter_verified: false });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
