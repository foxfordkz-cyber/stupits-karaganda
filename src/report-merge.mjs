import { assertContract } from './contracts.mjs';
export function mergeReports(reports) {
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
