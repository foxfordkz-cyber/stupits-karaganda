// Browser-compatible reader for existing human_precision_sample files.
// Matches src/evaluation.mjs + src/human-evaluation.mjs; never fills human answers.
import { sha256 } from './model.mjs';

export function precisionStableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(precisionStableJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + precisionStableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

const precisionHashValue = value => sha256(precisionStableJson(value));
const precisionIdentity = finding => JSON.stringify([finding.key, finding.issue_type]);
const precisionTypes = new Set([
  'untranslated', 'same_as_source', 'placeholder_mismatch', 'plural_mismatch',
  'glossary_violation', 'length_overflow', 'machine_translation_suspect',
  'inconsistent_term', 'suffix_harmony', 'orthography', 'wrong_language'
]);
function precisionObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(name + ' must be an object');
}
function precisionExact(a, b, message) {
  if (precisionStableJson(a) !== precisionStableJson(b)) throw new Error(message);
}
function precisionTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map((item, index) => index > 0 && index < 7 ? Number(item) : item);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && hour <= 23 && minute <= 59 && second <= 59;
}
function precisionAttestation(row, name) {
  if (typeof row.reviewer !== 'string' || !row.reviewer.trim()) throw new Error(name + ': reviewed answer requires a named reviewer');
  if (!precisionTimestamp(row.reviewed_at)) throw new Error(name + ': reviewed answer requires a valid ISO reviewed_at with timezone');
}
function precisionNoAttestation(row, name) {
  if (row.reviewer !== null && row.reviewer !== undefined) throw new Error(name + ': unreviewed answer must have null reviewer');
  if (row.reviewed_at !== null && row.reviewed_at !== undefined) throw new Error(name + ': unreviewed answer must have null reviewed_at');
}
function precisionValidateReport(report) {
  if (!Array.isArray(report)) throw new TypeError('report must be an array');
  report.forEach((finding, index) => {
    const label = 'report[' + index + ']';
    precisionObject(finding, label);
    if (typeof finding.key !== 'string' || !finding.key.trim()) throw new TypeError(label + '.key must be a non-empty string');
    if (!precisionTypes.has(finding.issue_type)) throw new TypeError(label + '.issue_type must be one of the 11 documented issue types');
    for (const field of ['key', 'issue_type', 'severity', 'source', 'target', 'evidence', 'suggestion', 'confidence', 'reviewed_by_human']) {
      if (!Object.hasOwn(finding, field)) throw new TypeError(label + '.' + field + ' is required');
    }
    if (!['high', 'medium', 'low'].includes(finding.severity)) throw new TypeError(label + '.severity must be high, medium, or low');
    for (const field of ['source', 'target', 'evidence', 'suggestion']) {
      if (typeof finding[field] !== 'string') throw new TypeError(label + '.' + field + ' must be a string');
    }
    if (!finding.evidence.trim()) throw new TypeError(label + '.evidence must not be empty');
    if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) throw new TypeError(label + '.confidence must be a finite number between 0 and 1');
    if (typeof finding.reviewed_by_human !== 'boolean') throw new TypeError(label + '.reviewed_by_human must be a boolean');
  });
}
function precisionWilson95(successes, total) {
  if (!total) return { lower: null, upper: null, confidence_level: 0.95, method: 'wilson_score' };
  const z = 1.959963984540054, p = successes / total, z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denominator;
  return { lower: Math.max(0, centre - radius), upper: Math.min(1, centre + radius), confidence_level: 0.95, method: 'wilson_score' };
}

