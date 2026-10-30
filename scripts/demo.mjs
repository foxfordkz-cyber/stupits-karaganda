import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { assertContract } from '../src/contracts.mjs';
import { mergeReports } from '../src/report-merge.mjs';
import { evaluate, sampleForReview } from '../src/evaluation.mjs';
import { main, readJson, writeJson } from '../src/io.mjs';

await main(async () => {
  const base = new URL('../fixtures/synthetic/',import.meta.url);
  const fixture = assertContract('report',await readJson(new URL('report.sample.json',base)));
  const gold = await readJson(new URL('gold.json',base));
  const {report} = mergeReports([fixture]);
  const metrics = evaluate(gold,report);
  metrics.scope='synthetic_fixture_playback';
  metrics.warning='The report is a prepared fixture, not output of a detector. These scores do not measure model quality.';
  const out=resolve('outputs/demo');
  await mkdir(out,{recursive:true});
  await writeJson(join(out,'report.json'),report);
  await writeJson(join(out,'metrics.json'),metrics);
  await writeJson(join(out,'review-sample.json'),sampleForReview(report,{size:100,seed:'synthetic-demo-v1'}));
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rows=report.map(f=>'<tr><td>'+escape(f.key)+'</td><td>'+escape(f.issue_type)+'</td><td>'+escape(f.source)+'</td><td>'+escape(f.target)+'</td><td>'+escape(f.evidence)+'</td></tr>').join('');
  const html='<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LocQA — synthetic integration demo</title><style>body{font:16px system-ui;margin:32px;color:#17212b}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd3db;padding:12px;text-align:left;vertical-align:top}.notice{padding:18px;background:#fff0bd}td{overflow-wrap:anywhere}</style><body><h1>Синтетическое демо интеграции</h1><p class="notice">Воспроизведение подготовленного примера. Детектор здесь не запускался; качество модели и реальных переводов не измерено. Человеческие проверки не выполнены.</p><table><thead><tr><th>Ключ</th><th>Тип</th><th>Оригинал</th><th>Перевод</th><th>Объяснение</th></tr></thead><tbody>'+rows+'</tbody></table></body></html>';
  await writeFile(join(out,'report.html'),html);
  console.log('SYNTHETIC PLAYBACK ONLY — outputs/demo/report.html');
});
