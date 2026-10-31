import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { assertContract, hashText } from '../../src/contracts.mjs';
import { prepareBlindReview, scoreBlindReview, scorePrecisionReview, stableJson } from '../../src/human-evaluation.mjs';
import { sampleForReview } from '../../src/evaluation.mjs';
import { humanReviewCases } from './human-review-cases.mjs';
import { privatePath, readJson, writeAtomicNew } from './review-io.mjs';

export function buildPacket(seed) {
  const source = { '@@locale': 'ru' }, original = { '@@locale': 'kk' }, fixed = { '@@locale': 'kk' };
  const report = humanReviewCases.map(([key, issue_type, s, t, p, category, evidence]) => {
    source[key] = s; original[key] = t; fixed[key] = p;
    return { key, issue_type, severity: 'medium', source: s, target: t, evidence, suggestion: p,
      confidence: 0.5, reviewed_by_human: false };
  });
  assertContract('report', report);
  const inputs = { sourceText: JSON.stringify(source), originalText: JSON.stringify(original), fixedText: JSON.stringify(fixed) };
  const blind = prepareBlindReview(inputs, { size: report.length, seed });
  const precision = sampleForReview(report, { size: report.length, seed });
  return { inputs, report, blind, precision,
    coordinator: { provenance: 'AI-authored synthetic hypotheses; not detector output or validated labels',
      categories: humanReviewCases.map(([key, , , , , category]) => ({ key, category })),
      source_data_used: false, human_reviews_obtained: 0 } };
}

export function scorePacket({ packet, blindSheet = packet.blind.sheet, precisionSheet = packet.precision,
  authorizedReviewers = [], gateArtifact = null }) {
  if (!Array.isArray(authorizedReviewers) || authorizedReviewers.some(r => typeof r !== 'string' || !r.trim())) throw Error('Invalid reviewer policy');
  for (const row of [...blindSheet.rows.filter(r => r.preference !== null), ...precisionSheet.rows.filter(r => r.reviewed !== null)]) {
    if (!authorizedReviewers.includes(row.reviewer)) throw Error('Reviewed sheet contains reviewer outside supplied policy');
  }
  const blind = scoreBlindReview(blindSheet, packet.blind.key, packet.inputs);
  const precision = scorePrecisionReview(precisionSheet, packet.report);
  let accepted = 0, edited = 0, rejected = 0;
  if (gateArtifact) {
    assertContract('reviews', gateArtifact.imported_reviews);
    if (gateArtifact.gate.kind !== 'bekzat-human-review-gate' || gateArtifact.binding.imported_reviews_hash !== hashText(stableJson(gateArtifact.imported_reviews)) ||
        gateArtifact.gate.dispositions.length !== gateArtifact.imported_reviews.decisions.length ||
        gateArtifact.imported_reviews.decisions.some(d => !gateArtifact.gate.dispositions.some(r => r.entry_id === d.entry_id && r.decision === d.decision && r.codes.length === 0))) throw Error('Gate decision snapshot is stale or incomplete');
    if (!['READY_FOR_INTEGRATOR','ALREADY_HANDED_OFF','NO_APPROVED_CHANGES','HUMAN_REVIEW_PENDING'].includes(gateArtifact.gate.status) || gateArtifact.gate.problems.length) throw Error('Only successfully audited gate decisions can be counted');
    for (const d of gateArtifact.imported_reviews.decisions) {
      if (!authorizedReviewers.includes(d.reviewer)) throw Error('Decision reviewer outside supplied policy');
      if (d.decision === 'accepted') accepted++; else if (d.decision === 'edited') edited++; else rejected++;
    }
  }
  const total = accepted + edited + rejected, any = total + blind.reviewed + precision.reviewed;
  return { kind: 'bekzat-human-review-evaluation', version: 1,
    status: any ? 'SUPPLIED_HUMAN_REVIEWS_SCORED' : 'HUMAN_REVIEW_PENDING',
    human_identity_verified: false, human_decisions_created: 0,
    decision_scope: gateArtifact ? 'separate version-bound gate handoff; not inferred from blind preferences' : 'no gate decisions supplied',
    decision_counts: { accepted, edited, rejected, reviewed: total },
    acceptance_rate: total ? (accepted + edited) / total : null,
    rejection_rate: total ? rejected / total : null,
    false_positive_review_rate: precision.reviewed ? precision.rejected / precision.reviewed : null,
    correction_quality: blind.correction_win_rate,
    denominators: { acceptance_and_rejection: total, false_positive_review: precision.reviewed,
      correction_quality: blind.assessed },
    blind, precision,
    limitations: ['Acceptance includes accepted + edited official decisions; these decisions are separate from A/B preferences.',
      'False-positive review rate is rejected findings / reviewed findings, not statistical FPR over negative strings.',
      'Correction quality is proposed variant wins / assessed A/B or tie answers; cannot_assess is excluded.',
      'Synthetic deliberately mixed hypotheses do not estimate real detector precision.',
      'Counts rely on supplied attestations and allowlist; tools cannot authenticate a human or native fluency.'] };
}

export function preparePacket(out) {
  const dir = privatePath(out); if (existsSync(dir)) throw Error('Packet output must be new');
  const packet = buildPacket(randomBytes(32).toString('hex')); mkdirSync(dir, { recursive: true });
  writeAtomicNew(join(dir, 'coordinator', 'packet.json'), packet);
  writeAtomicNew(join(dir, 'reviewer', 'blind-sheet.json'), packet.blind.sheet);
  // Distribute this AFTER blind answers are frozen, to avoid revealing proposals.
  writeAtomicNew(join(dir, 'second-pass', 'precision-sheet.json'), packet.precision);
  const summary = scorePacket({ packet });
  writeAtomicNew(join(dir, 'evaluation.json'), summary);
  writeAtomicNew(join(dir, 'ready.json'), { status: 'HUMAN_REVIEW_PENDING', synthetic_cases: packet.report.length,
    instructions: 'Give reviewer only reviewer/blind-sheet.json first. After freezing it, distribute second-pass/precision-sheet.json. Keep coordinator private. Partial directories without ready.json are incomplete.',
    human_decisions_created: 0 });
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values: v } = parseArgs({ options: Object.fromEntries(['prepare','packet','blind','precision','gate','reviewers-file','out'].map(k => [k, { type: 'string' }])) });
    let result;
    if (v.prepare) result = preparePacket(v.prepare);
    else {
      if (!v.packet || !v.out || !existsSync(join(v.packet, 'ready.json'))) throw Error('Complete packet and new output required');
      const packet = readJson(join(v.packet, 'coordinator', 'packet.json'));
      result = scorePacket({ packet, blindSheet: v.blind ? readJson(v.blind) : packet.blind.sheet,
        precisionSheet: v.precision ? readJson(v.precision) : packet.precision,
        gateArtifact: v.gate ? readJson(v.gate) : null,
        authorizedReviewers: v['reviewers-file'] ? readJson(v['reviewers-file']).reviewers : [] });
      writeAtomicNew(v.out, result);
    }
    console.log(JSON.stringify({ status: result.status, reviewed_blind: result.blind.reviewed,
      reviewed_findings: result.precision.reviewed, human_decisions_created: 0 }));
  } catch { console.error('Human evaluation failed; check immutable packet, supplied answers and reviewer policy. No successful score claimed.'); process.exitCode = 1; }
}
