import { assertContract } from '../../src/contracts.mjs';
import { readArb, localeOf, createBundle, arbSnapshot } from './arb.mjs';
import { parseGlossary } from './glossary.mjs';
import { inspectMessage, compareMessages, visibleLength, protectedTokens, hasLinguisticText } from './messages.mjs';
import { baselinePlan } from './baseline-plan.mjs';
import { isDirect, stageMain, runCheckStage } from './stages.mjs';

export function checkArbs({ sourceText, targetText, glossaryText, sourceLocale, targetLocale, lengthRatio = 2, shortLimit = 20, lengthMinimum = 10 }) {
  for (const [name, value] of Object.entries({ lengthRatio, shortLimit, lengthMinimum })) if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
  const source = readArb(sourceText, 'source'), target = readArb(targetText, 'target');
  sourceLocale = localeOf(source, sourceLocale); targetLocale = localeOf(target, targetLocale);
  const diagnostics = [...source.diagnostics, ...target.diagnostics];
  const bundle = createBundle(source, target, sourceLocale, targetLocale, diagnostics);
  const analyzed = checkBundle(bundle, { glossaryText, lengthRatio, shortLimit, lengthMinimum });
  diagnostics.push(...analyzed.diagnostics);
  return { bundle, report: analyzed.report, diagnostics, trace: analyzed.trace, baselinePlan: baselinePlan(source, target), audit: { source: arbSnapshot(source), target: arbSnapshot(target) },
    manifest: { schema_version: '1.0', mode: 'live_core_detection', source_sha256: source.sha256, target_sha256: target.sha256,
      source_locale: sourceLocale, target_locale: targetLocale, glossary_rows: analyzed.glossary_rows, entries: bundle.entries.length, findings: analyzed.report.length,
      structural_errors: diagnostics.filter(d => d.severity === 'error').length, node: process.version, icu: process.versions.icu,
      length_policy: analyzed.length_policy, flutter_verified: false } };
}

export function checkBundle(bundle, { glossaryText, lengthRatio = 2, shortLimit = 20, lengthMinimum = 10 } = {}) {
  assertContract('bundle', bundle);
  for (const [name, value] of Object.entries({ lengthRatio, shortLimit, lengthMinimum })) if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
  const sourceLocale = bundle.source_locale, targetLocale = bundle.target_locale, diagnostics = [];
  const glossary = glossaryText === undefined ? { unchanged: new Set(), rowCount: 0 } : parseGlossary(glossaryText, sourceLocale, targetLocale);
  const sources = new Map();
  for (const entry of bundle.entries) {
    if (sources.has(entry.key) && sources.get(entry.key) !== entry.source) throw new Error('Conflicting source texts in bundle: ' + entry.key);
    sources.set(entry.key, entry.source);
  }
  const report = [], trace = [], fingerprints = new Map(), sourceCache = new Map();
  function finding(entry, issue_type, severity, evidence, confidence) {
    const value = { key: entry.key, issue_type, severity, source: entry.source, target: entry.target ?? '', evidence, suggestion: '', confidence, reviewed_by_human: false };
    const fingerprint = JSON.stringify(value);
    let index = fingerprints.get(fingerprint);
    if (index === undefined) { index = report.length; report.push(value); trace.push({ report_index: index, entry_ids: [] }); fingerprints.set(fingerprint, index); }
    trace[index].entry_ids.push(entry.entry_id);
  }
  for (const entry of bundle.entries) {
    let original = sourceCache.get(entry.key);
    if (original === undefined) {
      try {
        original = inspectMessage(entry.source, sourceLocale);
        const errors = [...original.pluralErrors, ...original.placeholderErrors];
        if (errors.length) throw new Error(errors.join('; '));
      } catch (error) {
        diagnostics.push({ code: 'source_message_invalid', severity: 'error', side: 'source', key: entry.key, evidence: error.message }); original = null;
      }
      sourceCache.set(entry.key, original);
    }
    if (entry.target === null || entry.target.trim() === '') {
      if (entry.source.trim()) finding(entry, 'untranslated', 'high', entry.target === null ? 'Target key is absent (occurrence 0).' : 'Target exists but is empty or whitespace-only.', 1);
      continue;
    }
    if (entry.source === entry.target && /\p{L}/u.test(entry.source) && !glossary.unchanged.has(entry.source.trim().toLocaleLowerCase())) {
      // Pure technical messages (e.g. {count}) are not untranslated prose.
      const letters = original && hasLinguisticText(original.ast);
      if (letters) finding(entry, 'same_as_source', 'medium', 'Exact source/target match; no unchanged-term exception in the supplied glossary. Names and brands still need context.', 0.85);
    }
    let current;
    try { current = inspectMessage(entry.target, targetLocale); }
    catch (error) {
      diagnostics.push({ code: 'target_message_invalid', severity: 'error', side: 'target', key: entry.key, occurrence: entry.occurrence, evidence: error.message });
      if (original) finding(entry, original.controls.some(n => n.type === 6) || /PLURAL/.test(error.message) ? 'plural_mismatch' : 'placeholder_mismatch', 'high', 'Target ICU parse failed: ' + error.message, 1);
      continue;
    }
    if (!original) continue;
    const comparison = compareMessages(original, current);
    if (comparison.pluralErrors.length) finding(entry, 'plural_mismatch', 'high', comparison.pluralErrors.join('; '), 0.98);
    if (comparison.placeholderErrors.length) finding(entry, 'placeholder_mismatch', 'high', comparison.placeholderErrors.join('; '), 1);
    if (JSON.stringify(protectedTokens(entry.source)) !== JSON.stringify(protectedTokens(entry.target))) diagnostics.push({ code: 'protected_token_mismatch', severity: 'error', side: 'target', key: entry.key, occurrence: entry.occurrence, evidence: 'Line breaks, control/font/special symbols, entities or escaped literal braces differ from source.' });
    const sourceLength = visibleLength(original.ast, sourceLocale), targetLength = visibleLength(current.ast, targetLocale);
    if (sourceLength > 0 && sourceLength <= shortLimit && targetLength >= lengthMinimum && targetLength > sourceLength * lengthRatio) finding(entry, 'length_overflow', 'low', `Heuristic: ${targetLength} visible graphemes vs ${sourceLength} in source; threshold >${lengthRatio}x for source <=${shortLimit}. Runtime values, font and actual widget width are unknown.`, 0.65);
  }
  assertContract('report', report);
  return { report, diagnostics, trace, glossary_rows: glossary.rowCount,
    length_policy: { ratio: lengthRatio, short_limit: shortLimit, minimum: lengthMinimum } };
}

if (isDirect(import.meta.url)) await stageMain(() => runCheckStage(checkBundle));
