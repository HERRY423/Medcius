// Acceptance checks for the three 2026-10-04 boundary fixes:
// identity/time/PHI/signoff, evidence status, and one silent hospital path.
// Synthetic fixtures only. A passing run is not clinical evidence.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "medcius-boundary-"));
process.env.CLAUDE_MEDCIUS_DATA = dataDir;
process.env.CLAUDE_MEDCIUS_PHI_SALT = "synthetic-boundary-salt-0123456789";
delete process.env.MEDCIUS_CLINICAL_LANDING;
delete process.env.MEDCIUS_LIVE_HOSPITAL_DATA;
delete process.env.MEDCIUS_PROFILE;
delete process.env.NODE_ENV;
process.env.MEDCIUS_GOVERNANCE_STAGE = "silent_pilot";

const { createFhirR4Connectors } = await import("../plugins/medcius/lib/connectors/fhir-r4-connector.mjs");
const { withPhiExitGuard } = await import("../plugins/medcius/lib/connectors/phi-exit-guard.mjs");
const { HospitalAgentAdapter } = await import("../plugins/medcius/lib/hospital-agent-adapter.mjs");
const { PatientEvolutionEngine } = await import("../plugins/medcius/lib/patient-evolution-engine.mjs");
const { containsRawPhi } = await import("../plugins/medcius/servers/phiguard/src/lib.mjs");
const { HANDLERS: auditHandlers } = await import("../plugins/medcius/servers/audit/src/tools.mjs");
const {
  generateKeyPair,
  signDecision,
  buildSignoffEnvelope,
  signSignoffEnvelope,
} = await import("../plugins/medcius/servers/shared/digital-signature.mjs");
const { resolveCallerEvidenceStatus } = await import("../plugins/medcius/evals/evidence-status.mjs");
const { evaluatePhysicianAnnotation } = await import("../plugins/medcius/evals/physician-annotation/physician-annotation-engine.mjs");
const { GovernanceStateManager } = await import("../plugins/medcius/lib/governance-mode.mjs");
const { executeHisEmbedPreRound } = await import("../plugins/medcius/lib/his-embed-adapter.mjs");
const {
  setAuthorizedHospitalSource,
  clearAuthorizedHospitalSource,
} = await import("../plugins/medcius/lib/authorized-hospital-source.mjs");
const {
  readFrozenResearchRecord,
  replayFrozenResearchRecord,
} = await import("../plugins/medcius/lib/silent-research-archive.mjs");
const { generateToken, ROLES } = await import("../plugins/medcius/servers/api/src/auth-middleware.mjs");
const { routeRequest } = await import("../plugins/medcius/servers/api/src/rest-routes.mjs");

const AS_OF = "2026-10-04T00:00:00.000Z";
const CONTEXT = {
  tenant_id: "tenant-synth",
  doctor_id: "doctor-synth",
  patient_id: "patient-synthetic-1",
  encounter_id: "encounter-synthetic-1",
  as_of: AS_OF,
  time_window: "24h",
};

function fhirResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

console.log("== Boundary, evidence status, and silent-path acceptance ==");

console.log("\n[1] FHIR cross-subject is rejected");
const fhir = createFhirR4Connectors({
  baseUrl: "https://fhir.synthetic.local/r4",
  fetchImpl: async (url) => {
    if (String(url).includes("/Patient/")) {
      return fhirResponse({
        resourceType: "Patient",
        id: "patient-other",
        name: [{ text: "合成乙" }],
      });
    }
    return fhirResponse({
      resourceType: "Bundle",
      type: "searchset",
      entry: [{
        resource: {
          resourceType: "Observation",
          id: "obs-cross",
          status: "final",
          subject: { reference: "Patient/patient-other" },
          encounter: { reference: "Encounter/encounter-synthetic-1" },
          code: { coding: [{ code: "2823-3", display: "Potassium" }] },
          valueQuantity: { value: 2.4, unit: "mmol/L" },
          effectiveDateTime: "2026-10-03T12:00:00Z",
        },
      }],
    });
  },
});
const fhirContext = {
  tenant_id: CONTEXT.tenant_id,
  doctor_id: CONTEXT.doctor_id,
  patient_id: CONTEXT.patient_id,
  encounter_id: CONTEXT.encounter_id,
};
await assert.rejects(() => fhir[0].readPatient(fhirContext), /CONNECTOR_PATIENT_MISMATCH/);
await assert.rejects(() => fhir[2].readPatient(fhirContext), /CONNECTOR_PATIENT_MISMATCH/);
console.log("✓ Patient id and Observation.subject disagreeing with the request are rejected");

