// Validates supplied decisions; never authors approvals or writes a corrected ARB.
import { existsSync, readdirSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { assertContract, hashText } from '../../src/contracts.mjs';
import { stableJson } from '../../src/human-evaluation.mjs';
import { privatePath, readText, readJson, writeAtomicNew, withStateLock } from './review-io.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const hash = value => hashText(stableJson(value));
const same = (a, b) => stableJson(a) === stableJson(b);
const versionToken = (locale, d) => hash([locale, d.entry_id, d.source_hash, d.original_hash]);
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};

export function assessReviews({ bundle, report, queue, reviews, authorizedReviewers = [], core,
  linguistics, sourceText, targetText }) {
  assertContract('bundle', bundle); assertContract('report', report); assertContract('reviews', reviews);
  if (queue.kind !== 'bekzat-language-review-queue' || queue.version !== 2 || !Array.isArray(queue.rows)) throw new Error('queue_v2_required');
  if (queue.rows.some(r => r.reviewed_by_human !== false || r.status !== 'pending_human_review')) throw new Error('machine_approval_forbidden');
  if (!Array.isArray(authorizedReviewers) || authorizedReviewers.some(s => typeof s !== 'string' || !s.trim())) throw new Error('invalid_reviewer_policy');
  const entries = new Map(bundle.entries.map(e => [e.entry_id, e]));
  const keys = new Map();
  for (const e of bundle.entries) keys.set(e.key, (keys.get(e.key) ?? 0) + 1);
  const scope = new Map();
  for (const row of queue.rows) {
    const e = entries.get(row.entry_id), f = report[row.finding_index];
    if (!e || !f || row.key !== e.key || row.occurrence !== e.occurrence || row.source_hash !== e.source_hash ||
        row.target_hash !== e.target_hash || row.source !== e.source || row.target !== e.target || !same(row.context, e.context)) throw new Error('stale_queue_binding');
    if (Object.keys(f).some(k => !same(f[k], row[k]))) throw new Error('stale_queue_finding');
    for (const candidate of row.candidates ?? []) {
      if (candidate.reviewed_by_human !== false || candidate.text_hash !== hashText(candidate.text)) throw new Error('invalid_candidate');
    }
    const rows = scope.get(e.entry_id) ?? []; rows.push(row); scope.set(e.entry_id, rows);
  }
  const problems = [], dispositions = [], technical = [];
  if (reviews.target_locale !== bundle.target_locale) problems.push({ code: 'review_locale_mismatch' });
  for (const d of reviews.decisions) {
    const e = entries.get(d.entry_id), rows = scope.get(d.entry_id) ?? [];
    const codes = [];
    if (!e || e.key !== d.key || !rows.length) codes.push('outside_language_queue');
    if (e && keys.get(e.key) !== 1) codes.push('duplicate_occurrence_requires_integrator');
    if (e && d.source_hash !== e.source_hash) codes.push('stale_source_approval');
    if (e && (d.original_hash !== e.target_hash || d.original_text !== e.target)) codes.push('stale_original_approval');
    if (!authorizedReviewers.includes(d.reviewer)) codes.push('reviewer_not_authorized_by_supplied_policy');
    if (d.decision === 'accepted' && !rows.some(r => r.candidates.some(c => c.text === d.approved_text && c.text_hash === d.approved_hash))) codes.push('accepted_text_is_not_current_candidate_use_edited');
    if (codes.length) problems.push({ entry_id: d.entry_id, codes });
    dispositions.push({ entry_id: d.entry_id, decision: d.decision, codes });
  }
  if (core) {
    const normalized = core.normalizeArbs({ sourceText, targetText, sourceLocale: bundle.source_locale, targetLocale: bundle.target_locale });
    if (!same(normalized.bundle, bundle) || normalized.diagnostics?.some(d => d.severity === 'error')) problems.push({ code: 'arb_bundle_binding_or_structure' });
    for (const row of queue.rows) for (const c of row.candidates) {
      const original = entries.get(row.entry_id);
      const candidateBundle = { ...bundle, entries: [{ ...original, target: c.text, target_hash: c.text_hash }] };
      const checked = core.checkBundle(candidateBundle);
      technical.push({ candidate_id: c.candidate_id, entry_id: row.entry_id,
        status: checked.diagnostics.some(d => d.severity === 'error') || checked.report.some(f => ['placeholder_mismatch', 'plural_mismatch', 'untranslated'].includes(f.issue_type)) ? 'failed' : 'core_checks_passed',
        report: checked.report, diagnostics: checked.diagnostics, human_approval: false });
    }
  }
  let audit = null;
  if (linguistics) {
    audit = linguistics.auditReviews(bundle, reviews);
    if (audit.status === 'failed') problems.push({ code: 'linguistics_audit_failed' });
  }
  const approved = reviews.decisions.filter(d => d.decision !== 'rejected');
  let dryRun = null;
  if (approved.length && !problems.length) {
    if (!core || !linguistics) problems.push({ code: 'real_core_and_linguistics_required' });
    else {
      try {
        const exported = core.exportApproved({ sourceText, targetText, reviews,
          sourceLocale: bundle.source_locale, targetLocale: bundle.target_locale });
        // Discard exported.text. Only the owner's exporter may publish a final ARB.
        dryRun = { status: 'passed', fixed_sha256: hashText(exported.text), audit: exported.audit, flutter_verified: false };
      } catch { problems.push({ code: 'core_export_preflight_rejected' }); }
    }
  }
  // A blocked batch must not make its entries disappear from the pending list.
  const decided = new Set(problems.length ? [] : reviews.decisions.map(d => d.entry_id));
  const pending = [...scope.keys()].filter(id => !decided.has(id)).sort();
  const status = problems.length ? 'BLOCKED' : approved.length ? 'READY_FOR_INTEGRATOR' :
    pending.length || !reviews.decisions.length ? 'HUMAN_REVIEW_PENDING' : 'NO_APPROVED_CHANGES';
  return { kind: 'bekzat-human-review-gate', version: 1, status, problems, dispositions,
    unconfirmed_entry_ids: pending, proposal_conflicts: [...scope].filter(([, rows]) => rows.some(r => r.conflicting_candidate_ids?.length)).map(([id]) => id),
    technical, components: { core: Boolean(core), linguistics: Boolean(linguistics) },
    linguistics_audit: audit, core_preflight: dryRun,
    approved_reviews: status === 'READY_FOR_INTEGRATOR' ? { ...reviews, decisions: approved } : null,
    human_decisions_created: 0, human_identity_verified: false, source_arb_modified: false,
    limitations: ['Supplied reviewer allowlist and hashes are not authentication or proof of native review.',
      'Readiness covers this handoff only; unresolved findings and final Flutter/release checks remain separate.'] };
}

