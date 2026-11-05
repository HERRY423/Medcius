// Deployment-injected LOCAL detector. No network client or downloadable model.
// A callback declaration is not certification of deployment locality or recall.
import { sha256Hex } from '../servers/shared/crypto.mjs';
import { redactPhiText, scanText } from '../servers/phiguard/src/lib.mjs';
import { assertPhiEntitySession, mergePhiSpans, redactSessionEntities } from './phi-entity-session.mjs';
import { requiresProductionPhi } from './production-phi-policy.mjs';
import { assertProductionDetector } from './phi-runtime.mjs';
import { withinClinicalLiteral } from './phi-clinical-literals.mjs';
import { withPhiInferenceScope, detectWithinPhiScope } from './phi-inference-scope.mjs';

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
    assertProductionDetector(detector);
    assertPhiEntitySession(entitySession, context);
  }
  if (entitySession) assertPhiEntitySession(entitySession, context);
  if (typeof text !== 'string' || !text.isWellFormed()) throw new Error('LOCAL_PHI_TEXT_INVALID');
  return withPhiInferenceScope(context, detector, async () => {
  let inferenceCalls = 0, inferenceReuses = 0;
  async function detect(input) {
    if (signal?.aborted) throw new Error('LOCAL_PHI_DETECTOR_ABORTED');
    let result;
    try {
      const scan = await detectWithinPhiScope(detector, input, { signal, context });
      result=scan.result; if(scan.reused) inferenceReuses++; else inferenceCalls++;
    }
    catch { throw new Error('LOCAL_PHI_DETECTOR_FAILED'); }
    if (signal?.aborted) throw new Error('LOCAL_PHI_DETECTOR_ABORTED');
    if (result?.complete !== true || result.text_sha256 !== sha256Hex(input) || !Array.isArray(result.spans)) {
      throw new Error('LOCAL_PHI_DETECTOR_RESULT_UNBOUND');
    }
    const spans = result.spans.map(s => {
      if (!s || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start
        || s.end > input.length || !input.slice(s.start, s.end).isWellFormed()
        || !['PERSON', 'ADDRESS', 'IDENTIFIER', 'CONTACT', 'ORGANIZATION'].includes(s.label)) {
        throw new Error('LOCAL_PHI_DETECTOR_SPAN_INVALID');
      }
      return { start: s.start, end: s.end, label: s.label };
    }).filter(s => s.label !== 'PERSON' || !withinClinicalLiteral(input, s))
      .sort((a,b) => a.start - b.start || b.end - a.end);
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
  return { text: sanitized, receipt: { detector_id: detector.id, detector_version: detector.version,
    passes_completed: passes, detector_span_count: spanCount, sanitized_sha256: sha256Hex(sanitized),
    inference_calls: inferenceCalls, inference_reuses: inferenceReuses,
    entity_dictionary_executed: !!entitySession,
    assurance: entitySession ? 'dual_track_executed' : 'local_detector_and_heuristics_executed', complete_deidentification: 'NOT_ESTABLISHED' } };
  });
}
