import { resolve, isAbsolute } from 'node:path';
import { createLocalChineseNer, isVerifiedLocalChineseNer } from '../runtimes/cn-phi-ner/detector.mjs';
import { requiresProductionPhi } from './production-phi-policy.mjs';
let cachedPath, pending;

export function assertProductionDetector(detector) {
  if (!isVerifiedLocalChineseNer(detector)) throw new Error('PHI_PRODUCTION_VERIFIED_NER_REQUIRED');
}
export { isVerifiedLocalChineseNer };

// No remote download, empty detector, prior-version fallback or heuristic mode.
export async function resolvePhiDetector({ detector, context } = {}) {
  if (detector) {
    if (requiresProductionPhi(context)) assertProductionDetector(detector);
    return detector;
  }
  const directory = process.env.MEDCIUS_CN_NER_MODEL_DIR;
  if (!directory) throw new Error('PHI_LOCAL_NER_MODEL_REQUIRED');
  if (!isAbsolute(directory) || /^(?:https?:|\\\\|\/\/)/i.test(directory)) throw new Error('PHI_LOCAL_NER_DIRECTORY_REQUIRED');
  const path = resolve(directory);
  if (!pending || cachedPath !== path) {
    cachedPath = path;
    const load = createLocalChineseNer({ modelDirectory: path });
    pending = load;
    load.catch(() => { if (pending === load) pending = null; });
  }
  try {
    const loaded = await pending;
    if (!isVerifiedLocalChineseNer(loaded)) throw new Error('unavailable');
    return loaded;
  }
  catch { throw new Error('PHI_LOCAL_NER_LOAD_FAILED'); }
}
