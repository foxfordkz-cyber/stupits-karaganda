import { assertContract, hashText } from '../../src/contracts.mjs';
import { technicalSignature } from '../../src/arb-audit.mjs';

// Module-local CSV reader: no changes to the shared glossary's four-column contract.
export function readGlossary(text) {
  const records = [];
  let row = [], value = '', quoted = false, closed = false;
  const field = () => { row.push(value); value = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else value += c;
    } else if (c === '"' && !value && !closed) quoted = true;
    else if (c === ',') field();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      field(); records.push(row); row = [];
    } else {
      if (c === '"' || closed) throw new Error('Malformed glossary CSV');
      value += c;
    }
  }
  if (quoted) throw new Error('Unclosed glossary CSV quote');
  if (value || row.length || closed) { field(); records.push(row); }
  if (JSON.stringify(records.shift()) !== JSON.stringify(['ru', 'kk', 'en', 'comment'])) {
    throw new Error('Expected glossary header ru,kk,en,comment');
  }
  const keys = new Set();
  return records.map(fields => {
    if (fields.length !== 4 || fields.some(v => !v.trim())) throw new Error('Glossary needs four nonempty fields');
    if (keys.has(fields[0])) throw new Error('Duplicate glossary RU term: ' + fields[0]);
    keys.add(fields[0]);
    return Object.fromEntries(['ru', 'kk', 'en', 'comment'].map((key, i) => [key, fields[i]]));
  });
}

