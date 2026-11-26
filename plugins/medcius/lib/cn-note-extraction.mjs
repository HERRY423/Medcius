// Host-neutral, read-only extraction. Model candidates remain in a separate
// review queue; neither offsets nor rule/model agreement establish entailment.
import { parseCnNote, parseCnDate, extractConTextAssertion } from './parse-cn-note.mjs';
import { createTextAnchor } from './evidence-anchors.mjs';
import { guardFreeTextEgress } from './local-phi-egress.mjs';
import { resolvePhiDetector, assertProductionDetector } from './phi-runtime.mjs';
import { requiresProductionPhi } from './production-phi-policy.mjs';
import { assertPhiEntitySession } from './phi-entity-session.mjs';
import { isManagedLlmClient, isManagedLlmResult } from './llm-inference-config.mjs';
import { CN_CANDIDATE_TASK, CN_CANDIDATE_LIMITS } from './cn-note-candidate-contract.mjs';
import { sha256Hex, canonicalJson } from '../servers/shared/crypto.mjs';

const axes=['presence','temporality','experiencer'];
const sameAxes=(a,b)=>axes.every(k=>a[k]===b[k]);
const overlaps=(a,b)=>a.start<b.end && b.start<a.end;
const version=n=>n.version_id??n.source_version??n.meta?.versionId;
const nonempty=v=>typeof v==='string' && v.trim().length>0;
const timestamp=v=>nonempty(v) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
  && parseCnDate(v.slice(0,10))!==null && Number.isFinite(Date.parse(v));

function assertSource(note,context) {
  if(!note || !context || !['tenant_id','patient_id','encounter_id'].every(k=>nonempty(context[k]) && note[k]===context[k])) throw new Error('CN_EXTRACTION_CONTEXT_MISMATCH');
  if(!nonempty(note.id) || !nonempty(version(note)) || !nonempty(note.source_system)) throw new Error('CN_EXTRACTION_SOURCE_REQUIRED');
  if(!timestamp(note.timestamp) || !timestamp(context.as_of) || Date.parse(note.timestamp)>Date.parse(context.as_of)) throw new Error('CN_EXTRACTION_TIME_INVALID');
  if(typeof note.text!=='string' || !note.text.trim() || !note.text.isWellFormed() || note.text.includes('\ufffd')
    || note.text.length>CN_CANDIDATE_LIMITS.input_chars) throw new Error('CN_EXTRACTION_INPUT_INVALID');
}

function containingContext(text,c) {
  // Full paragraph/sentence, including the governing negation outside a
  // candidate's span. Never trust a model-selected context window.
  let start=c.start,end=c.end;
  while(start>0 && !/[。；;\r\n！!]/.test(text[start-1])) start--;
  while(end<text.length && !/[。；;\r\n！!]/.test(text[end])) end++;
  return {span:text.slice(start,end),start,end};
}

function reviewModelCandidates(batch,record,clauses) {
  const rules=clauses.flatMap(c=>c.mentions);
  const out=[], seen=new Set();
  for(const candidate of batch.candidates) {
    const key=canonicalJson([candidate.start,candidate.end,candidate.kind,...axes.map(k=>candidate[k])]);
    if(seen.has(key)) continue;
    seen.add(key);
    const exact=rules.find(r=>r.start===candidate.start && r.end===candidate.end);
    const touching=rules.filter(r=>overlaps(r,candidate));
    const context=containingContext(record.text,candidate);
    const conflict=touching.some(r=>!sameAxes(r,candidate));
    const truncated=touching.some(r=>candidate.start>r.start || candidate.end<r.end);
    // Even matching default-positive clauses do not validate a proposed kind
    // such as diagnosis. Keep all model proposals visible and unpromoted.
    const status=conflict ? 'rule_conflict' : truncated ? 'context_incomplete'
      : exact && sameAxes(exact,candidate) ? 'rule_agreement' : 'semantic_review_required';
    out.push({...candidate,origin:'model',review_status:status,requires_clinician_review:true,
      span_verified:true,verification_scope:'exact_guarded_source_only',
      text_anchor:createTextAnchor(record,candidate),context_anchor:createTextAnchor(record,context),
      rule_assertions:touching.map(r=>({span:r.span,start:r.start,end:r.end,...Object.fromEntries(axes.map(k=>[k,r[k]]))})),
      context_assertion:extractConTextAssertion(context.span).scope_status,
      semantic_validation:'NOT_ESTABLISHED'});
  }
  // Same source location, incompatible hypotheses: keep both for review.
  for(const c of out) if(out.some(other=>other!==c && overlaps(c,other) && (!sameAxes(c,other) || c.kind!==other.kind))) c.review_status='model_conflict';
  return out;
}

/**
 * Public entry point. Default is rules_only. A hybrid request needs a managed
 * client and the exact prompt-pack version; never selects a provider or sends
 * anything by default. The deployment supplies transport and local PHI runtime.
 */