/** Reconstruct the frozen sample and count only existing, complete human answers. */
export async function validatePrecision(sample, report) {
  precisionObject(sample, 'sample');
  precisionValidateReport(report);
  const size = sample.requested_size === undefined ? 100 : sample.requested_size;
  const seed = sample.seed;
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative safe integer');
  if (typeof seed !== 'string' || !seed.trim()) throw new TypeError('seed must be a non-empty string');
  const unique = new Map();
  for (const finding of report) {
    const id = precisionIdentity(finding);
    if (unique.has(id) && precisionStableJson(unique.get(id)) !== precisionStableJson(finding)) throw new Error('Conflicting duplicate finding for ' + id + '; resolve it before sampling');
    unique.set(id, finding);
  }
  const ranked = await Promise.all([...unique].map(async ([id, finding]) => ({
    id, finding, rank: await sha256(JSON.stringify([seed, id]))
  })));
  ranked.sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const expected = {
    schema_version: 1,
    evaluation_scope: 'human_precision_sample',
    sampling_method: 'sha256_seeded_rank_without_replacement',
    population_size: unique.size,
    duplicate_report_rows: report.length - unique.size,
    requested_size: size,
    sample_size: Math.min(size, unique.size)
  };
  for (const name of ['schema_version', 'evaluation_scope', 'sampling_method', 'population_size', 'duplicate_report_rows', 'requested_size', 'sample_size']) {
    precisionExact(sample[name], expected[name], 'Sample metadata changed: ' + name);
  }
  if (!Array.isArray(sample.rows) || sample.rows.length !== expected.sample_size) throw new Error('Sample rows must contain every originally selected finding exactly once');
  const reportHash = await precisionHashValue([...report].sort((a, b) => precisionIdentity(a) < precisionIdentity(b) ? -1 : precisionIdentity(a) > precisionIdentity(b) ? 1 : 0));
  if (sample.report_sha256 !== undefined && sample.report_sha256 !== reportHash) throw new Error('Sample report_sha256 is stale');
  const byId = new Map(await Promise.all(ranked.slice(0, size).map(async row => [await sha256(row.id), row])));
  const seen = new Set(), reviewers = new Set();
  let reviewed = 0, confirmed = 0, rejected = 0;
  for (const row of sample.rows) {
    precisionObject(row, 'sample row');
    if (row.notes !== undefined && typeof row.notes !== 'string') throw new Error(row.sample_id + ': notes must be a string');
    const original = byId.get(row.sample_id);
    if (!original || seen.has(row.sample_id)) throw new Error('Unknown or duplicate sample_id: ' + row.sample_id);
    seen.add(row.sample_id);
    precisionExact(row.finding, original.finding, 'Finding changed after sampling: ' + row.sample_id);
    if (row.finding_sha256 !== undefined && row.finding_sha256 !== await precisionHashValue(row.finding)) throw new Error('Stale finding_sha256: ' + row.sample_id);
    if (row.reviewed === null) {
      if (row.correct !== null) throw new Error('Unreviewed finding must have correct=null: ' + row.sample_id);
      precisionNoAttestation(row, row.sample_id);
    } else if (row.reviewed === true) {
      if (typeof row.correct !== 'boolean') throw new Error('Reviewed finding requires correct=true or false: ' + row.sample_id);
      precisionAttestation(row, row.sample_id);
      reviewed++;
      row.correct ? confirmed++ : rejected++;
      reviewers.add(row.reviewer.trim());
    } else throw new Error('reviewed must be null or true: ' + row.sample_id);
  }
  const complete = reviewed === expected.sample_size;
  const observed = reviewed ? confirmed / reviewed : null;
  return {
    schema_version: 1, evaluation_scope: 'human_precision_sample_results',
    report_sha256: reportHash,
    population_binding: sample.report_sha256 === undefined ? 'legacy_selected_findings_only' : 'whole_report_sha256',
    seed: sample.seed, sampling_method: expected.sampling_method,
    population_size: expected.population_size, sample_size: expected.sample_size,
    reviewed, confirmed, rejected, unreviewed: expected.sample_size - reviewed, complete,
    precision_on_reviewed: observed,
    report_precision_estimate: complete && sample.report_sha256 !== undefined ? observed : null,
    wilson95_on_reviewed: precisionWilson95(confirmed, reviewed),
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
