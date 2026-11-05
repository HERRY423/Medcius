// Raw NER results may be reused only inside one awaited clinical operation.
// The dictionary and residual checks still run at every boundary. Nothing is
// retained across requests, patients, detectors, failures or disposed runtimes.
import { AsyncLocalStorage } from 'node:async_hooks';
import { isVerifiedLocalChineseNer } from './phi-runtime.mjs';
import { detectManyLocalChineseNer } from '../runtimes/cn-phi-ner/detector.mjs';
import { withPhiTextScanScope } from '../servers/phiguard/src/lib.mjs';
const scopes = new AsyncLocalStorage();
const binding = c => JSON.stringify(['tenant_id','patient_id','encounter_id','doctor_id','phi_session_id','phi_request_id'].map(k=>c?.[k]??null));
const MAX_BYTES = 2_000_000;

// Same request, same verified detector, same raw texts. Populate only by actual
// local inference; dictionary and residual checks still run at every boundary.
export async function primePhiInferenceScope(detector,texts,{signal,context}={}) {
  const scope=scopes.getStore();
  if(scope?.failed) throw new Error('LOCAL_PHI_SCOPE_FAILED');
  if(signal?.aborted) {if(scope){scope.failed=true;scope.results.clear();}throw new Error('LOCAL_PHI_DETECTOR_ABORTED');}
  if(!scope?.active || scope.detector!==detector || scope.key!==binding(context) || !isVerifiedLocalChineseNer(detector)) return;
  const pending=[...new Set(texts)].filter(t=>!scope.results.has(t)).slice(0,512-scope.results.size);
  for(let at=0;at<pending.length;) {
    const batch=[];let length=0;
    do { const text=pending[at++];batch.push(text);length+=text.length; }
    while(at<pending.length && batch.length<64 && length+pending[at].length<=32000);
    try {
      const results=await detectManyLocalChineseNer(detector,batch,{signal});
      if(signal?.aborted || scope.failed || !scope.active || !isVerifiedLocalChineseNer(detector)) throw new Error('LOCAL_PHI_SCOPE_FAILED');
      for(let i=0;i<batch.length;i++) {
        if(results[i]?.complete!==true) throw new Error('LOCAL_PHI_DETECTOR_FAILED');
        if(scope.bytes+batch[i].length*2<=MAX_BYTES) {
          scope.results.set(batch[i],structuredClone(results[i]));scope.bytes+=batch[i].length*2;
        }
      }
    } catch(error) { scope.failed=true;scope.results.clear();throw error; }
  }
}

export async function withPhiInferenceScope(context, detector, work) {
  const current = scopes.getStore(), key = binding(context);
  if (current?.active && current.detector === detector && current.key === key) {
    if (current.failed) throw new Error('LOCAL_PHI_SCOPE_FAILED');
    try {
      const result = await work();
      if (current.failed) throw new Error('LOCAL_PHI_SCOPE_FAILED');
      return result;
    }
    catch (error) { current.failed=true; current.results.clear(); throw error; }
  }
  const scope = { active:true, failed:false, detector, key, results:new Map(), bytes:0 };
  return scopes.run(scope, () => withPhiTextScanScope(async () => {
    try {
      const result = await work();
      if (scope.failed) throw new Error('LOCAL_PHI_SCOPE_FAILED');
      return result;
    }
    finally { scope.active=false; scope.results.clear(); scope.bytes=0; }
  }));
}

export async function detectWithinPhiScope(detector, text, { signal, context } = {}) {
  const scope = scopes.getStore();
  if (scope?.failed) throw new Error('LOCAL_PHI_SCOPE_FAILED');
  if (signal?.aborted) {
    if (scope) { scope.failed=true; scope.results.clear(); }
    throw new Error('LOCAL_PHI_DETECTOR_ABORTED');
  }
  const eligible = scope?.active && scope.detector === detector && scope.key === binding(context)
    && isVerifiedLocalChineseNer(detector);
  if (eligible && scope.results.has(text)) return { result:structuredClone(scope.results.get(text)), reused:true };
  let result;
  try {
    result = await detector.detect(text, { signal });
    if (signal?.aborted) throw new Error('LOCAL_PHI_DETECTOR_ABORTED');
    if (scope?.failed) throw new Error('LOCAL_PHI_SCOPE_FAILED');
  } catch (error) {
    if (scope) { scope.failed=true; scope.results.clear(); }
    throw error;
  }
  // Only complete results of the verified factory are retained; validation of
  // hashes, spans and the current dictionary remains in guardFreeTextEgress.
  if (eligible && scope.active && isVerifiedLocalChineseNer(detector) && result?.complete === true
    && scope.results.size < 512 && scope.bytes + text.length * 2 <= MAX_BYTES) {
    scope.results.set(text, structuredClone(result)); scope.bytes += text.length * 2;
  }
  return { result, reused:false };
}
