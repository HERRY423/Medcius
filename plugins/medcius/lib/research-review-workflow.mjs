// Research-only review of a frozen snapshot. Never acknowledges a live EHR
// result, changes a source record, or promotes clinical evidence.
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { readFrozenResearchRecord } from "./silent-research-archive.mjs";
import { classifyRecordLifecycle } from "./record-lifecycle.mjs";
import { HANDLERS as audit, encodeAuditDigest, decodeAuditDigest, encodeAuditResearchReference } from "../servers/audit/src/tools.mjs";
import { buildSignoffEnvelope } from "../servers/shared/digital-signature.mjs";

const digest = value => sha256Hex(canonicalJson(value));
export const REVIEW_AXES = ["source", "time", "state", "missingness", "fact"];
export const REVIEW_VERDICTS = ["supported", "contradicted", "uncertain", "not_evaluated"];
const REASON = "Research assessment attestation; no clinical action or EHR acknowledgement";

function requireResearchIdentity(auth, physician = false) {
  if (!auth?.isAuthenticated || !auth.user || !auth.tenantId || auth.tenantId === "default"
      || !auth.roles?.some(role => ["auditor", "admin"].includes(role))
      || (physician && !auth.roles.includes("physician"))) throw new Error("RESEARCH_REVIEW_FORBIDDEN");
}

function auditedRecord(caseId, auth) {
  requireResearchIdentity(auth);
  if (!audit.verify_chain({}).ok) throw new Error("RESEARCH_REVIEW_AUDIT_INVALID");
  const record = readFrozenResearchRecord(caseId, { tenantId: auth.tenantId });
  if (!record) throw new Error("FROZEN_RECORD_NOT_FOUND");
  const events = audit.query_events({ action: "his_embed_silent_capture", tenant_id: auth.tenantId,
    subject_ref: encodeAuditResearchReference(caseId), limit: 1 }).events;
  const anchor = events.length ? audit.get_event({ event_id: events[0].id }) : null;
  if (!anchor || decodeAuditDigest(anchor.payload.record_sha256) !== record.record_sha256
      || decodeAuditDigest(anchor.payload.input_sha256) !== record.input_sha256
      || decodeAuditDigest(anchor.payload.output_sha256) !== record.output_sha256) throw new Error("RESEARCH_REVIEW_ANCHOR_REQUIRED");
  return record;
}

export function getResearchReviewPacket(caseId, auth) {
  const record = auditedRecord(caseId, auth);
  const input = record.engine_input;
  const cutoffTime = new Date(Date.parse(record.as_of) - (input.timeWindow === "72h" ? 72 : 24) * 3600000).toISOString();
  const sourceRecords = [];
  for (const [field, sourceType] of Object.entries({ notes: "note", observations: "observation",
    medications: "medication", diagnosticReports: "diagnostic_report", orders: "order" })) {
    for (const source of input[field] || []) sourceRecords.push({ source_type: sourceType, source_id: source.id ?? null,
      source_sha256: digest(source), lifecycle: classifyRecordLifecycle(source, { sourceType, now: record.as_of, cutoffTime }),
      record: source });
  }
  // Preserve the full frozen inputs, including nursing feeds and source history:
  // an item link is a navigation aid, never a statement that its fact is correct.
  const output = record.annotation_output;
  const candidates = (output.selectable_items || []).map(item => ({ kind: "summary_item", content: item }));
  for (const item of output.blocks?.high_risk_followup?.items || []) candidates.push({ kind: "followup", content: item });
  for (const field of ["nursing_vitals_summary", "fluid_balance_24h", "critical_values", "antibiotic_duration_alerts", "imaging_impressions"]) {
    if (output.blocks?.what_changed?.[field] != null) candidates.push({ kind: `panel:${field}`, content: output.blocks.what_changed[field] });
  }
  const rows = candidates.map(({ kind, content }, index) => {
    const refs = new Set([content.source_id, ...(Array.isArray(content.evidence) ? content.evidence.map(e => e.source_id) : [])].filter(Boolean));
    const links = sourceRecords.filter(source => refs.has(source.source_id));
    return { row_id: `row-${index + 1}`, kind, content, row_sha256: digest({ kind, content }),
      source_candidates: links.map(({ source_sha256, source_id, source_type }) => ({ source_sha256, source_id, source_type })),
      source_link_status: !links.length ? "unresolved_or_derived" : links.length > 1 ? "multiple_candidates_review_required" : "linked_not_validated",
      assessment: Object.fromEntries(REVIEW_AXES.map(axis => [axis, "not_evaluated"])) };
  });
  const packet = { schema_version: "medcius.research-review-packet.v1", purpose: "research_annotation_only",
    case_id: caseId, tenant_id: record.tenant_id, record_sha256: record.record_sha256,
    input_sha256: record.input_sha256, output_sha256: record.output_sha256, algorithm_identity: record.algorithm_identity,
    as_of: record.as_of, cutoff: cutoffTime, rule_pack: input.rulePack ?? null,
    source_manifest: record.source_manifest, source_availability: record.source_availability || [],
    unavailable_sources: record.unavailable_sources, degraded_records: record.degraded_records, failures: record.failures,
    source_records: sourceRecords, frozen_inputs: record.replay_input, frozen_output: output, rows,
    review_state: "unreviewed", clinical_acknowledgement: false, clinical_evidence_pass: false,
    omission_reference: "Independent source-first reference required; reviewing generated rows cannot measure recall" };
  return { ...packet, packet_sha256: digest(packet) };
}

