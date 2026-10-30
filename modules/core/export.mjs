import { modify, applyEdits } from 'jsonc-parser';
import { assertContract, hashText } from '../../src/contracts.mjs';
import { checkRelease } from '../../src/release-gate.mjs';
import { readArb, localeOf, entryId } from './arb.mjs';
import { inspectMessage, compareMessages, protectedTokens } from './messages.mjs';

const stampFields = ['reviewed_by_human', 'reviewer', 'reviewed_at', 'source_hash', 'original_hash', 'approved_hash'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Pure function. The caller writes a NEW file only after every approval and
// technical invariant has passed. There is intentionally no auto-approve API.
export function exportApproved({ sourceText, targetText, reviews, sourceLocale, targetLocale }) {
  assertContract('reviews', reviews);
  const source = readArb(sourceText, 'source'), target = readArb(targetText, 'target');
  sourceLocale = localeOf(source, sourceLocale); targetLocale = localeOf(target, targetLocale);
  if (reviews.target_locale !== targetLocale) throw new Error('Reviews target_locale does not match target.');
  const structural = [...source.diagnostics, ...target.diagnostics].filter(d => d.severity === 'error');
  if (structural.length) throw new Error('Export blocked by ARB structure: ' + structural.map(d => `${d.side}/${d.key ?? d.path}: ${d.code}`).join('; '));
  for (const [key, group] of source.groups) {
    const message = inspectMessage(group[0].value, sourceLocale);
    const errors = [...message.pluralErrors, ...message.placeholderErrors];
    if (errors.length) throw new Error(`Invalid source message ${key}: ${errors.join('; ')}`);
  }
  const decisions = new Map(), changed = [], invalidated = [];
  for (const d of reviews.decisions) {
    const original = target.groups.get(d.key)?.[0]?.value ?? null;
    const sourceValue = source.groups.get(d.key)?.[0]?.value;
    if (sourceValue === undefined || d.entry_id !== entryId(d.key, original === null ? 0 : 1)) throw new Error('Review identity does not match baseline: ' + d.entry_id);
    if (d.source_hash !== hashText(sourceValue)) throw new Error('Stale source approval: ' + d.key);
    if (d.original_text !== original || d.original_hash !== hashText(original)) throw new Error('Stale original approval: ' + d.key);
    decisions.set(d.key, d);
  }
  let text = targetText;
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: targetText.includes('\r\n') ? '\r\n' : '\n' };
  const set = (path, value) => { text = applyEdits(text, modify(text, path, value, { formattingOptions })); };
  if (!target.metadata.has('@@locale')) set(['@@locale'], targetLocale);
  for (const [key, property] of target.metadata) {
    if (!key.startsWith('@') || key.startsWith('@@')) continue;
    const stamp = property.value?.['x-locqa'];
    if (!stamp) continue;
    const d = decisions.get(key.slice(1));
    const current = target.groups.get(key.slice(1))?.[0]?.value;
    const valid = stamp.reviewed_by_human === true && d && d.decision !== 'rejected' && current === d.approved_text && stampFields.every(field => stamp[field] === d[field]);
    // False/test stamps are retained as false. Unverifiable true stamps must not
    // survive as claims about a changed source/target/version.
    if (stamp.reviewed_by_human === true && !valid) { set([key, 'x-locqa'], undefined); invalidated.push(key.slice(1)); }
  }
  for (const d of reviews.decisions) {
    if (d.decision === 'rejected' || d.approved_text === d.original_text) continue;
    set([d.key], d.approved_text);
    const metadataKey = '@' + d.key;
    // Preserve target metadata. For a missing translation, retain source
    // placeholder declarations/context rather than inventing them.
    if (!target.metadata.has(metadataKey)) {
      const inherited = { ...(source.metadata.get(metadataKey)?.value ?? {}) };
      delete inherited['x-locqa'];
      set([metadataKey], inherited);
    }
    set([metadataKey, 'x-locqa'], Object.fromEntries(stampFields.map(field => [field, d[field]])));
    changed.push(d.key);
  }
  const fixed = readArb(text, 'fixed');
  for (const [key, group] of fixed.groups) {
    const value = group[0].value, sourceValue = source.groups.get(key)?.[0]?.value;
    if (sourceValue === undefined) continue;
    const original = inspectMessage(sourceValue, sourceLocale), current = inspectMessage(value, targetLocale);
    const errors = [...original.pluralErrors, ...original.placeholderErrors];
    const compared = compareMessages(original, current);
    errors.push(...compared.pluralErrors, ...compared.placeholderErrors);
    if (errors.length) throw new Error(`Export blocked by technical mismatch for ${key}: ${errors.join('; ')}`);
    if (!equal(protectedTokens(sourceValue), protectedTokens(value))) throw new Error('Export would change protected source tokens: ' + key);
    if (changed.includes(key)) {
      const oldValue = target.groups.get(key)?.[0]?.value;
      // Existing target-only special symbols are not discarded by a correction.
      // A conflicting baseline needs an explicitly coordinated resolution.
      if (oldValue !== undefined) {
        const oldTokens = protectedTokens(oldValue, true);
        const remaining = [...protectedTokens(value)];
        for (const token of oldTokens) {
          const index = remaining.indexOf(token);
          if (index < 0) throw new Error('Export would drop protected original-target token: ' + key);
          remaining.splice(index, 1);
        }
      }
    }
  }
  const release = checkRelease({ sourceText, originalText: targetText, fixedText: text, report: [], reviews });
  if (release.errors.length) throw new Error('Independent release check failed: ' + release.errors.join('; '));
  return { text, audit: { mode: 'approved_changes_only', source_sha256: source.sha256, original_sha256: target.sha256,
    fixed_sha256: hashText(text), applied_entry_ids: reviews.decisions.filter(d => changed.includes(d.key)).map(d => d.entry_id),
    invalidated_stamps: invalidated, changed_count: changed.length, flutter_verified: false, release } };
}
