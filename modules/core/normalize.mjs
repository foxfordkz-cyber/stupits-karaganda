import { isDirect, stageMain, runNormalizeStage } from './stages.mjs';
export { normalizeArbs } from './stages.mjs';
if (isDirect(import.meta.url)) await stageMain(runNormalizeStage);
