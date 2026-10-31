import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertContract } from '../../src/contracts.mjs';
import { args, readJson, main, assertSafeOutput } from '../../src/io.mjs';
import { createModel, validateReviews, restoreWorkspace } from './model.mjs';
import { scorePrecisionReview } from '../../src/human-evaluation.mjs';

// JSON is data, even when the input contains HTML closing tags.
export function embedJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export async function renderHtml(bundle, report, options = {}) {
  if (options.workspace !== undefined && options.reviews !== undefined) throw new Error('Use either --workspace or --reviews; combining them would replace the saved review journal.');
  if (options.workspace?.imported_precision && options.precisionSample !== undefined) throw new Error('The workspace already contains a precision sample; import its replacement explicitly in the UI.');
  assertContract('bundle', bundle);
  assertContract('report', report);
  const model = createModel(bundle, report);
  if (options.reviews !== undefined) {
    assertContract('reviews', options.reviews);
    await validateReviews(options.reviews, model);
  }
  if (options.workspace !== undefined) await restoreWorkspace(options.workspace, model);
  if (options.precisionSample !== undefined) scorePrecisionReview(options.precisionSample, report);
  const [template, style, modelCode, precisionCode, client] = await Promise.all(
    ['template.html', 'style.css', 'model.mjs', 'precision.mjs', 'client.mjs'].map(name => readFile(new URL(name, import.meta.url), 'utf8'))
  );
  const inline = code => code.replace(/^import .+ from '\.\/(?:model|precision)\.mjs';\r?\n/gm, '').replace(/\bexport\s+(?=(?:async\s+)?function|const|let|class)/g, '');
  const runtime = inline(modelCode) + '\n' + inline(precisionCode) + '\n' + client;
  const payload = { bundle, report, reviews: options.reviews ?? null, workspace: options.workspace ?? null, precisionSample: options.precisionSample ?? null, synthetic: Boolean(options.synthetic) };
  return template.replace('/* REPORT_STYLE */', () => style)
    .replace('/* REPORT_DATA */', () => embedJson(payload))
    .replace('/* REPORT_RUNTIME */', () => runtime);
}

async function run() {
  const a = args({ bundle: { type: 'string' }, report: { type: 'string' }, out: { type: 'string' }, reviews: { type: 'string' }, workspace: { type: 'string' }, 'precision-sample': { type: 'string' }, synthetic: { type: 'boolean', default: false } }, ['bundle', 'report', 'out']);
  await assertSafeOutput(a.out, [a.bundle, a.report, a.reviews, a.workspace, a['precision-sample']].filter(Boolean));
  const [bundle, report, reviews, workspace, precisionSample] = await Promise.all([readJson(a.bundle), readJson(a.report), a.reviews ? readJson(a.reviews) : undefined, a.workspace ? readJson(a.workspace) : undefined, a['precision-sample'] ? readJson(a['precision-sample']) : undefined]);
  const html = await renderHtml(bundle, report, { reviews, workspace, precisionSample, synthetic: a.synthetic });
  await mkdir(dirname(resolve(a.out)), { recursive: true });
  await writeFile(a.out, html, 'utf8');
  console.log(`HTML report: ${resolve(a.out)} (${report.length} findings). No human approvals created.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(run);
