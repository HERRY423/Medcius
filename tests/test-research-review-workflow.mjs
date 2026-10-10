import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.CLAUDE_MEDCIUS_DATA = mkdtempSync(join(tmpdir(), "medcius-review-"));
process.env.CLAUDE_MEDCIUS_PHI_SALT = "synthetic-review-salt-only";
for (const key of ["MEDCIUS_PROFILE", "NODE_ENV", "MEDCIUS_CLINICAL_LANDING", "MEDCIUS_LIVE_HOSPITAL_DATA"]) delete process.env[key];
const { executeHisEmbedPreRound } = await import("../plugins/medcius/lib/his-embed-adapter.mjs");
const { GovernanceStateManager } = await import("../plugins/medcius/lib/governance-mode.mjs");
const { HANDLERS: audit, encodeAuditDigest, encodeAuditResearchReference } = await import("../plugins/medcius/servers/audit/src/tools.mjs");
const { getResearchReviewPacket, prepareResearchReview, confirmResearchReview, getResearchReviewStatus, REVIEW_AXES } = await import("../plugins/medcius/lib/research-review-workflow.mjs");
const { generateKeyPair, buildSignoffEnvelope, signSignoffEnvelope } = await import("../plugins/medcius/servers/shared/digital-signature.mjs");
const { routeRequest } = await import("../plugins/medcius/servers/api/src/rest-routes.mjs");
const { generateToken } = await import("../plugins/medcius/servers/api/src/auth-middleware.mjs");
const { readFrozenResearchRecord } = await import("../plugins/medcius/lib/silent-research-archive.mjs");
const { summarizeBenefitObservations, TIME_COMPONENTS } = await import("../plugins/medcius/evals/clinical-benefit/observations.mjs");

const context = { tenant_id: "tenant-review-synthetic", doctor_id: "capture-synthetic", patient_id: "patient-review-synthetic",
  encounter_id: "encounter-review-synthetic", as_of: "2026-10-04T12:00:00.000Z" };
const auth = { isAuthenticated: true, user: "reviewer-synthetic", tenantId: context.tenant_id, roles: ["physician", "auditor"] };
const ownership = { tenant_id: context.tenant_id, patient_id: context.patient_id, encounter_id: context.encounter_id, ownership_status: "verified" };
const lab = { id: "synthetic-result", ...ownership, code: "k", name: "合成血钾", unit: "mmol/L", value: 4,
  status: "final", version_id: "v1", sample_time: "2026-10-04T08:00:00Z", resulted_at: "2026-10-04T09:00:00Z",
  _source: { system: "synthetic-lis", record_id: "synthetic-result" } };
const feed = { patient: { id: context.patient_id }, notes: [], nis: [],
  lis: [lab, { ...lab, value: 3.5, status: "corrected", version_id: "v2", updated_at: "2026-10-04T10:00:00Z" }], pacs: [], his_orders: [],
  source_availability: [{ kind: "pacs", connector_id: "synthetic-pacs", status: "unavailable", reason_code: "SOURCE_TIMEOUT" },
    { kind: "lis", connector_id: "synthetic-lis", status: "available" }] };