console.log("\n[2] Adapter rejects a note owned by another patient or encounter");
const baseFeeds = {
  patient: { id: CONTEXT.patient_id, gender: "male" },
  notes: [],
  nis: [],
  lis: [],
  pacs: [],
  his_orders: [],
};
assert.throws(
  () => HospitalAgentAdapter.executePreRoundWorkflow({
    host: "codex",
    context: CONTEXT,
    dataFeeds: {
      ...baseFeeds,
      notes: [{
        id: "note-cross-patient",
        patient_id: "patient-other",
        encounter_id: CONTEXT.encounter_id,
        timestamp: "2026-10-03T12:00:00Z",
        text: "病程记录：患者咳嗽。",
      }],
    },
  }),
  /FAIL_CLOSED_PATIENT_MISMATCH/,
);
assert.throws(
  () => HospitalAgentAdapter.executePreRoundWorkflow({
    host: "codex",
    context: CONTEXT,
    dataFeeds: {
      ...baseFeeds,
      notes: [{
        id: "note-cross-encounter",
        patient_id: CONTEXT.patient_id,
        encounter_id: "encounter-other",
        timestamp: "2026-10-03T12:00:00Z",
        text: "病程记录：患者咳嗽。",
      }],
    },
  }),
  /FAIL_CLOSED_ENCOUNTER_MISMATCH/,
);
console.log("✓ Cross-patient and cross-encounter notes fail closed");

console.log("\n[3] Unknown and future notes stay out of the symptom list");
const timed = PatientEvolutionEngine.analyzePatientEvolution({
  patient: { id: CONTEXT.patient_id },
  now: AS_OF,
  notes: [
    { id: "note-unknown", timestamp: null, text: "病程记录：患者发热。" },
    { id: "note-future", timestamp: "2099-01-01T00:00:00Z", text: "病程记录：患者高热。" },
    { id: "note-window", timestamp: "2026-10-03T18:00:00Z", text: "病程记录：患者咳嗽，气促。" },
  ],
});
const symptomText = JSON.stringify(timed.blocks.what_changed.clinical_symptoms);
assert.equal(symptomText.includes("发热"), false);
assert.equal(symptomText.includes("高热"), false);
assert.equal(symptomText.includes("咳嗽"), true);
const gapTypes = timed.blocks.data_gaps.map((gap) => gap.gap_type);
assert.ok(gapTypes.includes("NOTE_TIME_UNKNOWN"));
assert.ok(gapTypes.includes("NOTE_TIME_FUTURE"));
console.log("✓ Missing and future note times are gaps, not current symptoms");

console.log("\n[4] A 2001 temperature does not enter the 24h summary");
const staleNis = PatientEvolutionEngine.analyzePatientEvolution({
  patient: { id: CONTEXT.patient_id },
  now: AS_OF,
  nisFeed: [{ id: "nis-2001", timestamp: "2001-01-01T08:00:00Z", temperature: 40.9 }],
});
assert.equal(staleNis.blocks.what_changed.vitals_and_fluids, null);
assert.equal(JSON.stringify(staleNis.blocks.what_changed).includes("40.9"), false);
assert.ok(staleNis.blocks.data_gaps.some((gap) => gap.gap_type === "NIS_WINDOW_EMPTY"));
console.log("✓ Stale nursing temperature is a window gap");