export function csvTable(rows) {
  // Display-only CSV. JSON snapshots retain exact text and are the source of truth.
  return rows.map(row => row.map(value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]|^[\t\r]/u.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}

export function inspectProposal(source, proposal) {
  const errors = [], warnings = [];
  try {
    const expected = technicalSignature(source), actual = technicalSignature(proposal);
    for (const field of ['placeholders', 'printf', 'tags']) {
      if (JSON.stringify(expected[field]) !== JSON.stringify(actual[field])) errors.push('Mismatch: ' + field);
    }
    for (const item of expected.icuRequirements) {
      if (!actual.icuRequirements.includes(item)) errors.push('Missing ICU requirement: ' + item);
    }
  } catch (error) { errors.push('Technical parse failed: ' + error.message); }
  const glyphs = value => [...value].filter(c => /\p{Co}/u.test(c)).sort().join('');
  if (glyphs(source) !== glyphs(proposal)) errors.push('Private-use glyphs changed');
  if ((source.match(/\r\n|\r|\n/g) ?? []).length !== (proposal.match(/\r\n|\r|\n/g) ?? []).length) {
    warnings.push('Line-break count changed; check layout and intentional formatting');
  }
  return { status: errors.length ? 'failed' : 'technical_checks_passed', errors, warnings,
    meaning_verified: false };
}

function checkedBundle(bundle) {
  assertContract('bundle', bundle);
  if (Intl.getCanonicalLocales(bundle.target_locale.replaceAll('_', '-'))[0].split('-')[0] !== 'kk') {
    throw new Error('Linguistics workflow expects target locale kk');
  }
  const byKey = new Map();
  for (const entry of bundle.entries) {
    const group = byKey.get(entry.key) ?? [];
    group.push(entry); byKey.set(entry.key, group);
  }
  return byKey;
}

export function prepareQueue(bundle, report, { batchSize = 25 } = {}) {
  const byKey = checkedBundle(bundle);
  assertContract('report', report);
  if (!Number.isInteger(batchSize) || batchSize < 20 || batchSize > 30) {
    throw new Error('batchSize must be an integer from 20 to 30');
  }
  const groups = new Map(), identities = new Map();
  for (const finding of report) {
    const entries = byKey.get(finding.key);
    if (!entries) throw new Error('Finding absent from bundle: ' + finding.key);
    if (entries.length !== 1) throw new Error('Resolve ambiguous duplicate key before review: ' + finding.key);
    const entry = entries[0];
    if (entry.source !== finding.source || (entry.target ?? '') !== finding.target) {
      throw new Error('Stale finding text: ' + finding.key);
    }
    const identity = JSON.stringify([finding.key, finding.issue_type]);
    const canonical = JSON.stringify(Object.keys(finding).sort().map(key => [key, finding[key]]));
    if (identities.has(identity)) {
      if (identities.get(identity) !== canonical) throw new Error('Conflicting findings: ' + identity);
      continue;
    }
    identities.set(identity, canonical);
    if (!groups.has(entry.entry_id)) groups.set(entry.entry_id, {
      entry_id: entry.entry_id, key: entry.key, source: entry.source,
      original_text: entry.target, source_hash: entry.source_hash, original_hash: entry.target_hash,
      context: structuredClone(entry.context), findings: [], proposals: [],
      status: 'pending', proposed_by: 'input_report', changed_by: null,
      reviewer: null, reviewed_at: null, reviewed_by_human: false,
      final_text: null, decision: null, rationale: '',
    });
    const row = groups.get(entry.entry_id);
    row.findings.push({ issue_type: finding.issue_type, severity: finding.severity,
      evidence: finding.evidence, confidence: finding.confidence, suggestion: finding.suggestion });
    if (finding.suggestion !== '' && !row.proposals.some(p => p.text === finding.suggestion)) {
      row.proposals.push({ text: finding.suggestion, text_hash: hashText(finding.suggestion),
        technical: inspectProposal(entry.source, finding.suggestion) });
    }
  }
  const priority = { high: 0, medium: 1, low: 2 };
  const rank = row => Math.min(...row.findings.map(f => priority[f.severity]));
  const rows = [...groups.values()].sort((a, b) => rank(a) - rank(b)
    || (a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0));
  const batches = [];
  for (let i = 0; i < rows.length; i += batchSize) batches.push({
    workflow_version: '1.0', target_locale: bundle.target_locale,
    batch_id: String(batches.length + 1).padStart(3, '0'), assigned_reviewer: null,
    rows: rows.slice(i, i + batchSize),
  });
  return { rows, batches, reviews: { schema_version: '1.0', target_locale: bundle.target_locale, decisions: [] } };
}

export function pendingTermDecisions(glossaryText) {
  const glossary_hash = hashText(glossaryText);
  return readGlossary(glossaryText).map(term => ({
    term, glossary_hash, status: 'pending', proposed_by: 'AI draft', changed_by: null,
    reviewer: null, reviewed_at: null, reviewed_by_human: false, rationale: '',
  }));
}

// Only inspects decisions supplied by a human. Never creates an approval or changes an ARB.
export function auditReviews(bundle, reviews) {
  const byKey = checkedBundle(bundle);
  assertContract('reviews', reviews);
  if (reviews.target_locale !== bundle.target_locale) throw new Error('Review locale differs from bundle');
  const entries = new Map(bundle.entries.map(entry => [entry.entry_id, entry]));
  const records = reviews.decisions.map(decision => {
    const errors = [], warnings = [];
    const entry = entries.get(decision.entry_id);
    if (!entry || entry.key !== decision.key) errors.push('Review identity absent from bundle');
    else {
      if (byKey.get(entry.key).length !== 1) errors.push('Ambiguous duplicate key requires resolution');
      if (decision.source_hash !== entry.source_hash) errors.push('Stale source approval');
      if (decision.original_text !== entry.target || decision.original_hash !== entry.target_hash) {
        errors.push('Stale original target approval');
      }
      if (decision.decision !== 'rejected') {
        const technical = inspectProposal(entry.source, decision.approved_text);
        errors.push(...technical.errors); warnings.push(...technical.warnings);
      }
    }
    return { entry_id: decision.entry_id, key: decision.key, decision: decision.decision,
      reviewer: decision.reviewer, reviewed_at: decision.reviewed_at,
      source_hash: decision.source_hash, original_hash: decision.original_hash,
      approved_hash: decision.approved_hash, errors, warnings };
  });
  return { workflow_version: '1.0', target_locale: bundle.target_locale,
    status: records.some(r => r.errors.length) ? 'failed' : records.length ? 'consistent' : 'empty',
    scope: 'hash_identity_and_technical_checks_only', decision_count: records.length,
    human_identity_verified: false, meaning_verified: false, records };
}
