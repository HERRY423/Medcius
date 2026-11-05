// Use at an authorized local HIS ingress. Only guarded copies may reach the
// snapshot builder, anchors, logs, audit stores, or a host model.
import { createPhiEntitySession, assertPhiEntitySession, guardSessionValue } from './phi-entity-session.mjs';
import { assertLocalPhiDetector, guardFreeTextEgress } from './local-phi-egress.mjs';
import { assertExplicitFeedOwnership, sealIdentityRecord } from './clinical-boundary.mjs';
import { isIntegrityMetadata } from '../servers/shared/integrity-metadata.mjs';
import { resolvePhiDetector, isVerifiedLocalChineseNer } from './phi-runtime.mjs';
import { withPhiInferenceScope, primePhiInferenceScope } from './phi-inference-scope.mjs';
const guardedInputs = new WeakMap();
export function isProductionGuardedSource(input) { return guardedInputs.get(input) === true; }
// Closed vocabulary only: feeding isolated English enum tokens to a Chinese
// PER/LOC model corrupts states such as unknown/current. Narrative fields and
// unrecognized values still execute NER, including ASCII names.
const MACHINE_VALUES = new Set(['unknown','current','historical','resolved','patient','family','other',
  'present','absent','possible','negated','uncertain','not_mentioned','not_evaluated','active','inactive',
  'final','preliminary','amended','corrected','cancelled','canceled','entered-in-error','unavailable',
  'available','available_empty','male','female','yes','no','none','normal','positive','negative',
  'pending','complete','incomplete','unknown_time','not_applicable','in-progress']);
const MACHINE_FIELDS = {
  kind: new Set(['patient','encounter','notes','nis','lis','pacs','his','financial_access','clinical_quality',
    'renal_assessment','anthropometry','disease_enrollment','core_quality_scope','quality_node','vte_requirement','vte_assessment',
    'perioperative_antibiotic','medication','antibiotic_administration','microbiology','antibiotic_authorization','senior_round']),
  tool: new Set(['Padua','Caprini']), population: new Set(['medical','surgical']),
  therapy_horizon: new Set(['long_term','discharge']),
  creatinine_unit: new Set(['umol/L','μmol/L','µmol/L','mg/dL']),
  purpose: new Set(['treatment','prophylaxis']), agent_class: new Set(['standard','vancomycin','fluoroquinolone']),
  route: new Set(['IV']), incision_class: new Set(['I','II','III','IV']), test_type: new Set(['culture']),
  source_mode: new Set(['authorized_bridge','caller_feeds','synthetic_authorized_replay']),
  ownership_status: new Set(['verified','query_scoped','verified_by_source_context','source_record','source_subject_absent','source_encounter_absent']),
};
function machineValue(key, value) {
  if (MACHINE_FIELDS[key]?.has(value)) return true;
  if (key === 'dosage_instruction' && /^\d+(?:\.\d+)?(?:mg|g|mcg|μg|ug|mL|ml|IU|U)(?:\s+(?:po|iv|ivgtt|im|sc|qd|bid|tid|qid|qhs|prn|stat)){0,4}$/i.test(value)) return true;
  if (/^(?:id|.*_id|record_identity|reference|version|.*_version|source_system|system|.*_at|.*_time|as_of|asOf|now|timestamp)$/.test(key)
    && /^[A-Za-z0-9_.:/+@-]{1,256}$/.test(value)) return true;
  return /(?:status|state|type|kind|coverage|basis|stage|temporality|experiencer|gender|assertion|certainty|polarity|selection|arrival)$/.test(key)
    && MACHINE_VALUES.has(value);
}