export function commitHandoff(state, gate, binding, { afterCommit } = {}) {
  if (gate.status !== 'READY_FOR_INTEGRATOR') return { gate, receipt: null };
  state = privatePath(state);
  assertContract('reviews', gate.approved_reviews);
  if (!gate.approved_reviews.decisions.length || gate.approved_reviews.decisions.some(d => d.decision === 'rejected') ||
      gate.core_preflight?.status !== 'passed') throw new Error('invalid_handoff');
  const directory = join(state, 'receipts'); mkdirSync(directory, { recursive: true });
  const wanted = gate.approved_reviews.decisions.map(d => ({ version: versionToken(gate.approved_reviews.target_locale, d), approved_hash: d.approved_hash }));
  const previous = new Map();
  for (const name of readdirSync(directory).filter(n => n.endsWith('.json')).sort()) {
    const receipt = readJson(join(directory, name));
    const { receipt_id, ...payload } = receipt;
    if (receipt_id !== hash(payload) || name !== receipt_id + '.json' || receipt.kind !== 'bekzat-approved-handoff' || receipt.version !== 1) throw new Error('corrupt_handoff_state');
    assertContract('reviews', receipt.reviews);
    for (const d of receipt.reviews.decisions) {
      const token = versionToken(receipt.reviews.target_locale, d);
      if (previous.has(token)) throw new Error('conflicting_handoff_state');
      previous.set(token, { approved_hash: d.approved_hash, receipt_id });
    }
  }
  const overlap = wanted.filter(t => previous.has(t.version));
  if (overlap.length) {
    const conflict = overlap.some(t => previous.get(t.version).approved_hash !== t.approved_hash);
    const status = conflict ? 'CONFLICTING_PREVIOUS_HANDOFF' : overlap.length === wanted.length ? 'ALREADY_HANDED_OFF' : 'PARTIALLY_HANDED_OFF';
    return { gate: { ...gate, status, approved_reviews: null }, receipt: null,
      previous_receipt_ids: [...new Set(overlap.map(t => previous.get(t.version).receipt_id))].sort() };
  }
  const payload = { kind: 'bekzat-approved-handoff', version: 1, binding,
    reviews: gate.approved_reviews, core_preflight: gate.core_preflight,
    human_decisions_created: 0, requires_integrator_export: true, flutter_verified: false };
  const receipt = { ...payload, receipt_id: hash(payload) };
  writeAtomicNew(join(directory, receipt.receipt_id + '.json'), receipt);
  afterCommit?.(); // Failure-injection seam: a persisted receipt survives interrupted output publication.
  return { gate, receipt };
}

async function component(root, path, required) {
  if (!root) return null;
  const file = resolve(root, path);
  if (!existsSync(file)) throw new Error('requested_component_missing');
  const api = await import(pathToFileURL(file));
  if (required.some(name => typeof api[name] !== 'function')) throw new Error('component_contract_missing');
  return api;
}

