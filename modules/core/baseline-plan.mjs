import { hashText } from '../../src/contracts.mjs';
import { entryId } from './arb.mjs';

// This is a module-owned diagnostic sidecar, not a fourth shared contract or a
// review ledger. No choices are applied and no human decision is fabricated.
export function baselinePlan(source, target) {
  const issues = [];
  for (const [side, arb] of [['source', source], ['target', target]]) {
    for (const diagnostic of arb.diagnostics.filter(d => d.severity === 'error')) {
      const properties = diagnostic.key === undefined ? [] : arb.properties.filter(p => p.key === diagnostic.key);
      const occurrences = properties.map(p => ({
        occurrence: p.occurrence,
        entry_id: p.kind === 'message' && p.key.trim() && p.key.isWellFormed() ? entryId(p.key, p.occurrence) : null,
        value: p.value, value_hash: typeof p.value === 'string' ? hashText(p.value) : null,
        property_sha256: hashText(p.raw), section: p.section,
        offset: p.offset, line: p.line, column: p.column
      }));
      const identical = diagnostic.code === 'duplicate_key' && new Set(properties.map(p => JSON.stringify(p.value))).size === 1;
      issues.push({
        id: `${side}:${issues.length + 1}`, side, code: diagnostic.code, key: diagnostic.key ?? null,
        path: diagnostic.path ?? null, evidence: diagnostic.evidence, occurrences,
        position: { offset: diagnostic.offset, line: diagnostic.line, column: diagnostic.column },
        kind: diagnostic.code === 'duplicate_key' ? (identical ? 'identical_duplicate' : 'conflicting_duplicate') : diagnostic.code,
        requires_integrator_decision: !identical,
        required_action: diagnostic.code === 'duplicate_key'
          ? identical ? 'Exporter can deduplicate identical values while recording all occurrences and contexts; no translation approval is invented.' : 'Use the agreed human duplicate-resolutions ledger for target conflicts; source conflicts remain blocked.'
          : diagnostic.code === 'invalid_resource_name' ? 'Integrator must approve a collision-free rename or metadata migration and its effect on application references.'
          : 'Integrator must resolve this structural defect against the original file hash.',
        decision: null
      });
    }
  }
  return { format: 'locqa-core-baseline-plan/v1', scope: 'arb_structure_only', status: issues.some(i => i.requires_integrator_decision) ? 'needs_integrator_decisions' : issues.length ? 'identical_duplicates_audit_required' : 'no_structural_decisions',
    source_sha256: source.sha256, target_sha256: target.sha256, decisions_applied: 0,
    issues, note: 'Diagnostic draft only. Originals remain the baseline; filling this file is not authorization to change translations or proof of human linguistic review.' };
}