export function createCnNoteExtractor({client,localPhiDetector,timeoutMs=30000,maxConcurrency=2}={}) {
  if(client && !isManagedLlmClient(client)) throw new Error('CN_EXTRACTION_MANAGED_CLIENT_REQUIRED');
  if(!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>600000 || !Number.isInteger(maxConcurrency) || maxConcurrency<1 || maxConcurrency>32) throw new Error('CN_EXTRACTION_LIMIT_INVALID');
  let inflight=0;
  const checkSignal=signal=>{if(signal.aborted) throw new Error('CN_EXTRACTION_TIMEOUT');};
  async function run({note,context,entitySession,mode='rules_only'}={},signal,deadline) {
      if(!['rules_only','hybrid'].includes(mode)) throw new Error('CN_EXTRACTION_MODE_INVALID');
      if(mode==='hybrid' && !client) throw new Error('CN_EXTRACTION_CLIENT_REQUIRED');
      note=structuredClone(note);context=structuredClone(context);
      assertSource(note,context);
      const production=requiresProductionPhi(context);
      if(production) assertPhiEntitySession(entitySession,context);
      const detector=await resolvePhiDetector({detector:localPhiDetector,context});
      if(production) assertProductionDetector(detector);
      // Guard before parsing, hashing, model context, or returning free text.
      // Every offset refers to THIS sanitized snapshot, never the raw note.
      checkSignal(signal);
      const guarded=await guardFreeTextEgress(note.text,{detector,entitySession,context,signal});
      checkSignal(signal);
      if(guarded.text.length>CN_CANDIDATE_LIMITS.input_chars) throw new Error('CN_EXTRACTION_INPUT_INVALID');
      const record={id:note.id,source_system:note.source_system,version_id:version(note),
        tenant_id:context.tenant_id,patient_id:context.patient_id,encounter_id:context.encounter_id,
        timestamp:note.timestamp,text:guarded.text};
      const rules=parseCnNote(record.text);
      const result={schema_version:'medcius.cn-note-extraction.v1',mode,source:record,
        source_sha256:sha256Hex(record.text),source_binding_sha256:sha256Hex(canonicalJson(record)),
        as_of:context.as_of,phi_receipt:guarded.receipt,rules,
        rule_mentions:rules.assertion_clauses.flatMap(c=>c.mentions.map(m=>({...m,origin:'rule',text_anchor:createTextAnchor(record,m)}))),
        review_candidates:[],rejected_candidates:[],
        coverage:{rules:'bounded_rules_only',model:'NOT_RUN',completeness:'NOT_ESTABLISHED'},
        model:{status:'NOT_RUN'},clinical_validation:'NOT_ESTABLISHED'};
      if(mode==='rules_only') return result;
      let response;
      try {response=await client.extract({text:record.text,task:CN_CANDIDATE_TASK,entitySession,context,
        timeoutMs:Math.max(1,deadline-Date.now())});}
      catch(error) {
        checkSignal(signal);
        // PHI boundary failures stop the whole operation; no partially guarded
        // artifact may be exported as an apparently successful extraction.
        if(/PHI|NER|LOCAL_PHI|SESSION/.test(error?.message??'')) throw new Error('CN_EXTRACTION_PHI_FAILED');
        const known=['LLM_TIMEOUT','LLM_TRANSPORT_FAILED','LLM_CONCURRENCY_BUDGET_EXCEEDED','LLM_RESPONSE_LIMIT','LLM_PROMPT_PACK_MISMATCH','LLM_EXTRACT_RESPONSE_INVALID'];
        const reason=known.find(code=>(error?.message??'').startsWith(code))??'MODEL_FAILED';
        result.model={status:'FAILED',reason};result.coverage.model='FAILED';return result;
      }
      checkSignal(signal);
      if(!isManagedLlmResult(response) || response.source_sha256!==result.source_sha256) {
        result.model={status:'REJECTED',reason:'GUARDED_SOURCE_CHANGED'};result.coverage.model='REJECTED';return result;
      }
      const batch=response.candidate_batch;
      result.model={status:batch.ok ? 'CANDIDATES_ONLY' : 'REJECTED',reason:batch.reason,
        model_id:response.model_id,model_version:response.model_version,prompt_pack_version:response.prompt_pack_version,
        config_digest:response.config_digest,request_id:response.request_id,latency_ms:response.latency_ms};
      result.coverage.model=batch.ok ? batch.coverage==='partial' || batch.rejected.length ? 'PARTIAL' : 'MODEL_REPORTED_COMPLETE' : 'REJECTED';
      result.rejected_candidates=batch.rejected;
      if(batch.ok) result.review_candidates=reviewModelCandidates(batch,record,rules.assertion_clauses);
      return result;
  }
  return Object.freeze({
    async extract(input) {
      if(inflight>=maxConcurrency) throw new Error('CN_EXTRACTION_CONCURRENCY_LIMIT');
      inflight++;
      const controller=new AbortController(),deadline=Date.now()+timeoutMs;
      // Do not free the slot when a detector/provider ignores cancellation.
      const pending=run(input,controller.signal,deadline).finally(()=>{inflight--;});
      let timer;
      try {return await Promise.race([pending,new Promise((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(new Error('CN_EXTRACTION_TIMEOUT'));},timeoutMs);
      })]);} finally {clearTimeout(timer);}
    },
    capacity:()=>({inflight,max_concurrency:maxConcurrency}),
  });
}
