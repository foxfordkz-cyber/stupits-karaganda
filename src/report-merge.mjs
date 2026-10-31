import { assertContract } from './contracts.mjs';
export function mergeReports(reports, { combineSameText = false } = {}) {
  if (combineSameText) return combineReports(reports);
  const seen = new Map();
  let duplicates = 0;
  for (const report of reports) {
    assertContract('report', report);
    for (const finding of report) {
      const identity = JSON.stringify([finding.key, finding.issue_type]);
      const previous = seen.get(identity);
      if (previous) {
        if (JSON.stringify(Object.keys(previous).sort().map(k => [k, previous[k]])) !==
            JSON.stringify(Object.keys(finding).sort().map(k => [k, finding[k]]))) {
          throw new Error('Conflicting findings for ' + finding.key + '/' + finding.issue_type + '; resolve explicitly');
        }
        duplicates++;
      } else seen.set(identity, finding);
    }
  }
  return { report: [...seen.values()].sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.issue_type.localeCompare(b.issue_type, 'en')), duplicates };
}

// Explicit integration policy: retain every distinct explanation for the exact
// same input text. Never select a replacement from conflicting suggestions.
function combineReports(reports) {
  const groups = new Map();
  let duplicates = 0;
  reports.forEach((report, reportIndex) => {
    assertContract('report', report);
    report.forEach((finding, findingIndex) => {
      const key = JSON.stringify([finding.key, finding.issue_type]);
      const variants = groups.get(key) ?? [];
      const signature = JSON.stringify(Object.keys(finding).sort().map(k => [k, finding[k]]));
      const previous = variants.find(v => v.signature === signature);
      const origin = { report_index: reportIndex, finding_index: findingIndex };
      if (previous) { previous.origins.push(origin); duplicates++; }
      else variants.push({ finding, signature, origins: [origin] });
      groups.set(key, variants);
    });
  });
  const combinations = [], report = [];
  const levels = ['low', 'medium', 'high'];
  for (const variants of groups.values()) {
    const first = variants[0].finding;
    if (variants.length === 1) { report.push(first); continue; }
    if (variants.some(v => v.finding.source !== first.source || v.finding.target !== first.target || v.finding.reviewed_by_human !== false)) {
      throw new Error('Conflicting findings for ' + first.key + '/' + first.issue_type + '; different input texts or human status require explicit resolution');
    }
    variants.sort((a, b) => a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);
    const suggestions = new Set(variants.map(v => v.finding.suggestion));
    const combined = { ...first,
      severity: levels[Math.max(...variants.map(v => levels.indexOf(v.finding.severity)))],
      confidence: Math.min(...variants.map(v => v.finding.confidence)),
      suggestion: suggestions.size === 1 ? first.suggestion : '',
      evidence: 'Combined machine observations for the exact same source/target; no suggestion selected.\n' +
        variants.map((v, i) => `[${i + 1}] ${v.finding.evidence}\nSuggestion: ${v.finding.suggestion || '(none)'}`).join('\n\n'),
    };
    report.push(combined);
    combinations.push({ key: first.key, issue_type: first.issue_type,
      policy: 'all_observations_highest_severity_lowest_confidence_no_conflicting_suggestion',
      variants: variants.map(({ finding, origins }) => ({ finding, origins })), combined });
  }
  report.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.issue_type.localeCompare(b.issue_type, 'en'));
  assertContract('report', report);
  return { report, duplicates, combinations };
}
