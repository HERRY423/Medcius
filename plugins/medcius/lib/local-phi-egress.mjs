// Deployment-injected LOCAL detector. No network client or downloadable model.
// A callback declaration is not certification of deployment locality or recall.
import { sha256Hex } from '../servers/shared/crypto.mjs';
import { redactPhiText, scanText } from '../servers/phiguard/src/lib.mjs';
import { assertPhiEntitySession, mergePhiSpans, redactSessionEntities } from './phi-entity-session.mjs';
import { requiresProductionPhi } from './production-phi-policy.mjs';
import { assertProductionDetector, getClinicalPhiModelBinding } from './phi-runtime.mjs';
import { createClinicalLiteralMatcher } from './phi-clinical-literals.mjs';
import { withPhiInferenceScope, detectWithinPhiScope } from './phi-inference-scope.mjs';
import {validateOovSubjectSpans,OOV_SUBJECT_POLICY,validateContextSubjectSpans,CONTEXT_SUBJECT_POLICY} from './phi-oov-subjects.mjs';

export function assertLocalPhiDetector(detector) {
  if (!detector || detector.execution !== 'local' || typeof detector.detect !== 'function'
    || typeof detector.id !== 'string' || !detector.id.trim()
    || typeof detector.version !== 'string' || !detector.version.trim()) {
    throw new Error('LOCAL_PHI_DETECTOR_REQUIRED');
  }
}

export async function guardFreeTextEgress(text, { detector, signal, entitySession, context } = {}) {
  assertLocalPhiDetector(detector);
  if (requiresProductionPhi(context)) {
    assertProductionDetector(detector, context);
    assertPhiEntitySession(entitySession, context);
  }
  if (entitySession) assertPhiEntitySession(entitySession, context);
  if (typeof text !== 'string' || !text.isWellFormed()) throw new Error('LOCAL_PHI_TEXT_INVALID');
  return withPhiInferenceScope(context, detector, async () => {
  let inferenceCalls = 0, inferenceReuses = 0, supplementalSubjectSpans = 0, subjectScreening = false;
  let contextSubjectSpans=0,contextProbes=0,contextInputReuses=0,contextScreening=false;
  let surnameRuleSpans=0;
  async function detect(input) {
    if (signal?.aborted) throw new Error('LOCAL_PHI_DETECTOR_ABORTED');
    let result,reused=false;
    try {
      const scan = await detectWithinPhiScope(detector, input, { signal, context });
      result=scan.result;reused=scan.reused; if(scan.reused) inferenceReuses++; else inferenceCalls++;
    }
    catch { throw new Error('LOCAL_PHI_DETECTOR_FAILED'); }
    if (signal?.aborted) throw new Error('LOCAL_PHI_DETECTOR_ABORTED');
    if (result?.complete !== true || result.text_sha256 !== sha256Hex(input) || !Array.isArray(result.spans)) {
      throw new Error('LOCAL_PHI_DETECTOR_RESULT_UNBOUND');
    }
    const supplemental=validateOovSubjectSpans(input,result.subject_screening);
    if(result.subject_screening!==undefined) subjectScreening=true;
    supplementalSubjectSpans+=supplemental.length;
    const contextSpans=validateContextSubjectSpans(input,result.context_subject_screening);
    if(result.context_subject_screening!==undefined) {
      contextScreening=true;
      if(!reused){contextProbes+=result.context_subject_screening.probe_count;contextInputReuses+=result.context_subject_screening.reused_input_count??0;}
      contextSubjectSpans+=contextSpans.length;
      if(!reused) surnameRuleSpans+=result.context_subject_screening.spans.filter(s=>s.method==='surname_subject_rule').length;
    }
    const mapped = result.spans.map(s => {
      if (!s || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start
        || s.end > input.length || !input.slice(s.start, s.end).isWellFormed()
        || !['PERSON', 'ADDRESS', 'IDENTIFIER', 'CONTACT', 'ORGANIZATION'].includes(s.label)) {
        throw new Error('LOCAL_PHI_DETECTOR_SPAN_INVALID');
      }
      return { start: s.start, end: s.end, label: s.label };
    }).concat(supplemental,contextSpans);
    const isClinical=mapped.length?createClinicalLiteralMatcher(input):()=>false;
    const spans=mapped.filter(s=>!isClinical(s)).sort((a,b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    }
    return merged;
  }
  // Both tracks see the original text, so replacing a known name cannot hide
  // surrounding evidence from the neural detector.
  const known = entitySession ? entitySession.scan(text, context) : [];
  const spans = mergePhiSpans([...known, ...await detect(text)]);
  let sanitized = text;
  for (const s of spans.toReversed()) sanitized = sanitized.slice(0, s.start) + '[REDACTED:LOCAL_ENTITY]' + sanitized.slice(s.end);
  sanitized = redactPhiText(sanitized, { contextual: true });
  if (entitySession) sanitized = redactSessionEntities(sanitized, { session: entitySession, context });
  // Removing one span can expose another fragment to a contextual model.
  // Infer each distinct text to a clean fixed point, within a strict bound;
  // an identical text can reuse only this operation's verified neural result.
  // unresolved residuals still block instead of releasing a partial result.
  let passes = 1, clean = false, spanCount = spans.length;
  for (let attempt = 0; attempt < 4; attempt++) {
    const remaining = await detect(sanitized); passes++;
    if (!remaining.length && !scanText(sanitized, { contextual: true }).total) { clean = true; break; }
    spanCount += remaining.length;
    for (const s of remaining.toReversed()) sanitized = sanitized.slice(0,s.start) + '[REDACTED:LOCAL_ENTITY]' + sanitized.slice(s.end);
    sanitized = redactPhiText(sanitized, { contextual: true });
    if (entitySession) sanitized = redactSessionEntities(sanitized, { session: entitySession, context });
  }
  if (!clean) throw new Error('LOCAL_PHI_RESIDUAL_DETECTED');
  const clinicalModel = getClinicalPhiModelBinding(detector);
  return { text: sanitized, receipt: { detector_id: detector.id, detector_version: detector.version,
    ...(clinicalModel ? { detector_manifest_sha256: clinicalModel.manifest_sha256 } : {}),
    passes_completed: passes, detector_span_count: spanCount, sanitized_sha256: sha256Hex(sanitized),
    inference_calls: inferenceCalls, inference_reuses: inferenceReuses,
    supplemental_subject_policy:subjectScreening?OOV_SUBJECT_POLICY:null,
    supplemental_subject_span_count:supplementalSubjectSpans,
    context_subject_policy:contextScreening?CONTEXT_SUBJECT_POLICY:null,
    context_subject_probe_count:contextProbes,context_subject_span_count:contextSubjectSpans,
    context_subject_reused_input_count:contextInputReuses,
    surname_subject_rule_span_count:surnameRuleSpans,
    entity_dictionary_executed: !!entitySession,
    assurance: entitySession ? 'dual_track_executed' : 'local_detector_and_heuristics_executed', complete_deidentification: 'NOT_ESTABLISHED' } };
  });
}
