import { resolve, isAbsolute } from 'node:path';
import { createLocalChineseNer, createLocalChineseNerPool, getClinicalPhiModelBinding, isVerifiedLocalChineseNer } from '../runtimes/cn-phi-ner/detector.mjs';
import { isSha256 } from '../runtimes/cn-phi-ner/clinical-model.mjs';
import { isLiveHospitalDataEnabled } from './clinical-landing-policy.mjs';
import { requiresProductionPhi } from './production-phi-policy.mjs';
let cachedKey, pending;

export function phiRuntimeOptions(env=process.env) {
  const mapping={MEDCIUS_CN_NER_PROCESSES:'processes',MEDCIUS_CN_NER_THREADS:'threads',MEDCIUS_CN_NER_BATCH_WORKERS:'batchWorkers',
    MEDCIUS_CN_NER_CPU_BUDGET:'cpuBudget',MEDCIUS_CN_NER_MAX_PENDING:'maxPending',MEDCIUS_CN_NER_TIMEOUT_MS:'timeoutMs',
    MEDCIUS_CN_NER_MICROBATCH_REQUESTS:'microBatchMaxRequests',MEDCIUS_CN_NER_MICROBATCH_WAIT_MS:'microBatchWaitMs',
    MEDCIUS_CN_NER_MAX_OUTSTANDING_REQUESTS:'maxOutstandingRequests',MEDCIUS_CN_NER_MAX_OUTSTANDING_UTF16:'maxOutstandingUtf16',
    MEDCIUS_CN_NER_MAX_OUTSTANDING_TEXTS:'maxOutstandingTexts'};
  const options={};
  for(const [key,name] of Object.entries(mapping)) if(env[key]!==undefined) {
    if(!(key==='MEDCIUS_CN_NER_MICROBATCH_WAIT_MS'&&env[key]==='0')&&!/^[1-9]\d{0,6}$/.test(env[key])) throw new Error('PHI_LOCAL_NER_CONFIGURATION_INVALID');
    options[name]=Number(env[key]);
  }
  if(options.processes===undefined&&['cpuBudget','microBatchMaxRequests','microBatchWaitMs','maxOutstandingRequests','maxOutstandingUtf16','maxOutstandingTexts'].some(k=>options[k]!==undefined)) throw new Error('PHI_LOCAL_NER_CONFIGURATION_INVALID');
  if((options.microBatchMaxRequests??1)===1&&['microBatchWaitMs','maxOutstandingRequests','maxOutstandingUtf16','maxOutstandingTexts'].some(k=>options[k]!==undefined)) throw new Error('PHI_LOCAL_NER_CONFIGURATION_INVALID');
  return options;
}

function clinicalPhiPolicy(context) {
  const pin = process.env.MEDCIUS_CN_CLINICAL_PHI_MANIFEST_SHA256 || undefined;
  const tenant = process.env.MEDCIUS_TENANT_ID?.trim();
  const live = isLiveHospitalDataEnabled();
  if ((live || pin !== undefined) && !isSha256(pin)) throw new Error('PHI_CLINICAL_NER_MANIFEST_PIN_REQUIRED');
  if (live && (!tenant || (context?.tenant_id != null && context.tenant_id !== tenant))) {
    throw new Error('PHI_CLINICAL_NER_TENANT_MISMATCH');
  }
  return { pin, tenant, live };
}

export function assertProductionDetector(detector, context) {
  if (!isVerifiedLocalChineseNer(detector)) throw new Error('PHI_PRODUCTION_VERIFIED_NER_REQUIRED');
  assertClinicalPhiBinding(detector, context, clinicalPhiPolicy(context));
}

function assertClinicalPhiBinding(detector, context, { pin, tenant, live }) {
  const binding = getClinicalPhiModelBinding(detector);
  if (pin && binding?.manifest_sha256 !== pin) throw new Error('PHI_CLINICAL_NER_REQUIRED');
  if (binding && ((live && binding.tenant_id !== tenant)
    || (context?.tenant_id != null && binding.tenant_id !== context.tenant_id))) {
    throw new Error('PHI_CLINICAL_NER_TENANT_MISMATCH');
  }
}
export { getClinicalPhiModelBinding, isVerifiedLocalChineseNer };

// No remote download, empty detector, prior-version fallback or heuristic mode.
export async function resolvePhiDetector({ detector, context } = {}) {
  const policy = clinicalPhiPolicy(context);
  if (detector) {
    if (requiresProductionPhi(context) && !isVerifiedLocalChineseNer(detector)) {
      throw new Error('PHI_PRODUCTION_VERIFIED_NER_REQUIRED');
    }
    assertClinicalPhiBinding(detector, context, policy);
    return detector;
  }
  const directory = process.env.MEDCIUS_CN_NER_MODEL_DIR;
  if (!directory) throw new Error('PHI_LOCAL_NER_MODEL_REQUIRED');
  if (!isAbsolute(directory) || /^(?:https?:|\\\\|\/\/)/i.test(directory)) throw new Error('PHI_LOCAL_NER_DIRECTORY_REQUIRED');
  const path = resolve(directory);
  const options = phiRuntimeOptions();
  if (policy.pin && options.processes !== undefined) throw new Error('PHI_CLINICAL_NER_PROCESS_POOL_UNSUPPORTED');
  const key = JSON.stringify([path, options, policy.pin]);
  if (!pending || cachedKey !== key) {
    const previous=pending;cachedKey=key;
    const load=(async()=>{
      // Replacement releases old native sessions before allocating new ones.
      // A failed replacement never returns the prior model/configuration.
      if(previous) {let old;try {old=await previous;} catch {} await old?.close();}
      const factory=options.processes===undefined?createLocalChineseNer:createLocalChineseNerPool;
      return factory({modelDirectory:path,...options,clinicalManifestSha256:policy.pin});
    })();
    pending = load;
    load.catch(() => { if (pending === load) pending = null; });
  }
  const loading=pending;
  let loaded;
  try {
    loaded = await loading;
    if (pending!==loading || !isVerifiedLocalChineseNer(loaded)) throw new Error('unavailable');
  }
  catch { throw new Error('PHI_LOCAL_NER_LOAD_FAILED'); }
  assertClinicalPhiBinding(loaded, context, clinicalPhiPolicy(context));
  return loaded;
}