export async function runReviewGate(options) {
  const started = performance.now();
  const { bundle, report, details, reviews, source, target, state, out, coreRoot, linguisticsRoot, reviewersFile } = options;
  const output = privatePath(out), ledger = privatePath(state);
  if (existsSync(output)) throw new Error('output_exists');
  if (inside(ledger, output)) throw new Error('output_inside_ledger');
  const inputs = [bundle, report, reviews, source, target, join(details, 'review_queue.json'),
    join(details, 'finding_index.json'), join(details, 'proposals.json'), join(details, 'metrics.json'), ...(reviewersFile ? [reviewersFile] : [])];
  for (const file of inputs) {
    const path = realpathSync(file);
    if (path === output || inside(ledger, path)) throw new Error('input_output_overlap');
  }
  const data = { bundle: readJson(bundle), report: readJson(report), queue: readJson(join(details, 'review_queue.json')),
    reviews: readJson(reviews), sourceText: readText(source), targetText: readText(target) };
  const metrics = readJson(join(details, 'metrics.json'));
  const python = options.python || process.env.LOCQA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const argv = [join(moduleDir, 'verify_queue.py'), '--bundle', resolve(bundle), '--report', resolve(report),
    '--index', resolve(details, 'finding_index.json'), '--proposals', resolve(details, 'proposals.json'), '--queue', resolve(details, 'review_queue.json')];
  if (metrics.selection === 'first_n') argv.push('--limit', String(metrics.selected_records));
  const checked = spawnSync(python, argv, { cwd: moduleDir, encoding: 'utf8', timeout: 120000, maxBuffer: 100000, windowsHide: true });
  if (checked.status !== 0 || checked.error) throw new Error('queue_snapshot_validation_failed');
  const core = await component(coreRoot, 'modules/core/index.mjs', ['normalizeArbs', 'checkBundle', 'exportApproved']);
  const linguistics = await component(linguisticsRoot, 'modules/linguistics/workflow.mjs', ['auditReviews']);
  const policy = reviewersFile ? readJson(reviewersFile) : { reviewers: [] };
  const gate = assessReviews({ ...data, authorizedReviewers: policy.reviewers, core, linguistics });
  gate.scan_scope = { selection: metrics.selection, selected_records: metrics.selected_records,
    available_input_records: metrics.available_input_records, bundle_entries: metrics.bundle_entries,
    entries_delegated_to_core: metrics.entries_delegated_to_core };
  if (metrics.status !== 'complete') {
    gate.status = 'BLOCKED'; gate.approved_reviews = null; gate.problems.push({ code: 'language_scan_incomplete' });
  }
  const binding = { source_file_sha256: hashText(data.sourceText), target_file_sha256: hashText(data.targetText),
    bundle_hash: hash(data.bundle), report_hash: hash(data.report), queue_hash: hash(data.queue),
    imported_reviews_hash: hash(data.reviews), reviewer_policy_hash: hash(policy), scan_metrics_hash: hash(metrics) };
  return withStateLock(ledger, () => {
    const result = commitHandoff(ledger, gate, binding);
    const artifact = { ...result, binding, imported_reviews: data.reviews,
      execution: { elapsed_seconds: (performance.now() - started) / 1000, provider_requests: 0,
        provider_cost_usd: 0, cost_scope: 'No external model calls; excludes compute and subscriptions.' },
      review_status: gate.status === 'HUMAN_REVIEW_PENDING' ? 'HUMAN_REVIEW_PENDING' : 'SUPPLIED_DECISIONS_AUDITED' };
    writeAtomicNew(output, artifact);
    return { status: result.gate.status, receipt_id: result.receipt?.receipt_id ?? null,
      unconfirmed_entries: gate.unconfirmed_entry_ids.length, human_decisions_created: 0 };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const names = ['bundle','report','details','reviews','source','target','state','out','core-root','linguistics-root','reviewers-file','python'];
    const { values } = parseArgs({ options: Object.fromEntries(names.map(k => [k, { type: 'string' }])) });
    if (names.slice(0, 8).some(k => !values[k])) throw new Error('missing_arguments');
    const result = await runReviewGate({ ...values, coreRoot: values['core-root'], linguisticsRoot: values['linguistics-root'], reviewersFile: values['reviewers-file'] });
    console.log(JSON.stringify(result));
    if (['BLOCKED','CONFLICTING_PREVIOUS_HANDOFF','PARTIALLY_HANDED_OFF'].includes(result.status)) process.exitCode = 2;
  } catch {
    console.error('Human review gate failed validation or publication; no successful handoff claimed. Preserve existing receipts and inputs.');
    process.exitCode = 1;
  }
}
