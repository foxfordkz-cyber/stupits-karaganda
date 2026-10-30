export type IssueType =
  | 'untranslated' | 'same_as_source' | 'placeholder_mismatch' | 'plural_mismatch'
  | 'glossary_violation' | 'length_overflow' | 'machine_translation_suspect'
  | 'inconsistent_term' | 'suffix_harmony' | 'orthography' | 'wrong_language';
export interface Finding {
  key: string; issue_type: IssueType; severity: 'high' | 'medium' | 'low';
  source: string; target: string; evidence: string; suggestion: string;
  confidence: number; reviewed_by_human: boolean;
}
export interface Entry {
  entry_id: string; key: string; occurrence: number; source: string; target: string | null;
  source_hash: string; target_hash: string | null;
  context: { section?: string | null; description?: string | null; references?: Record<string,string> };
}
export interface Bundle {
  schema_version: '1.0'; source_locale: string; target_locale: string; entries: Entry[];
}
export interface HumanDecision {
  key: string; entry_id: string; decision: 'accepted' | 'edited' | 'rejected';
  original_text: string | null; approved_text: string | null;
  source_hash: string; original_hash: string | null; approved_hash: string | null;
  reviewer: string; reviewed_at: string; reviewed_by_human: true;
}
export interface Reviews { schema_version: '1.0'; target_locale: string; decisions: HumanDecision[]; }
