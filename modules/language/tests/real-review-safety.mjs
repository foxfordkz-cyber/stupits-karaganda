// Called explicitly by review-smoke with real owner components. Decisions below
// are in-memory contract test doubles, not human review and never published.
import assert from 'node:assert/strict';
import { hashText } from '../../../src/contracts.mjs';
import { assessReviews } from '../review-gate.mjs';

export function verifyRealSafety(core, linguistics) {
  const reviewer = 'SYNTHETIC_TEST_DOUBLE_NOT_HUMAN';
  const cases = [
    ['safe_spelling', 'Подарок', 'Сыйлык', 'Сыйлық', 'READY_FOR_INTEGRATOR'],
    ['placeholder_drop', 'Привет, {name}!', 'Сәлем, {name}!', 'Сәлем!', 'BLOCKED'],
    ['icu_invalid', '{n, plural, one {Один} other {Много}}', '{n, plural, one {Бір} other {Көп}}', '{n, plural, one {Бір}}', 'BLOCKED'],
    ['protected_newline', 'Первая\nВторая', 'Бірінші\nЕкінші', 'Бірінші Екінші', 'BLOCKED'],
    ['private_use_icon', '\ue001 Баланс', '\ue001 Қалдық', 'Қалдық', 'BLOCKED'],
  ];
  const results = [];
  for (const [name, source, target, proposed, expected] of cases) {
    const sourceText = JSON.stringify({ '@@locale': 'ru', test: source });
    const targetText = JSON.stringify({ '@@locale': 'kk', test: target });
    const { bundle } = core.normalizeArbs({ sourceText, targetText });
    const e = bundle.entries[0];
    const f = { key: e.key, issue_type: 'orthography', severity: 'low', source, target,
      evidence: 'Synthetic contract exercise; not a real linguistic judgment.', suggestion: proposed, confidence: 0.5, reviewed_by_human: false };
    const queue = { kind: 'bekzat-language-review-queue', version: 2, rows: [{ ...e, ...f, finding_index: 0,
      status: 'pending_human_review', candidates: [{ candidate_id: name, text: proposed, text_hash: hashText(proposed), reviewed_by_human: false }] }] };
    const reviews = { schema_version: '1.0', target_locale: 'kk', decisions: [{ key: e.key, entry_id: e.entry_id,
      decision: 'accepted', original_text: target, approved_text: proposed, source_hash: e.source_hash,
      original_hash: e.target_hash, approved_hash: hashText(proposed), reviewer, reviewed_at: '2026-10-31T00:00:00Z', reviewed_by_human: true }] };
    const g = assessReviews({ bundle, report: [f], queue, reviews, authorizedReviewers: [reviewer], core, linguistics, sourceText, targetText });
    assert.equal(g.status, expected, name);
    assert.equal(g.source_arb_modified, false);
    results.push({ case: name, status: 'passed', expected_gate_status: expected });
  }
  return { cases: results, decision_boundary: 'in_memory_contract_test_doubles_only', human_reviews_obtained: 0 };
}
