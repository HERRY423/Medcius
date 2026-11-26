// Synthetic-only lifecycle and append-only research audit bridge. It never
// displays clinical prompts, changes diagnoses, or sends data to an EHR.
import { canonicalJson, sha256Hex } from '../servers/shared/crypto.mjs';
import { deepFreeze } from '../servers/shared/immutable.mjs';
import { assertPatientSourceSnapshot } from './patient-source-snapshot.mjs';
import { assertRecordEvidenceReview } from './record-evidence-reconciliation.mjs';
import { assertSyntheticReviewContext, assertSyntheticExclusionAssessment, assertSyntheticRuntime } from './reconciliation-rule-packs.mjs';

const hash = value => sha256Hex(canonicalJson(value));
const stages = new WeakSet();
const sourceKinds = ['notes','observations','diagnosticReports','medications','orders','nursing'];
const reasonCodes = new Set(['reviewed_consistent','clinical_disagreement','source_outdated','evidence_incomplete','not_applicable','other_not_recorded']);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const bytes = digest => {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('SYNTHETIC_AUDIT_DIGEST_INVALID');
  return Array.from(Buffer.from(digest, 'hex'));
};
const synthActor = actor => typeof actor === 'string' && /^synthetic-[a-z0-9-]{1,60}$/.test(actor);

export function buildSyntheticLifecycleStage({ snapshot, stage, trigger, review = null } = {}) {
  assertPatientSourceSnapshot(snapshot);
  assertSyntheticReviewContext(snapshot.context);
  if (!['before','during','after'].includes(stage) || !trigger || !sourceKinds.includes(trigger.kind)
      || typeof trigger.id !== 'string' || !trigger.id || Object.keys(trigger).some(k => !['kind','id'].includes(k))) {
    throw new Error('SYNTHETIC_STAGE_TRIGGER_REQUIRED');
  }
  const entries = snapshot.records[trigger.kind].filter(e => e.eligible && e.record.id === trigger.id);
  if (entries.length !== 1) throw new Error('SYNTHETIC_STAGE_SOURCE_NOT_UNIQUE');
  const entry = entries[0], when = instant(entry.lifecycle.event_time), admission = instant(snapshot.encounter.admission_time);
  const rawDischarge = snapshot.encounter.discharge_time;
  const discharge = rawDischarge == null ? null : instant(rawDischarge);
  if (when == null || admission == null || rawDischarge != null && discharge == null
      || discharge != null && discharge < admission || when > instant(snapshot.as_of)) throw new Error('SYNTHETIC_STAGE_TIME_UNKNOWN');
  if (stage === 'before' && when > admission || stage === 'during' && (when < admission || discharge != null && when > discharge)
      || stage === 'after' && (discharge == null || when < discharge)) throw new Error('SYNTHETIC_STAGE_TIME_MISMATCH');
  if (review != null) {
    assertRecordEvidenceReview(review);
    if (stage !== 'after' || review.snapshot_id !== snapshot.snapshot_id) throw new Error('SYNTHETIC_STAGE_REVIEW_MISMATCH');
  }
  const result = deepFreeze({ schema_version: 'medcius.synthetic-reconciliation-stage.v1', stage,
    context: { ...snapshot.context }, snapshot_id: snapshot.snapshot_id, as_of: snapshot.as_of,
    trigger: { kind: trigger.kind, id: entry.evidence.source_id, source_system: entry.evidence.source_system,
      version_id: entry.evidence.version_id, source_event_time: entry.lifecycle.event_time,
      source_record_digest: entry.evidence.content_sha256 },
    review_digest: review?.digest ?? null,
    record_review: review ? 'RESEARCH_REVIEW_AVAILABLE' : 'NOT_RUN',
    rule_status: 'NOT_CONFIGURED', trigger_origin: 'RETROSPECTIVE_SYNTHETIC_SOURCE',
    clinical_display: false, clinical_use_authorized: false, payment_impact: 'NOT_ASSESSED',
    diagnoses_modified: false, compliance_determination: 'NOT_ASSESSED' });
  stages.add(result); return result;
}

export function assertSyntheticLifecycleStage(stage) {
  if (!stages.has(stage)) throw new Error('SYNTHETIC_STAGE_BOUND_RESULT_REQUIRED');
  return stage;
}

function requireAudit(audit) {
  if (!audit || !['record_event','get_event','signoff','verify_chain'].every(k => typeof audit[k] === 'function')) throw new Error('SYNTHETIC_AUDIT_INTERFACE_REQUIRED');
}
function requireAuth(auth, tenant, role) {
  if (auth?.isAuthenticated !== true || auth.tenantId !== tenant || !synthActor(auth.user)
      || !Array.isArray(auth.roles) || !auth.roles.includes(role)) throw new Error('SYNTHETIC_AUDIT_FORBIDDEN');
}