console.log("\n[5] Structured identifiers are sealed at the connector exit");
const nameHit = containsRawPhi("姓名：张三");
assert.equal(nameHit.hit, true);
assert.equal(nameHit.type, "name_label");
const guarded = withPhiExitGuard({
  id: "synthetic-phi-exit",
  kind: "notes",
  capabilities: ["read"],
  async readPatient() {
    return {
      records: [{
        id: "rec-phi",
        name: "张三",
        gender: "male",
        phone: "13800138000",
        text: "姓名：张三，病程记录：患者咳嗽。",
      }],
    };
  },
}, { salt: process.env.CLAUDE_MEDCIUS_PHI_SALT });
const released = await guarded.readPatient(fhirContext);
const releasedText = JSON.stringify(released.records);
assert.equal(releasedText.includes("张三"), false);
assert.equal(releasedText.includes("13800138000"), false);
assert.equal(containsRawPhi(releasedText).hit, false);
assert.match(releasedText, /\[ID:name:/);
console.log("✓ Exit guard seals name and phone before release");

console.log("\n[6] Model-safe adapter output does not keep a raw name");
const named = HospitalAgentAdapter.executePreRoundWorkflow({
  host: "codex",
  context: CONTEXT,
  dataFeeds: {
    ...baseFeeds,
    patient: {
      id: CONTEXT.patient_id,
      name: "张三",
      gender: "male",
      birth_date: "1990-01-01",
    },
    notes: [{
      id: "note-named",
      patient_id: CONTEXT.patient_id,
      encounter_id: CONTEXT.encounter_id,
      timestamp: "2026-10-03T12:00:00Z",
      text: "病程记录：姓名：张三。患者咳嗽，气促。",
    }],
  },
});
assert.equal(named.security_contract.phi_leakage_detected, false);
assert.equal(JSON.stringify(named.summary).includes("张三"), false);
assert.equal(named.annotation_summary, undefined);
assert.equal(named.engine_input, undefined);
assert.equal(named.engine_output, undefined);
assert.equal(JSON.stringify(named).includes("张三"), false);
assert.equal(named.summary.patient.name.startsWith("[ID:name:"), true);
console.log("✓ Model-safe response is sealed; private research input is absent");

console.log("\n[7] Signoff binds the envelope, tenant, and one replay id");
const { keyId, privateKey } = generateKeyPair("PHARM-BOUNDARY");
const recorded = auditHandlers.record_event({
  actor: "test:pharmacist",
  action: "boundary_signoff_probe",
  subject_ref: "Encounter/encounter-synthetic-1",
  payload: { verdict: "synthetic-review", case_id: "case-boundary-7" },
  tenant_id: CONTEXT.tenant_id,
});
const stored = auditHandlers.get_event({ event_id: recorded.event_id });
const reason = "合成评估，维持当前方案并继续观察";
const payloadOnly = signDecision({
  payload: stored.payload,
  privateKeyPem: privateKey,
  keyId,
  signer: "PHARM-BOUNDARY",
  role: "pharmacist",
});
assert.throws(
  () => auditHandlers.signoff({
    event_id: recorded.event_id,
    signer: "PHARM-BOUNDARY",
    role: "pharmacist",
    decision: "agree",
    reason,
    signature: payloadOnly.signature,
    key_id: keyId,
    tenant_id: CONTEXT.tenant_id,
  }),
  /SIGNOFF_ENVELOPE_INCOMPLETE/,
);
const built = buildSignoffEnvelope({
  eventId: recorded.event_id,
  eventDigest: stored.event_digest,
  tenantId: CONTEXT.tenant_id,
  signer: "PHARM-BOUNDARY",
  role: "pharmacist",
  decision: "agree",
  reason,
  signedAt: AS_OF,
  replayId: "replay-boundary-7",
});
const signed = signSignoffEnvelope({
  envelope: built.envelope,
  privateKeyPem: privateKey,
  keyId,
  signer: "PHARM-BOUNDARY",
  role: "pharmacist",
});
assert.throws(
  () => auditHandlers.signoff({
    event_id: recorded.event_id,
    signer: "PHARM-BOUNDARY",
    role: "pharmacist",
    decision: "agree",
    reason,
    signature: payloadOnly.signature,
    key_id: keyId,
    signed_hash: payloadOnly.signed_hash,
    tenant_id: CONTEXT.tenant_id,
    envelope: built.envelope,
  }),
  /verification failed|SIGNOFF_ENVELOPE_INCOMPLETE/,
);
const accepted = auditHandlers.signoff({
  event_id: recorded.event_id,
  signer: "PHARM-BOUNDARY",
  role: "pharmacist",
  decision: "agree",
  reason,
  signature: signed.signature,
  signature_algorithm: signed.signature_algorithm,
  key_id: keyId,
  signed_hash: signed.signed_hash,
  tenant_id: CONTEXT.tenant_id,
  envelope: built.envelope,
});
assert.equal(accepted.signature_verified, true);
assert.throws(
  () => auditHandlers.signoff({
    event_id: recorded.event_id,
    signer: "PHARM-BOUNDARY",
    role: "pharmacist",
    decision: "agree",
    reason,
    signature: signed.signature,
    key_id: keyId,
    tenant_id: CONTEXT.tenant_id,
    envelope: built.envelope,
  }),
  /SIGNOFF_REPLAY/,
);
assert.throws(
  () => auditHandlers.signoff({
    event_id: recorded.event_id,
    signer: "PHARM-BOUNDARY",
    role: "pharmacist",
    decision: "reject",
    reason,
    signature: signed.signature,
    key_id: keyId,
    tenant_id: CONTEXT.tenant_id,
    envelope: { ...built.envelope, decision: "reject", replay_id: "replay-boundary-7b" },
  }),
  /SIGNOFF_ENVELOPE_INCOMPLETE|verification failed|SIGNOFF_REPLAY/,
);
assert.throws(
  () => auditHandlers.signoff({
    event_id: recorded.event_id,
    signer: "PHARM-BOUNDARY",
    role: "pharmacist",
    decision: "agree",
    reason,
    signature: signed.signature,
    key_id: keyId,
    tenant_id: "tenant-other",
    envelope: { ...built.envelope, tenant_id: "tenant-other", replay_id: "replay-boundary-7c" },
  }),
  /SIGNOFF_TENANT_MISMATCH/,
);
assert.throws(
  () => auditHandlers.signoff({
    event_id: recorded.event_id,
    signer: "PHARM-BOUNDARY",
    role: "pharmacist",
    decision: "agree",
    reason: "联系电话 13800138000",
    tenant_id: CONTEXT.tenant_id,
  }),
  /PHI guard/,
);
assert.equal(auditHandlers.verify_chain({}).ok, true);
console.log("✓ Payload-only, retargeted, replayed, and phone-number signoffs are rejected");

console.log("\n[8] Caller arguments cannot upgrade synthetic data");
const upgraded = resolveCallerEvidenceStatus({
  isDemo: false,
  ethicsApprovalNumber: "",
  allPrimaryMet: true,
});
assert.equal(upgraded.clinical_evidence_pass, false);
assert.equal(upgraded.caller_upgrade_attempted, true);
assert.equal(upgraded.engineering_pass, true);
assert.equal(upgraded.synthetic_validation_pass, false, "A non-demo caller claim does not establish synthetic validation provenance");
assert.equal(upgraded.endpoint_pass, true);
assert.equal(upgraded.human_acceptance, null);
assert.equal(upgraded.blocked_reason, "EVIDENCE_CLASS_NOT_UPGRADABLE_BY_CALLER_ARGUMENT");
console.log("✓ isDemo:false and an empty ethics number stay blocked");

console.log("\n[9] Missing anchors, abstention, wrong category, and unadjudicated rows are counted");
const annotation = evaluatePhysicianAnnotation([
  {
    physician_a: "critical_lab",
    physician_b: "critical_lab",
    ai_extracted: "medication",
    is_critical_point: true,
    span: "钾 2.4 mmol/L",
    is_verbatim_span: true,
    dimension: "labs",
  },
  {
    physician_a: "symptom",
    physician_b: "symptom",
    ai_extracted: "symptom",
    span: null,
    is_verbatim_span: false,
    dimension: "symptoms",
  },
  {
    physician_a: "flag",
    physician_b: "clear",
    adjudicator: null,
    ai_extracted: "flag",
    is_critical_point: true,
    span: "需复核",
    is_verbatim_span: true,
    dimension: "alerts",
  },
  {
    physician_a: "symptom",
    physician_b: "symptom",
    ai_extracted: null,
    span: "患者咳嗽",
    is_verbatim_span: true,
    dimension: "symptoms",
  },
], { isDemo: false, metadata: { ethics_approval_number: "" } });
assert.ok(annotation.overall.critical_misclassifications >= 1);
assert.ok(annotation.overall.missing_evidence_anchors >= 1);
assert.ok(annotation.overall.unadjudicated >= 1);
assert.ok(annotation.overall.abstentions >= 1);
assert.ok(annotation.overall.fn >= 1);
assert.equal(annotation.endpoints.evidence_anchors_complete, false);
assert.equal(annotation.endpoints.all_disagreements_adjudicated, false);
assert.equal(annotation.endpoints.zero_critical_escape_met, false);
assert.equal(annotation.allPrimaryMet, false);
assert.equal(annotation.passClassification.clinical_evidence_pass, false);
assert.equal(annotation.passClassification.caller_upgrade_attempted, true);
assert.equal(annotation.key_integrity.missing_keys, 4);
assert.equal(annotation.endpoints.record_keys_complete, false);
console.log("✓ Those four failure modes enter the endpoint counts");

console.log("\n[10] Formal silent capture freezes an output an auditor can read and replay");
process.env.MEDCIUS_PROFILE = "production";
process.env.MEDCIUS_CLINICAL_LANDING = "1";
process.env.MEDCIUS_JWT_SECRET = "synthetic-boundary-jwt-secret-0123456789";
const bridge = {
  async readPatientSnapshot(context) {
    return {
      schema_version: "medcius.synthetic-bridge.v1",
      completeness: "complete",
      source_manifest: [{ connector_id: "synthetic-authorized", kind: "patient" }],
      unavailable_sources: [],
      degraded_records: [],
      security_contract: { read_only_enforced: true },
      dataFeeds: {
        patient: { id: context.patient_id, gender: "male", name: "合成甲" },
        notes: [{
          id: "note-authorized",
          patient_id: context.patient_id,
          encounter_id: context.encounter_id,
          timestamp: "2026-10-03T12:00:00Z",
          text: "病程记录：患者咳嗽，气促。",
        }],
        nis: [],
        lis: [],
        pacs: [],
        his_orders: [],
      },
    };
  },
};
await assert.rejects(
  () => executeHisEmbedPreRound({
    governance: new GovernanceStateManager("silent_pilot"),
    context: CONTEXT,
    dataFeeds: { patient: { id: CONTEXT.patient_id, gender: "male" } },
  }),
  /CALLER_FEEDS_FORBIDDEN/,
);
setAuthorizedHospitalSource({ bridge, tenantId: CONTEXT.tenant_id,
  authorizeContext: async () => true, clock: () => AS_OF });
const requestedContext = { patient_id: CONTEXT.patient_id, encounter_id: CONTEXT.encounter_id };
const libraryCapture = await executeHisEmbedPreRound({
  governance: new GovernanceStateManager("silent_pilot"),
  context: requestedContext,
  authContext: { isAuthenticated: true, user: CONTEXT.doctor_id, tenantId: CONTEXT.tenant_id },
  auditAppend: async () => {},
});
assert.equal(libraryCapture.silent, true);
assert.equal(libraryCapture.summary, null);
assert.deepEqual(libraryCapture.cards, []);
assert.equal(libraryCapture.replayable, true);
assert.match(libraryCapture.research_record_id, /^frr-[a-f0-9]{20}$/);
assert.equal(libraryCapture.source_bridge.dataFeeds, undefined);
const frozen = readFrozenResearchRecord(libraryCapture.research_record_id, { tenantId: CONTEXT.tenant_id });
assert.ok(frozen.annotation_output);
assert.ok(frozen.engine_input);
assert.equal(frozen.output_sha256, libraryCapture.output_sha256);
const replay = replayFrozenResearchRecord(libraryCapture.research_record_id, { tenantId: CONTEXT.tenant_id });
assert.equal(replay.match, true);

const physicianToken = generateToken({
  sub: "DOC-SYNTH-001",
  name: "合成医师",
  roles: [ROLES.PHYSICIAN],
  tenant_id: CONTEXT.tenant_id,
});
const auditorToken = generateToken({
  sub: "AUD-SYNTH-001",
  name: "合成审计",
  roles: [ROLES.AUDITOR],
  tenant_id: CONTEXT.tenant_id,
});

async function callRoute(method, url, token, body) {
  const out = { status: 0, json: null };
  const res = {
    setHeader() {},
    writeHead(status) { out.status = status; },
    end(payload) { out.json = payload ? JSON.parse(payload) : null; },
  };
  const req = {
    method,
    url,
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${token}`,
      "x-tenant-id": CONTEXT.tenant_id,
    },
  };
  await routeRequest(req, res, body);
  return out;
}

try {
  const forbiddenFeeds = await callRoute(
    "POST",
    "/api/v1/his/embed/silent-capture",
    physicianToken,
    { context: CONTEXT, dataFeeds: { patient: { id: CONTEXT.patient_id } } },
  );
  assert.equal(forbiddenFeeds.status, 400);
  assert.equal(forbiddenFeeds.json.error, "CALLER_FEEDS_FORBIDDEN");

  const captureRes = await callRoute(
    "POST",
    "/api/v1/his/embed/silent-capture",
    physicianToken,
    { use_authorized_source: true, context: requestedContext },
  );
  assert.equal(captureRes.status, 200, JSON.stringify(captureRes.json));
  const captureJson = captureRes.json;
  assert.equal(captureJson.silent, true);
  assert.equal(captureJson.summary, null);
  assert.equal(captureJson.draft, null);
  assert.deepEqual(captureJson.cards, []);
  assert.equal(captureJson.annotation_summary, undefined);
  assert.match(captureJson.research_record_id, /^frr-[a-f0-9]{20}$/);

  const physicianRead = await callRoute(
    "GET",
    `/api/v1/research/frozen-record?case_id=${captureJson.research_record_id}`,
    physicianToken,
  );
  assert.equal(physicianRead.status, 403);

  const auditorRead = await callRoute(
    "GET",
    `/api/v1/research/frozen-record?case_id=${captureJson.research_record_id}`,
    auditorToken,
  );
  assert.equal(auditorRead.status, 200);
  assert.ok(auditorRead.json.annotation_output);
  assert.equal(auditorRead.json.output_sha256, captureJson.output_sha256);

  const auditorReplay = await callRoute(
    "POST",
    "/api/v1/research/frozen-record/replay",
    auditorToken,
    { case_id: captureJson.research_record_id },
  );
  assert.equal(auditorReplay.status, 200);
  assert.equal(auditorReplay.json.match, true);
} finally {
  clearAuthorizedHospitalSource();
}
console.log("✓ Authorized silent capture freezes, hides the summary, and replays for an auditor");

console.log("\nALL BOUNDARY / EVIDENCE / SILENT-PATH CHECKS PASSED");
console.log("engineering_check: this file");
console.log("synthetic_validation: fixtures in this file only");
console.log("clinical_evidence: blocked");
