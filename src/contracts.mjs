import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const name of ['finding', 'report', 'bundle', 'reviews', 'duplicate-resolutions']) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../contracts/${name}.schema.json`, import.meta.url), 'utf8')));
}
export function hashText(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError('hashText expects string or null');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function assertContract(name, data) {
  const validator = ajv.getSchema(`https://locqa.local/${name}.schema.json`);
  if (!validator) throw new Error(`Unknown contract: ${name}`);
  if (!validator(data)) throw new Error(`${name}: ${ajv.errorsText(validator.errors, { separator: '; ' })}`);
  if (name === 'finding' || name === 'report') {
    for (const finding of name === 'finding' ? [data] : data) {
      if (!finding.key.trim() || !finding.evidence.trim()) throw new Error('Finding key and evidence must not be blank');
    }
  }
  if (name === 'bundle' || name === 'reviews') {
    for (const field of ['source_locale', 'target_locale']) {
      if (field in data) {
        try { Intl.getCanonicalLocales(data[field].replaceAll('_', '-')); }
        catch { throw new Error('Invalid locale: ' + data[field]); }
      }
    }
  }
  if (name === 'bundle') {
    const ids = new Set();
    for (const entry of data.entries) {
      if (ids.has(entry.entry_id)) throw new Error(`Duplicate entry_id: ${entry.entry_id}`);
      ids.add(entry.entry_id);
      if (entry.entry_id !== encodeURIComponent(entry.key) + '#' + entry.occurrence) throw new Error('Invalid entry_id identity: ' + entry.entry_id);
      if (entry.source_hash !== hashText(entry.source) || entry.target_hash !== hashText(entry.target)) throw new Error(`Stale content hash: ${entry.entry_id}`);
      if ((entry.target === null) !== (entry.occurrence === 0)) throw new Error(`Missing target must use occurrence 0: ${entry.entry_id}`);
    }
  }
  if (name === 'reviews') {
    const ids = new Set();
    for (const d of data.decisions) {
      if (ids.has(d.entry_id)) throw new Error(`Multiple decisions for entry_id: ${d.entry_id}`);
      ids.add(d.entry_id);
      if (!d.reviewer.trim()) throw new Error('Reviewer must not be blank');
      if (d.original_hash !== hashText(d.original_text) || d.approved_hash !== hashText(d.approved_text)) throw new Error(`Stale review hash: ${d.entry_id}`);
      if (d.decision === 'rejected' && d.approved_text !== null) throw new Error(`Rejected decision has approved text: ${d.entry_id}`);
      if (d.decision !== 'rejected' && d.approved_text === null) throw new Error(`Approval has no approved text: ${d.entry_id}`);
    }
  }
  return data;
}