export async function guardPatientSourceInput(input, { detector, signal, entitySession } = {}) {
  // Freeze caller-supplied data before the first await; mid-flight context or
  // note mutations cannot bind a response to a different patient.
  const source = structuredClone(input);
  const { context, patient, encounter } = source;
  detector = await resolvePhiDetector({ detector, context });
  assertLocalPhiDetector(detector);
  return withPhiInferenceScope(context, detector, async () => {
  const session = entitySession ?? createPhiEntitySession({ ...source, context, patient, encounter });
  assertPhiEntitySession(session, context);
  if (entitySession) session.inject(source);
  try {
    for (const k of ['notes','observations','diagnosticReports','medications','orders','nursing','nis','lis','pacs','his_orders']) {
      if (source[k] != null && !Array.isArray(source[k])) throw new Error('PHI_SOURCE_FEED_INVALID');
      assertExplicitFeedOwnership(context, source[k] ?? [], k);
    }
    for (const [key,nameKey] of Object.entries({ notes:'title', observations:'test_name', diagnosticReports:'study_name', medications:'drug_name', orders:'title', nursing:'title' })) {
      if (source[key]) source[key] = source[key].map(({ name, ...row }) => ({ ...row, ...(name ? { [nameKey]: row[nameKey] || name } : {}) }));
    }
    let passes = 0;
    const sealedObjects=new WeakMap(), neuralTexts=new Set();
    const collect=(value,key='',parent=null,depth=0)=>{
      if(signal?.aborted) throw new Error('LOCAL_PHI_DETECTOR_ABORTED');
      if(depth>64) throw new Error('PHI_SOURCE_DEPTH');
      if(parent && isIntegrityMetadata(key,value,parent)) return;
      if(typeof value==='string') { if(!machineValue(key,value)) neuralTexts.add(value);return; }
      if(Array.isArray(value)) { for(const item of value) collect(item,key,null,depth+1);return; }
      if(!value || typeof value!=='object') return;
      const sealed=sealIdentityRecord(value);sealedObjects.set(value,sealed);
      for(const [k,v] of Object.entries(sealed)) {
        if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) neuralTexts.add(k);
        collect(v,k,sealed,depth+1);
      }
    };
    collect(source);
    await primePhiInferenceScope(detector,neuralTexts,{signal,context});
    const checkedText = new Map(); // request-local only, never retained across patients
    const visit = async (value, key = '', parent = null, depth = 0) => {
      if (signal?.aborted) throw new Error('LOCAL_PHI_DETECTOR_ABORTED');
      if (depth > 64) throw new Error('PHI_SOURCE_DEPTH');
      if (parent && isIntegrityMetadata(key, value, parent)) return value;
      // Source IDs and timestamps are immutable evidence coordinates, not free text.
      if (typeof value === 'string') {
        if (machineValue(key, value)) return guardSessionValue(value, { session, context });
        const cached = checkedText.get(value);
        if (cached !== undefined && session.scan(cached, context).length === 0) return cached;
        const result = await guardFreeTextEgress(value, { detector, signal, entitySession: session, context });
        passes += result.receipt.passes_completed;
        checkedText.set(value, result.text);
        return result.text;
      }
      if (Array.isArray(value)) { const out = []; for (const v of value) out.push(await visit(v, key, null, depth+1)); return out; }
      if (!value || typeof value !== 'object') return value;
      const out = {}, sealed = sealedObjects.get(value) ?? sealIdentityRecord(value);
      for (const [k,v] of Object.entries(sealed)) {
        const safeKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k
          : (await guardFreeTextEgress(k, { detector, signal, entitySession: session, context })).text;
        if (Object.hasOwn(out, safeKey)) throw new Error('PHI_SOURCE_KEY_COLLISION');
        Object.defineProperty(out, safeKey, { enumerable: true, value: await visit(v, k, sealed, depth+1) });
      }
      return out;
    };
    const guarded = await visit(source);
    guardedInputs.set(guarded, isVerifiedLocalChineseNer(detector));
    return { input: guarded, session, receipt: { assurance: 'dual_track_executed', detector_id: detector.id,
      detector_version: detector.version, ner_status: 'EXECUTED', passes_completed: passes,
      complete_deidentification: 'NOT_ESTABLISHED' } };
  } catch (error) {
    if (!entitySession) session.dispose();
    const code = /^(?:LOCAL_PHI|PHI_SOURCE|PHI_SESSION)_[A-Z_]+$/.test(error?.message) ? error.message : 'GUARD_REJECTED';
    throw new Error(`PHI_SOURCE_GUARD_FAILED: ${code}`);
  }
  });
}