async function capture(dataFeeds = feed) {
  return executeHisEmbedPreRound({ context, dataFeeds, governance: new GovernanceStateManager("retrospective_study"),
    auditAppend: event => audit.record_event({ actor: "capture-synthetic", action: "his_embed_silent_capture", tenant_id: event.tenant_id,
      subject_ref: encodeAuditResearchReference(event.research_record_id), payload: {
        record_sha256: encodeAuditDigest(event.record_sha256), input_sha256: encodeAuditDigest(event.input_sha256), output_sha256: encodeAuditDigest(event.output_sha256) } }) });
}
const captured = await capture();
assert.equal(captured.summary, null);
assert.deepEqual(captured.cards, []);
const packet = getResearchReviewPacket(captured.research_record_id, auth);
assert.equal(packet.source_availability[0].status, "unavailable");
assert.equal(packet.rows.length > 0, true);
assert.equal(packet.source_records.some(source => source.lifecycle.version_id === "v2"), true);
assert.equal(packet.rows.some(row => row.source_candidates.length > 0), true);
assert.equal(packet.rows.every(row => REVIEW_AXES.every(axis => row.assessment[axis] === "not_evaluated")), true);
assert.equal(packet.clinical_acknowledgement, false);
assert.equal(packet.packet_sha256, getResearchReviewPacket(captured.research_record_id, auth).packet_sha256);
assert.throws(() => getResearchReviewPacket(captured.research_record_id, { ...auth, roles: ["physician"] }), /FORBIDDEN/);
assert.throws(() => getResearchReviewPacket(captured.research_record_id, { ...auth, tenantId: "another-tenant" }), /NOT_FOUND/);
const row = packet.rows[0];
const assessment = { row_id: row.row_id, row_sha256: row.row_sha256, ...Object.fromEntries(REVIEW_AXES.map(axis => [axis, "uncertain"])) };
const request = { case_id: packet.case_id, packet_sha256: packet.packet_sha256, assessments: [assessment] };
assert.throws(() => prepareResearchReview(request, { ...auth, roles: ["auditor"] }), /FORBIDDEN/);
assert.throws(() => prepareResearchReview({ ...request, packet_sha256: "0".repeat(64) }, auth), /STALE/);
assert.throws(() => prepareResearchReview({ ...request, assessments: [assessment, assessment] }, auth), /ROW_MISMATCH/);
assert.throws(() => prepareResearchReview({ ...request, assessments: [{ ...assessment, fact: undefined }] }, auth), /VERDICT_REQUIRED/);
assert.throws(() => prepareResearchReview({ ...request, assessments: [{ ...assessment, comment: "姓名：张三" }] }, auth), /FIELDS_INVALID/);
const prepared = prepareResearchReview(request, auth);
assert.equal(prepared.review_state, "pending_signature");
const query = { case_id: packet.case_id, event_id: prepared.event_id };
assert.equal(getResearchReviewStatus(query, auth).omitted_rows, packet.rows.length - 1);
assert.throws(() => confirmResearchReview(query, auth), /SIGNATURE_REQUIRED/);
assert.throws(() => confirmResearchReview(query, { ...auth, user: "other-reviewer" }), /SIGNER_MISMATCH/);
const keys = generateKeyPair(auth.user);
const { envelope } = buildSignoffEnvelope({ eventId: prepared.event_id, eventDigest: prepared.event_digest,
  tenantId: auth.tenantId, signer: auth.user, role: "physician", decision: prepared.decision, reason: prepared.reason,
  signedAt: new Date().toISOString(), replayId: "synthetic-review-first" });
const signature = signSignoffEnvelope({ envelope, privateKeyPem: keys.privateKey, keyId: keys.keyId });
assert.throws(() => confirmResearchReview({ ...query, ...signature, envelope: { ...envelope, decision: "reject" } }, auth), /SIGNED_CONTENT/);
assert.throws(() => confirmResearchReview({ ...query, ...signature, signature: "invalid-signature", envelope }, auth), /signature verification failed/);
assert.throws(() => confirmResearchReview({ ...query, ...signature, key_id: "unknown-key", envelope }, auth), /UNTRUSTED_SIGNER_KEY/);
const signed = confirmResearchReview({ ...query, ...signature, envelope }, auth);
assert.equal(signed.review_state, "signed_research_assessment");
assert.equal(signed.assessments[0].fact, "uncertain");
assert.equal(signed.clinical_evidence_pass, false);
assert.equal(signed.clinical_acknowledgement, false);
assert.throws(() => confirmResearchReview({ ...query, ...signature, envelope }, auth), /ALREADY_SIGNED/);
const newer = await capture({ ...feed, source_availability: [{ ...feed.source_availability[0], status: "available_empty" }] });
assert.throws(() => getResearchReviewStatus({ ...query, case_id: newer.research_record_id }, auth), /EVENT_MISMATCH/);
assert.equal(readFrozenResearchRecord(packet.case_id, { tenantId: auth.tenantId }).output_sha256, packet.output_sha256);
assert.equal(audit.verify_chain({}).ok, true);

