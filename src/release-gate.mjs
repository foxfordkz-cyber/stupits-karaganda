import { assertContract, hashText } from './contracts.mjs';
import { inspectArb, technicalSignature } from './arb-audit.mjs';

export function checkRelease({ sourceText, originalText, fixedText, report, reviews }) {
  assertContract('report', report); assertContract('reviews', reviews);
  const source = inspectArb(sourceText), original = inspectArb(originalText), fixed = inspectArb(fixedText);
  const errors = [], warnings = [], changed = [];
  for (const [name,arb] of [['source',source],['original-target',original],['fixed',fixed]]) {
    for (const path of arb.nestedDuplicates) errors.push(`${name}: duplicate metadata attribute ${path}`);
    for (const d of arb.duplicates) {
      if (d.conflicting || name === 'fixed') errors.push(`${name}: ${d.conflicting ? 'conflicting' : 'repeated'} key ${d.key}; explicit resolution required`);
      else warnings.push(`${name}: identical duplicate key ${d.key}`);
    }
  }
  if (fixed.metadata.get('@@locale') !== reviews.target_locale) errors.push('Fixed @@locale and review target_locale must match');
  if (original.metadata.has('@@locale') && original.metadata.get('@@locale') !== reviews.target_locale) errors.push('Original target locale does not match reviews');
  const decisions = new Map();
  for (const d of reviews.decisions) {
    if (decisions.has(d.key)) errors.push('Multiple review decisions for key ' + d.key);
    decisions.set(d.key, d);
    const originalValue = original.strings.has(d.key) ? original.strings.get(d.key) : null;
    const occurrence = original.entries.filter(e => e.key === d.key).length;
    if (d.entry_id !== encodeURIComponent(d.key) + '#' + occurrence) errors.push('Review entry_id does not match original occurrence: ' + d.key);
    if (!source.strings.has(d.key) || d.source_hash !== hashText(source.strings.get(d.key))) errors.push('Stale source review: ' + d.key);
    if (d.original_text !== originalValue || d.original_hash !== hashText(originalValue)) errors.push('Stale original review: ' + d.key);
  }
  for (const key of original.strings.keys()) if (!fixed.strings.has(key)) errors.push('Dropped original key: ' + key);
  for (const [key,value] of fixed.strings) {
    if (!original.strings.has(key) && !source.strings.has(key)) errors.push('New key absent from source: ' + key);
    const old = original.strings.has(key) ? original.strings.get(key) : null;
    if (old !== value) {
      changed.push(key);
      const d = decisions.get(key);
      if (!d || d.decision === 'rejected' || d.approved_text !== value || d.approved_hash !== hashText(value)) {
        errors.push('Changed text lacks current human approval: ' + key);
      } else {
        const stamp = fixed.metadata.get('@' + key)?.['x-locqa'];
        for (const field of ['reviewed_by_human','reviewer','reviewed_at','source_hash','original_hash','approved_hash']) {
          if (!stamp || stamp[field] !== d[field]) errors.push('Missing/mismatched ARB review stamp ' + field + ': ' + key);
        }
      }
    }
    if (source.strings.has(key)) {
      try {
        const expected = technicalSignature(source.strings.get(key));
        const actual = technicalSignature(value);
        for (const field of ['placeholders','printf','tags']) {
          if (JSON.stringify(expected[field]) !== JSON.stringify(actual[field])) errors.push('Technical mismatch ' + field + ': ' + key);
        }
        for (const requirement of expected.icuRequirements) {
          if (!actual.icuRequirements.includes(requirement)) errors.push('ICU requirement missing or changed: ' + key + ': ' + requirement);
        }
      } catch (error) { errors.push('ICU/placeholder parse failed for ' + key + ': ' + error.message); }
    }
  }
  for (const d of reviews.decisions) {
    if (d.decision !== 'rejected' && fixed.strings.get(d.key) !== d.approved_text) errors.push('Approved change was not exported: ' + d.key);
  }
  for (const f of report) {
    if (!source.strings.has(f.key) || source.strings.get(f.key) !== f.source) errors.push('Report source does not match input: ' + f.key);
    if ((original.strings.get(f.key) ?? '') !== f.target) errors.push('Report target does not match original input: ' + f.key);
  }
  const missing = [...source.strings.keys()].filter(k => !fixed.strings.has(k));
  if (missing.length) warnings.push(`${missing.length} source keys still lack target translations`);
  if (!changed.length) warnings.push('No changed strings; this does not demonstrate correction quality');
  return {
    status: errors.length ? 'failed' : 'preflight_passed',
    scope: 'artifact_consistency_only',
    flutter_verified: false,
    changed_count: changed.length,
    reviewed_changed_count: changed.filter(k => {
      const d = decisions.get(k);
      const old = original.strings.has(k) ? original.strings.get(k) : null;
      const stamp = fixed.metadata.get('@'+k)?.['x-locqa'];
      return d && d.decision !== 'rejected' && d.approved_text === fixed.strings.get(k)
        && source.strings.has(k) && d.source_hash === hashText(source.strings.get(k)) && d.original_hash === hashText(old)
        && d.entry_id === encodeURIComponent(k)+'#'+original.entries.filter(e=>e.key===k).length
        && stamp && ['reviewed_by_human','reviewer','reviewed_at','source_hash','original_hash','approved_hash'].every(field=>stamp[field]===d[field]);
    }).length,
    missing_target_count: missing.length,
    errors: [...new Set(errors)], warnings: [...new Set(warnings)],
    limitations: [
      'A review record is an attestation, not independent proof of human identity or translation quality.',
      'Conflicting input duplicates require an explicit, recorded resolution before release.',
      'Run flutter-smoke separately on these exact source and fixed files.',
      'Length, naturalness and actual in-game rendering are outside this preflight.'
    ]
  };
}
