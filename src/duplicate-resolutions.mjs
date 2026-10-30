import { assertContract, hashText } from './contracts.mjs';
import { inspectArb, isFlutterResourceName } from './arb-audit.mjs';

export function verifyResolutions(resolutions, sourceText, originalText, original = inspectArb(originalText)) {
  if (resolutions === undefined || resolutions === null) return new Map();
  assertContract('duplicate-resolutions', resolutions);
  if (resolutions.source_sha256 !== hashText(sourceText) || resolutions.original_target_sha256 !== hashText(originalText)) {
    throw new Error('Duplicate resolutions refer to different source/original files');
  }
  const result = new Map();
  for (const decision of resolutions.decisions) {
    if (!decision.key.trim() || !decision.reviewer.trim()) throw new Error('Duplicate resolution key/reviewer must not be blank');
    if (result.has(decision.key)) throw new Error('Repeated duplicate resolution: ' + decision.key);
    const conflict = original.duplicates.find(d=>d.key===decision.key && d.conflicting);
    if (!conflict) throw new Error('Resolution does not identify a conflicting target key: '+decision.key);
    const chosen=conflict.occurrences.find(e=>e.occurrence===decision.occurrence);
    if (!chosen || hashText(chosen.text)!==decision.chosen_hash) throw new Error('Resolution occurrence/hash mismatch: '+decision.key);
    result.set(decision.key,{...decision,chosen_text:chosen.text});
  }
  return result;
}

export function auditInputs(sourceText, targetText) {
  const source=inspectArb(sourceText),target=inspectArb(targetText);
  const targetConflicts=target.duplicates.filter(d=>d.conflicting);
  return {
    scope:'input_structure_audit_not_error_ground_truth',
    source_sha256:hashText(sourceText),original_target_sha256:hashText(targetText),
    source_locale:source.metadata.get('@@locale') ?? null,target_locale:target.metadata.get('@@locale') ?? null,
    source_unique_strings:source.strings.size,target_unique_strings:target.strings.size,
    missing_target_keys:[...source.strings.keys()].filter(k=>!target.strings.has(k)),
    empty_target_keys:[...target.strings].filter(([,v])=>v==='').map(([k])=>k),
    extra_target_keys:[...target.strings.keys()].filter(k=>!source.strings.has(k)),
    same_as_source_candidates:[...source.strings].filter(([k,v])=>target.strings.get(k)===v).map(([k])=>k),
    source_duplicate_keys:source.duplicates.map(d=>({key:d.key,conflicting:d.conflicting,count:d.occurrences.length})),
    target_duplicate_keys:target.duplicates.map(d=>({key:d.key,conflicting:d.conflicting,count:d.occurrences.length})),
    suspicious_resource_identifiers:[...new Set([...source.strings.keys(),...target.strings.keys()])].filter(k=>!isFlutterResourceName(k)),
    duplicate_review_queue:targetConflicts.map(d=>({
      key:d.key,source:source.strings.get(d.key) ?? null,
      candidates:d.occurrences.map(e=>({occurrence:e.occurrence,text:e.text,chosen_hash:hashText(e.text)})),
      selected_occurrence:null,reviewer:null,reviewed_at:null,reviewed_by_human:false
    })),
    notes:[
      'Exact matches include legitimate brands/names/numbers and are candidates, not confirmed errors.',
      'The review queue contains no human approvals. A person must select a variant and attest a separate resolution.',
      'Original runtime baseline remains the last occurrence. Any changed value also needs a normal exact-text review and ARB stamp.',
      'Suspicious identifiers require an actual Flutter check; this audit is not compiler evidence.'
    ]
  };
}
