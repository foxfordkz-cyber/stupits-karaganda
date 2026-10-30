import { createHash } from 'node:crypto';

export const ISSUE_TYPES = Object.freeze([
  'untranslated', 'same_as_source', 'placeholder_mismatch', 'plural_mismatch',
  'glossary_violation', 'length_overflow', 'machine_translation_suspect',
  'inconsistent_term', 'suffix_harmony', 'orthography', 'wrong_language',
]);
const types = new Set(ISSUE_TYPES);

function validateLabel(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object');
  if (typeof value.key !== 'string' || !value.key.trim()) throw new TypeError(label + '.key must be a non-empty string');
  if (!types.has(value.issue_type)) throw new TypeError(label + '.issue_type must be one of the 11 documented issue types');
}

/** Validate the entire population before selecting any human review sample. */
export function validateReport(report) {
  if (!Array.isArray(report)) throw new TypeError('report must be an array');
  report.forEach((finding, index) => {
    const label = 'report[' + index + ']';
    validateLabel(finding, label);
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
  return report;
}

function identity(finding) { return JSON.stringify([finding.key, finding.issue_type]); }

function labelsToMap(values, name) {
  if (!Array.isArray(values)) throw new TypeError(name + ' must be an array');
  const result = new Map();
  values.forEach((value, index) => {
    validateLabel(value, name + '[' + index + ']');
    result.set(identity(value), { key: value.key, issue_type: value.issue_type });
  });
  return result;
}

function comparePairs(a, b) { return identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0; }

function metrics(tp, fp, fn) {
  return {
    tp, fp, fn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    f1: 2 * tp + fp + fn === 0 ? null : 2 * tp / (2 * tp + fp + fn),
    support: tp + fn, predicted: tp + fp,
  };
}

/** Score a completely labelled LOCAL set, one locale per run, using exact key/type pairs. */
export function evaluate(gold, predicted) {
  const expected = labelsToMap(gold, 'gold');
  const actual = labelsToMap(predicted, 'predicted');
  const tp = [], fp = [], fn = [];
  for (const [id, pair] of actual) (expected.has(id) ? tp : fp).push(pair);
  for (const [id, pair] of expected) if (!actual.has(id)) fn.push(pair);
  for (const list of [tp, fp, fn]) list.sort(comparePairs);
  return {
    schema_version: 1,
    evaluation_scope: 'local_labeled_set',
    matching: 'exact_key_and_issue_type_single_locale',
    assumptions: [
      'Gold labels must completely describe the evaluated local set.',
      "These results are not recall on the organizers' hidden seeded errors.",
      'Undefined precision, recall, or F1 denominators are represented as null.',
    ],
    counts: {
      gold_rows: gold.length, predicted_rows: predicted.length,
      gold_unique: expected.size, predicted_unique: actual.size,
      duplicate_gold_rows: gold.length - expected.size,
      duplicate_predicted_rows: predicted.length - actual.size,
    },
    micro: metrics(tp.length, fp.length, fn.length),
    per_type: Object.fromEntries(ISSUE_TYPES.map((type) => [type, metrics(
      tp.filter((p) => p.issue_type === type).length,
      fp.filter((p) => p.issue_type === type).length,
      fn.filter((p) => p.issue_type === type).length,
    )])),
    true_positives: tp, false_positives: fp, false_negatives: fn,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

/** Reproducible sample without replacement; human answers always start unset. */
export function sampleForReview(report, { size = 100, seed } = {}) {
  validateReport(report);
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size must be a non-negative safe integer');
  if (typeof seed !== 'string' || !seed.trim()) throw new TypeError('seed must be a non-empty string');
  const unique = new Map();
  for (const finding of report) {
    const id = identity(finding);
    if (unique.has(id) && stableJson(unique.get(id)) !== stableJson(finding)) throw new Error('Conflicting duplicate finding for ' + id + '; resolve it before sampling');
    unique.set(id, finding);
  }
  const ranked = [...unique].map(([id, finding]) => ({
    id, finding, rank: createHash('sha256').update(JSON.stringify([seed, id]), 'utf8').digest('hex'),
  })).sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    schema_version: 1,
    evaluation_scope: 'human_precision_sample',
    seed, sampling_method: 'sha256_seeded_rank_without_replacement',
    report_sha256: createHash('sha256').update(stableJson([...report].sort((a,b)=>identity(a)<identity(b)?-1:identity(a)>identity(b)?1:0)), 'utf8').digest('hex'),
    population_size: unique.size, duplicate_report_rows: report.length - unique.size,
    requested_size: size, sample_size: Math.min(size, unique.size),
    instructions: 'A human must mark whether each finding and its issue type are correct. Keep unreviewed answers null. Fix the seed before inspection; do not choose a seed for favourable results.',
    rows: ranked.slice(0, size).map(({ id, finding }) => ({
      sample_id: createHash('sha256').update(id, 'utf8').digest('hex'),
      finding_sha256: createHash('sha256').update(stableJson(finding), 'utf8').digest('hex'),
      finding: structuredClone(finding), reviewed: null, correct: null, reviewer: null, reviewed_at: null, notes: '',
    })),
  };
}
