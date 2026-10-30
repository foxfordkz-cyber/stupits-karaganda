import { createHash } from 'node:crypto';
import { sampleForReview } from './evaluation.mjs';
import { inspectArb } from './arb-audit.mjs';
import { verifyResolutions } from './duplicate-resolutions.mjs';

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const hashValue = value => hash(stableJson(value));
const findingId = f => JSON.stringify([f.key, f.issue_type]);
const exact = (a, b, message) => { if (stableJson(a) !== stableJson(b)) throw new Error(message); };
function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(name + ' must be an object');
}
function timestamp(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m || !Number.isFinite(Date.parse(value))) return false;
  const [,y,month,day,hour,minute,second] = m.map((v,i) => i > 0 && i < 7 ? Number(v) : v);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(y, month, 0)).getUTCDate()
    && hour <= 23 && minute <= 59 && second <= 59;
}
function attest(row, name) {
  if (typeof row.reviewer !== 'string' || !row.reviewer.trim()) throw new Error(name + ': reviewed answer requires a named reviewer');
  if (!timestamp(row.reviewed_at)) throw new Error(name + ': reviewed answer requires a valid ISO reviewed_at with timezone');
}
function noAttestation(row, name) {
  if (row.reviewer !== null && row.reviewer !== undefined) throw new Error(name + ': unreviewed answer must have null reviewer');
  if (row.reviewed_at !== null && row.reviewed_at !== undefined) throw new Error(name + ': unreviewed answer must have null reviewed_at');
}
function notes(row, name) {
  if (row.notes !== undefined && typeof row.notes !== 'string') throw new Error(name + ': notes must be a string');
}
export function wilson95(successes, total) {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(successes) || total < 0 || successes < 0 || successes > total) throw new TypeError('Wilson counts must be integers with 0 <= successes <= total');
  if (!total) return { lower: null, upper: null, confidence_level: 0.95, method: 'wilson_score' };
  const z = 1.959963984540054, p = successes / total, z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denominator;
  return { lower: Math.max(0, centre - radius), upper: Math.min(1, centre + radius), confidence_level: 0.95, method: 'wilson_score' };
}

/** Reconstruct the selected sample before counting human answers; no answers are inferred. */
export function scorePrecisionReview(sample, report) {
  object(sample, 'sample');
  const expected = sampleForReview(report, { size: sample.requested_size, seed: sample.seed });
  for (const name of ['schema_version','evaluation_scope','sampling_method','population_size','duplicate_report_rows','requested_size','sample_size']) {
    exact(sample[name], expected[name], 'Sample metadata changed: ' + name);
  }
  if (!Array.isArray(sample.rows) || sample.rows.length !== expected.rows.length) throw new Error('Sample rows must contain every originally selected finding exactly once');
  const reportHash = hashValue([...report].sort((a,b) => findingId(a) < findingId(b) ? -1 : findingId(a) > findingId(b) ? 1 : 0));
  if (sample.report_sha256 !== undefined && sample.report_sha256 !== reportHash) throw new Error('Sample report_sha256 is stale');
  const byId = new Map(expected.rows.map(row => [row.sample_id, row]));
  const seen = new Set(), reviewers = new Set();
  let reviewed = 0, confirmed = 0, rejected = 0;
  for (const row of sample.rows) {
    object(row, 'sample row'); notes(row, row.sample_id);
    const original = byId.get(row.sample_id);
    if (!original || seen.has(row.sample_id)) throw new Error('Unknown or duplicate sample_id: ' + row.sample_id);
    seen.add(row.sample_id);
    exact(row.finding, original.finding, 'Finding changed after sampling: ' + row.sample_id);
    if (row.finding_sha256 !== undefined && row.finding_sha256 !== hashValue(row.finding)) throw new Error('Stale finding_sha256: ' + row.sample_id);
    if (row.reviewed === null) {
      if (row.correct !== null) throw new Error('Unreviewed finding must have correct=null: ' + row.sample_id);
      noAttestation(row, row.sample_id);
    } else if (row.reviewed === true) {
      if (typeof row.correct !== 'boolean') throw new Error('Reviewed finding requires correct=true or false: ' + row.sample_id);
      attest(row, row.sample_id);
      reviewed++; row.correct ? confirmed++ : rejected++; reviewers.add(row.reviewer.trim());
    } else throw new Error('reviewed must be null or true: ' + row.sample_id);
  }
  const complete = reviewed === expected.sample_size;
  const observed = reviewed ? confirmed / reviewed : null;
  return {
    schema_version: 1, evaluation_scope: 'human_precision_sample_results',
    report_sha256: reportHash, population_binding: sample.report_sha256 === undefined ? 'legacy_selected_findings_only' : 'whole_report_sha256',
    seed: sample.seed, sampling_method: expected.sampling_method,
    population_size: expected.population_size, sample_size: expected.sample_size,
    reviewed, confirmed, rejected, unreviewed: expected.sample_size - reviewed, complete,
    precision_on_reviewed: observed,
    report_precision_estimate: complete && sample.report_sha256 !== undefined ? observed : null,
    wilson95_on_reviewed: wilson95(confirmed, reviewed),
    reviewers: [...reviewers].sort(),
    limitations: [
      'No recall or hidden-test performance is measured.',
      'Legacy samples without report_sha256 bind selected findings only; they cannot claim a version-bound whole-report precision estimate.',
      'Partial reviews may be selectively completed: only the reviewed subset precision is reported until the sample is complete.',
      'Wilson is a binomial approximation, without a finite-population correction; a full-population review has no sampling uncertainty.',
      'Freeze the report, seed and requested size before inspecting findings. Hashes detect changed inputs, not forged human attestations.'
    ]
  };
}

