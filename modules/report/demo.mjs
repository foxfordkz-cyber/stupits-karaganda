// Fixture playback only: does not run a detector or review translations.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { args, main, readJson } from '../../src/io.mjs';
import { renderHtml } from './render.mjs';

await main(async () => {
  const a = args({ out: { type: 'string' } });
  const requested = resolve(a.out ?? 'outputs/tony-demo');
  await mkdir(dirname(requested), { recursive: true });
  // Repeated default launches get fresh directories, preserving earlier sessions.
  // Explicit destinations stay strict: never silently choose a different directory.
  const out = a.out ? (await mkdir(requested), requested) : await mkdtemp(requested + '-');
  const fixture = fileURLToPath(new URL('../../fixtures/synthetic/', import.meta.url));
  const bundlePath = join(out, 'bundle.sample.json');
  execFileSync(process.execPath, [join(fixture, 'adapters/adapter.mjs'), 'normalize', '--source', join(fixture, 'source.arb'), '--target', join(fixture, 'target.arb'), '--out', bundlePath], { stdio: 'pipe' });
  const bundle = await readJson(bundlePath), report = await readJson(join(fixture, 'report.sample.json'));
  const htmlPath = join(out, 'report.html');
  await writeFile(htmlPath, await renderHtml(bundle, report, { synthetic: true }), 'utf8');
  console.log(`Synthetic review UI: ${htmlPath}\n11 prepared issue types. No detection or human approvals performed.`);
});