export function prepareResearchReview({ case_id, packet_sha256, assessments }, auth) {
  requireResearchIdentity(auth, true);
  const packet = getResearchReviewPacket(case_id, auth);
  if (packet_sha256 !== packet.packet_sha256) throw new Error("RESEARCH_REVIEW_STALE_PACKET");
  if (!Array.isArray(assessments) || !assessments.length) throw new Error("RESEARCH_REVIEW_ASSESSMENTS_REQUIRED");
  const seen = new Set();
  const checked = assessments.map(assessment => {
    if (!assessment || Object.keys(assessment).some(key => !["row_id", "row_sha256", ...REVIEW_AXES].includes(key))) throw new Error("RESEARCH_REVIEW_FIELDS_INVALID");
    const row = packet.rows.find(row => row.row_id === assessment.row_id);
    if (!row || seen.has(row.row_id) || row.row_sha256 !== assessment.row_sha256) throw new Error("RESEARCH_REVIEW_ROW_MISMATCH");
    seen.add(row.row_id);
    if (REVIEW_AXES.some(axis => !REVIEW_VERDICTS.includes(assessment[axis]))) throw new Error("RESEARCH_REVIEW_VERDICT_REQUIRED");
    return { row_id: row.row_id, row_digest: encodeAuditDigest(row.row_sha256),
      ...Object.fromEntries(REVIEW_AXES.map(axis => [axis, assessment[axis]])) };
  });
  // No clinical text in the audit record. PHI Guard remains mandatory there.
  const event = audit.record_event({ actor: auth.user, action: "research_item_review", tenant_id: auth.tenantId,
    subject_ref: encodeAuditResearchReference(case_id), payload: { purpose: "research_annotation_only",
      record_digest: encodeAuditDigest(packet.record_sha256), packet_digest: encodeAuditDigest(packet_sha256),
      output_digest: encodeAuditDigest(packet.output_sha256), assessments: checked,
      total_rows: packet.rows.length, omitted_rows: packet.rows.length - checked.length,
      clinical_acknowledgement: false, clinical_evidence_pass: false } });
  return { event_id: event.event_id, event_digest: event.event_digest, case_id, packet_sha256,
    signer: auth.user, role: "physician", decision: "agree", reason: REASON,
    review_state: "pending_signature", clinical_acknowledgement: false, clinical_evidence_pass: false };
}

export function getResearchReviewStatus({ case_id, event_id }, auth) {
  const packet = getResearchReviewPacket(case_id, auth);
  if (!Number.isSafeInteger(event_id) || event_id < 1) throw new Error("RESEARCH_REVIEW_EVENT_INVALID");
  const event = audit.get_event({ event_id });
  if (event.action !== "research_item_review" || event.tenant_id !== auth.tenantId
      || event.subject_ref !== encodeAuditResearchReference(case_id)
      || decodeAuditDigest(event.payload.packet_digest) !== packet.packet_sha256
      || decodeAuditDigest(event.payload.record_digest) !== packet.record_sha256) throw new Error("RESEARCH_REVIEW_EVENT_MISMATCH");
  const signed = event.signoffs.some(sign => sign.signer === event.actor && sign.role === "physician"
    && sign.signature && sign.decision === "agree" && sign.reason === REASON);
  return { case_id, event_id, packet_sha256: packet.packet_sha256, reviewer_id: event.actor,
    review_state: signed ? "signed_research_assessment" : "pending_signature",
    assessments: event.payload.assessments, total_rows: event.payload.total_rows, omitted_rows: event.payload.omitted_rows,
    clinical_acknowledgement: false, clinical_evidence_pass: false };
}

export function confirmResearchReview({ case_id, event_id, signature, key_id, envelope }, auth) {
  requireResearchIdentity(auth, true);
  const status = getResearchReviewStatus({ case_id, event_id }, auth);
  if (status.reviewer_id !== auth.user) throw new Error("RESEARCH_REVIEW_SIGNER_MISMATCH");
  if (status.review_state !== "pending_signature") throw new Error("RESEARCH_REVIEW_ALREADY_SIGNED");
  if (!signature || !envelope) throw new Error("RESEARCH_REVIEW_SIGNATURE_REQUIRED");
  const event = audit.get_event({ event_id });
  const expected = buildSignoffEnvelope({ eventId: event_id, eventDigest: event.event_digest, tenantId: auth.tenantId,
    signer: auth.user, role: "physician", decision: "agree", reason: REASON,
    signedAt: envelope.signed_at, replayId: envelope.replay_id });
  if (canonicalJson(expected.envelope) !== canonicalJson(envelope)) throw new Error("RESEARCH_REVIEW_SIGNED_CONTENT_MISMATCH");
  const signedAt = Date.parse(envelope.signed_at);
  if (signedAt < Date.parse(`${event.ts.replace(" ", "T")}Z`) || signedAt > Date.now() + 30000) throw new Error("RESEARCH_REVIEW_SIGNING_TIME_INVALID");
  audit.signoff({ event_id, signer: auth.user, role: "physician", decision: "agree", reason: REASON,
    tenant_id: auth.tenantId, signature, key_id, envelope });
  return getResearchReviewStatus({ case_id, event_id }, auth);
}