/** Records digests and fixed metadata only; no clinical free text enters audit. */
export async function appendSyntheticDecisionTrigger({ audit, auth, stage, assessment = null } = {}) {
  requireAudit(audit); assertSyntheticLifecycleStage(stage); requireAuth(auth, stage.context.tenant_id, 'auditor');
  assertSyntheticReviewContext(stage.context);
  if (assessment != null) {
    assertSyntheticExclusionAssessment(assessment);
    if (stage.stage !== 'after' || assessment.snapshot_id !== stage.snapshot_id || assessment.review_digest !== stage.review_digest) {
      throw new Error('SYNTHETIC_AUDIT_ASSESSMENT_MISMATCH');
    }
  }
  if (!(await audit.verify_chain({})).ok) throw new Error('SYNTHETIC_AUDIT_CHAIN_INVALID');
  const subject = hash([stage.context.tenant_id, stage.context.patient_id, stage.context.encounter_id, stage.snapshot_id]);
  const event = await audit.record_event({ actor: auth.user, action: 'synthetic_reconciliation_trigger', tenant_id: auth.tenantId,
    subject_ref: `synth:${subject.slice(0,20).match(/.{2}/g).join(':')}`,
    payload: { schema_version: 'medcius.synthetic-reconciliation-audit.v1', purpose: 'synthetic_replay_only', stage: stage.stage,
      source_event_time: stage.trigger.source_event_time, source_kind: stage.trigger.kind,
      source_record_digest: bytes(stage.trigger.source_record_digest), snapshot_digest: bytes(stage.snapshot_id),
      review_digest: stage.review_digest ? bytes(stage.review_digest) : null,
      pack_digest: assessment?.pack_digest ? bytes(assessment.pack_digest) : null,
      rule_source: assessment?.source?.kind ?? 'NOT_CONFIGURED', rule_version: assessment?.source?.pack_version ?? null,
      rule_id: assessment?.match?.rule_id ?? null, rule_locator: assessment?.match?.source_locator ?? null,
      screening_status: assessment?.status ?? 'NOT_RUN', clinical_acknowledgement: false, clinical_use_authorized: false } });
  return { event_id: event.event_id, event_digest: event.event_digest, tenant_id: event.tenant_id,
    recorded_at: event.ts, status: 'SYNTHETIC_RESEARCH_TRIGGER_RECORDED', clinical_acknowledgement: false };
}

/** A verified signature binds the decision and controlled reason to one event.
 *  Cryptographic verification does not establish clinician identity or legal validity. */
export async function appendSyntheticPhysicianResponse({ audit, auth, event_id, decision, reason_code, signature, key_id, envelope } = {}) {
  requireAudit(audit);
  assertSyntheticRuntime();
  if (!Number.isSafeInteger(event_id) || event_id < 1 || !['agree','override','reject'].includes(decision)
      || !reasonCodes.has(reason_code) || !signature || !key_id || !envelope) throw new Error('SYNTHETIC_RESPONSE_FIELDS_INVALID');
  if (decision === 'agree' && !['reviewed_consistent','other_not_recorded'].includes(reason_code)
      || decision !== 'agree' && reason_code === 'reviewed_consistent') throw new Error('SYNTHETIC_RESPONSE_REASON_MISMATCH');
  const event = await audit.get_event({ event_id });
  if (!event || event.error || event.action !== 'synthetic_reconciliation_trigger'
      || event.payload?.schema_version !== 'medcius.synthetic-reconciliation-audit.v1'
      || event.payload?.purpose !== 'synthetic_replay_only') throw new Error('SYNTHETIC_RESPONSE_EVENT_INVALID');
  requireAuth(auth, event.tenant_id, 'physician');
  if (!(await audit.verify_chain({})).ok) throw new Error('SYNTHETIC_AUDIT_CHAIN_INVALID');
  const signedAt = instant(envelope.signed_at), eventAt = Date.parse(`${event.ts.replace(' ', 'T')}Z`);
  if (signedAt == null || !Number.isFinite(eventAt) || signedAt < eventAt || signedAt > Date.now() + 30000) throw new Error('SYNTHETIC_RESPONSE_TIME_INVALID');
  const result = await audit.signoff({ event_id, tenant_id: event.tenant_id, signer: auth.user, role: 'physician',
    decision, reason: reason_code, signature, key_id, envelope });
  if (result.signature_verified !== true || !(await audit.verify_chain({})).ok) throw new Error('SYNTHETIC_AUDIT_SIGNOFF_UNVERIFIED');
  return { event_id, signoff_id: result.signoff_id, decision, reason_code, signature_verified: true,
    identity_assurance: 'NOT_ESTABLISHED', legal_validity: 'NOT_ESTABLISHED', clinical_acknowledgement: false };
}