function sizeAndSeed(size, seed) {
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative integer');
  if (typeof seed !== 'string' || !seed.trim()) throw new TypeError('seed must be non-empty');
}
function readUnambiguous(text, name, allowConflicts = false) {
  if (typeof text !== 'string') throw new TypeError(name + ' must be an ARB string');
  const arb = inspectArb(text);
  if ((!allowConflicts && arb.duplicates.some(d => d.conflicting)) || arb.nestedDuplicates.length) throw new Error(name + ': ambiguous duplicate values/metadata must be resolved before review');
  return arb;
}
function immutableCase(row) { return { case_id: row.case_id, source: row.source, A: row.A, B: row.B }; }
function immutableSheet(sheet) {
  return { schema_version: sheet.schema_version, evaluation_scope: sheet.evaluation_scope, sample_size: sheet.sample_size, instructions: sheet.instructions,
    rows: sheet.rows.map(immutableCase).sort((a,b) => a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0) };
}

/** The answer key and seed are private. The sheet never labels the corrected side. */
export function prepareBlindReview({ sourceText, originalText, fixedText, resolutions }, { size = 150, seed } = {}) {
  sizeAndSeed(size, seed);
  const source = readUnambiguous(sourceText, 'source'), original = readUnambiguous(originalText, 'original-target', true), fixed = readUnambiguous(fixedText, 'fixed');
  const resolved = verifyResolutions(resolutions,sourceText,originalText,original);
  for (const duplicate of original.duplicates) {
    if (duplicate.conflicting && !resolved.has(duplicate.key)) throw new Error('original-target: ambiguous duplicate requires an explicit resolution: '+duplicate.key);
  }
  if (original.metadata.has('@@locale') && fixed.metadata.has('@@locale') && original.metadata.get('@@locale') !== fixed.metadata.get('@@locale')) throw new Error('Original and fixed target locales do not match');
  for (const key of original.strings.keys()) if (!fixed.strings.has(key)) throw new Error('Fixed file dropped original key: ' + key);
  const changed = [];
  for (const [key,value] of fixed.strings) {
    const old = original.strings.has(key) ? original.strings.get(key) : null;
    if (old === value) continue;
    if (!source.strings.has(key)) throw new Error('Changed key has no source text: ' + key);
    changed.push({ key, source: source.strings.get(key), original: old, fixed: value, rank: hash(stableJson([seed,key,'rank'])) });
  }
  changed.sort((a,b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.key < b.key ? -1 : 1);
  const selected = changed.slice(0,size), answers = [], rows = [];
  for (const c of selected) {
    const side = parseInt(hash(stableJson([seed,c.key,'side'])).slice(0,2),16) < 128 ? 'A' : 'B';
    const row = { case_id: hash(stableJson([seed,c.key,'case'])), source: c.source,
      A: side === 'A' ? c.fixed : c.original, B: side === 'B' ? c.fixed : c.original,
      preference: null, reviewer: null, reviewed_at: null, notes: '' };
    rows.push(row);
    answers.push({ case_id: row.case_id, key: c.key, corrected_side: side, case_sha256: hashValue(immutableCase(row)),
      source_sha256: hash(c.source), original_sha256: c.original === null ? null : hash(c.original), fixed_sha256: hash(c.fixed) });
  }
  const sheet = { schema_version: 1, evaluation_scope: 'blind_translation_review', sample_size: rows.length,
    instructions: 'Read the source and both alternatives. Mark A, B, tie, or cannot_assess. null means missing translation; an empty string is a present but empty translation. Do not access the private answer key.',
    rows };
  const key = { schema_version: 1, evaluation_scope: 'private_blind_review_key', seed, requested_size: size,
    changed_population_size: changed.length, sample_size: rows.length, sheet_sha256: hashValue(immutableSheet(sheet)),
    inputs: { source_sha256: hash(sourceText), original_sha256: hash(originalText), fixed_sha256: hash(fixedText), resolutions_sha256: resolutions == null ? null : hashValue(resolutions) }, answers };
  return { sheet, key };
}

/** Input files are required, so changing an answer key cannot detach results from the current files. */
export function scoreBlindReview(sheet, answerKey, inputs) {
  object(sheet,'sheet'); object(answerKey,'answer key'); object(inputs,'inputs');
  for (const field of Object.keys(sheet)) {
    if (!['schema_version','evaluation_scope','sample_size','instructions','rows'].includes(field)) throw new Error('Unexpected blind-sheet field: ' + field);
  }
  if (Array.isArray(sheet.rows)) for (const row of sheet.rows) {
    object(row,'blind row');
    for (const field of Object.keys(row)) {
      if (!['case_id','source','A','B','preference','reviewer','reviewed_at','notes'].includes(field)) throw new Error('Unexpected blind-row field: ' + field);
    }
  }
  const expected = prepareBlindReview(inputs, {size: answerKey.requested_size, seed: answerKey.seed});
  exact(answerKey, expected.key, 'Private answer key changed or input files are stale');
  if (!Array.isArray(sheet.rows) || sheet.rows.length !== expected.sheet.rows.length) throw new Error('Blind sheet must contain all selected rows exactly once');
  exact(immutableSheet(sheet), immutableSheet(expected.sheet), 'Blind sheet text/identity changed after preparation');
  const byId = new Map(answerKey.answers.map(a => [a.case_id,a])), seen = new Set(), reviewers = new Set();
  let reviewed=0, better=0, worse=0, tied=0, cannotAssess=0;
  for (const row of sheet.rows) {
    object(row,'blind row'); notes(row,row.case_id);
    if (seen.has(row.case_id) || !byId.has(row.case_id)) throw new Error('Unknown or repeated blind case: ' + row.case_id);
    seen.add(row.case_id);
    if (row.preference === null) { noAttestation(row,row.case_id); continue; }
    if (!['A','B','tie','cannot_assess'].includes(row.preference)) throw new Error('Invalid blind preference: ' + row.preference);
    attest(row,row.case_id); reviewers.add(row.reviewer.trim()); reviewed++;
    if (row.preference === 'tie') tied++;
    else if (row.preference === 'cannot_assess') cannotAssess++;
    else if (row.preference === byId.get(row.case_id).corrected_side) better++;
    else worse++;
  }
  const assessed = better + worse + tied;
  return { schema_version:1, evaluation_scope:'human_blind_translation_results',
    inputs: answerKey.inputs, sheet_sha256: answerKey.sheet_sha256, sample_size: sheet.sample_size,
    changed_population_size: answerKey.changed_population_size,
    reviewed, unreviewed: sheet.sample_size-reviewed, complete: reviewed===sheet.sample_size,
    better, worse, tied, cannot_assess:cannotAssess, assessed,
    correction_win_rate: assessed ? better/assessed : null,
    net_preference: assessed ? (better-worse)/assessed : null,
    reviewers:[...reviewers].sort(),
    limitations:[
      'Preferences are human attestations; the tool cannot verify reviewer identity, native fluency or independence.',
      'A/B choices and ties are counted only when a named reviewer and timestamp are present.',
      'This comparison does not measure seeded-error recall or overall game rendering quality.',
      'Keep the private answer key and seed inaccessible to reviewers until their decisions are frozen.'
    ] };
}
