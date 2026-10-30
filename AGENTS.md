# Team contract
This repository implements Qazaq Loc QA. The integration kit is not a completed detector.
Read README.md and docs/CONTRACTS.md before changing an interface.

Ownership:
- Integrator (user): contracts/, src/, scripts/, test/, root configuration and CI.
- Damir: modules/core/ and its tests. ARB loader, strict checks, CLI, final exporter.
- Bekzat: modules/language/ and its tests. Language findings and proposals.
- Aidana: modules/linguistics/. Glossary policy, actual human review workflow.
- Tony: modules/report/ and its tests. HTML and review interface.

Each contributor uses a separate branch. Coordinate changes to shared schemas and dependencies
with the integrator. Begin with fixtures/synthetic rather than waiting for another module.
Actual handout files, derived findings, private review records, API keys, and generated reports
must remain in ignored data/, private/, outputs/, or submission/ directories.
Only invented data belongs in fixtures/synthetic. Never mark a real translation as reviewed by
a human unless a human actually reviewed that exact version. Existing approvals become stale
when the source, original target, or approved text changes.

Do not present fixture playback as live detection, or synthetic-set recall as hidden-test recall.
Run npm test and npm run check before handing off. Include a launch command and known limitations.
Keep code inside the assigned module; do not rewrite other contributors' work.