async function route(path, roles, method = "GET", body = undefined) {
  const token = generateToken({ sub: auth.user, tenant_id: auth.tenantId, roles });
  let status, result;
  await routeRequest({ method, url: path, headers: { host: "localhost", authorization: `Bearer ${token}` }, socket: { remoteAddress: "127.0.0.1" } },
    { writeHead(code) { status = code; }, end(data) { result = JSON.parse(data); } }, body);
  return { status, result };
}
const path = `/api/v1/research/review-packet?case_id=${packet.case_id}`;
assert.equal((await route(path, ["physician"])).status, 403);
assert.equal((await route(path, ["auditor"])).status, 200);
assert.equal((await route("/api/v1/research/review/prepare", ["auditor"], "POST", request)).status, 403);
const routePrepared = (await route("/api/v1/research/review/prepare", auth.roles, "POST", request)).result;
assert.equal(routePrepared.review_state, "pending_signature");
const routeEnvelope = buildSignoffEnvelope({ eventId: routePrepared.event_id, eventDigest: routePrepared.event_digest,
  tenantId: auth.tenantId, signer: auth.user, role: "physician", decision: "agree", reason: routePrepared.reason,
  signedAt: new Date().toISOString(), replayId: "synthetic-route-review" }).envelope;
const routeSignature = signSignoffEnvelope({ envelope: routeEnvelope, privateKeyPem: keys.privateKey, keyId: keys.keyId });
const confirmedRoute = await route("/api/v1/research/review/confirm", auth.roles, "POST", {
  case_id: packet.case_id, event_id: routePrepared.event_id, ...routeSignature, envelope: routeEnvelope });
assert.equal(confirmedRoute.status, 200);
assert.equal(confirmedRoute.result.review_state, "signed_research_assessment");
assert.equal((await route(`/api/v1/research/review/status?case_id=${packet.case_id}&event_id=${routePrepared.event_id}`, ["auditor"])).result.clinical_acknowledgement, false);

const empty = summarizeBenefitObservations({ expected_episode_ids: ["episode-a"] });
assert.equal(empty.missing_episodes, 1);
assert.equal(empty.descriptive_mean_saved_seconds, null);
const arm = { status: "completed", ...Object.fromEntries(TIME_COMPONENTS.map(key => [key, 10])),
  accuracy: { reference_facts: 3, matched_facts: 1, omitted_facts: 1, incorrect_facts: 1, unsupported_facts: 2 },
  safety: { assessed: true, critical_opportunities: 0, critical_omissions: 0, wrong_patient: 0, wrong_time: 0, wrong_unit: 0, false_closure: 0, adverse_events: 0 } };
const observed = { episode_id: "episode-a", packet_sha256: packet.packet_sha256, review_event_id: prepared.event_id,
  reference: { source_first: true, rater_a: "synthetic-a", rater_b: "synthetic-b", adjudication_complete: true, reference_sha256: "a".repeat(64) },
  control: arm, intervention: { ...arm, correction_seconds: 20 } };
const measured = summarizeBenefitObservations({ expected_episode_ids: ["episode-a", "episode-b"], observations: [observed] });
assert.equal(measured.descriptive_mean_saved_seconds, -10);
assert.equal(measured.missing_episodes, 1);
assert.equal(measured.episodes[0].control.safety.critical_omission_rate, null);
assert.equal(measured.clinical_evidence_pass, false);
assert.equal(measured.safety_non_inferiority, null);
assert.throws(() => summarizeBenefitObservations({ expected_episode_ids: ["episode-a"], observations: [observed, observed] }), /DUPLICATE/);
assert.throws(() => summarizeBenefitObservations({ expected_episode_ids: ["episode-a"], observations: [{ ...observed, control: { ...arm, accuracy: { ...arm.accuracy, reference_facts: 9 } } }] }), /DENOMINATOR/);
const missingTime = summarizeBenefitObservations({ expected_episode_ids: ["episode-a"], observations: [{ ...observed, intervention: { ...arm, verification_seconds: null } }] });
assert.equal(missingTime.paired_timing_episodes, 0);
if (process.env.MEDCIUS_REVIEW_ARTIFACT_DIR) {
  const dir = process.env.MEDCIUS_REVIEW_ARTIFACT_DIR;
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries({ "synthetic-review-packet.json": packet,
    "synthetic-signed-review.json": signed, "synthetic-measurement-check.json": measured })) {
    writeFileSync(join(dir, file), JSON.stringify({ data_class: "synthetic", clinical_evidence_pass: false, content }, null, 2), "utf8");
  }
}
console.log("Research review: frozen packet -> pending -> physician signature -> audit readback; negative routes, stale versions and descriptive measurement checks passed (synthetic only).");
