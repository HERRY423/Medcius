import assert from "node:assert/strict";
import { HospitalAgentAdapter, HOST_TYPES } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import {
  CLINICAL_LANDING_SKILL,
  FROZEN_WORKFLOW_SKILLS,
  TIME_MOTION_MIN_SAVED_SECONDS,
  assertClinicalHostAllowed,
  assertSkillInvocable,
  classifyEvidenceReport,
} from "../plugins/medcius/lib/clinical-landing-policy.mjs";
import { assertSiteActivated, assertLiveHospitalDataAllowed } from "../plugins/medcius/lib/site-activation-gate.mjs";
import { executeHisEmbedPreRound, parseHisPatientContext } from "../plugins/medcius/lib/his-embed-adapter.mjs";
import { GovernanceStateManager } from "../plugins/medcius/lib/governance-mode.mjs";
import { ClinicalSkillCatalog } from "../plugins/medcius/lib/clinical-skill-catalog.mjs";
import { evaluateStopwatchProtocol } from "../plugins/medcius/evals/time-motion/stopwatch-protocol.mjs";
import { getCardiologyMultiSourceFeeds } from "../plugins/medcius/servers/fhir/sandbox/hospital-cardiology-sandbox.mjs";
import { startServer } from "../plugins/medcius/servers/api/src/server.mjs";
import { generateToken, ROLES } from "../plugins/medcius/servers/api/src/auth-middleware.mjs";

console.log("== Testing P0 clinical landing contract ==");

const feeds = getCardiologyMultiSourceFeeds()[0];
const engineeringContext = {
  tenant_id: "hospital_pku_cardio",
  doctor_id: "DOC-PKU-8801",
  patient_id: feeds.patient.id,
  encounter_id: "enc-cardio-001",
};

console.log("\n[P0-1] Engineering hosts cannot serve frontline landing...");
assert.doesNotThrow(() => HospitalAgentAdapter.executePreRoundWorkflow({
  host: HOST_TYPES.CODEX,
  context: engineeringContext,
  dataFeeds: feeds,
}));
assert.throws(
  () => HospitalAgentAdapter.executePreRoundWorkflow({
    host: HOST_TYPES.CODEX,
    context: { ...engineeringContext, clinical_landing: true },
    dataFeeds: feeds,
  }),
  /P0_CLINICAL_HOST_REQUIRED/,
);
assert.throws(
  () => HospitalAgentAdapter.executePreRoundWorkflow({
    host: HOST_TYPES.TRAE,
    context: { ...engineeringContext, clinical_landing: true },
    dataFeeds: feeds,
  }),
  /P0_CLINICAL_HOST_REQUIRED/,
);
assert.throws(
  () => HospitalAgentAdapter.executePreRoundWorkflow({
    host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
    context: { ...engineeringContext, clinical_landing: true },
    dataFeeds: feeds,
  }),
  /P0_CLINICAL_HOST_REQUIRED/,
);
process.env.MEDCIUS_CLINICAL_LANDING = "1";
try {
  assert.throws(
    () => HospitalAgentAdapter.executePreRoundWorkflow({
      host: HOST_TYPES.CODEX,
      context: engineeringContext,
      dataFeeds: feeds,
    }),
    /P0_CLINICAL_HOST_REQUIRED/,
  );
} finally {
  delete process.env.MEDCIUS_CLINICAL_LANDING;
}
assert.doesNotThrow(() => assertClinicalHostAllowed(HOST_TYPES.HIS_EMBED, { clinicalLanding: true }));
console.log("✓ Codex/Trae/custom-agent blocked; HIS embed is the only clinical host");

console.log("\n[P0-2] Frozen workflows stay callable in engineering tests, blocked on clinical landing...");
assert.doesNotThrow(() => assertSkillInvocable({ skillId: "shift-handover", host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT }));
for (const skillId of FROZEN_WORKFLOW_SKILLS) {
  assert.throws(
    () => assertSkillInvocable({ skillId, host: HOST_TYPES.HIS_EMBED, clinicalLanding: true }),
    /P0_SKILL_FROZEN/,
  );
}
assert.throws(
  () => HospitalAgentAdapter.executeShiftHandoverWorkflow({
    host: HOST_TYPES.HIS_EMBED,
    context: { ...engineeringContext, clinical_landing: true },
    dataFeeds: feeds,
  }),
  /P0_SKILL_FROZEN/,
);
assert.equal(assertSkillInvocable({ skillId: CLINICAL_LANDING_SKILL, host: HOST_TYPES.HIS_EMBED }).ok, true);

const catalog = new ClinicalSkillCatalog("plugins/medcius/rule-packs/catalogs/hospital-inpatient-skill-catalog.json");
assert.equal(catalog.isSkillApproved("patient-evolution-summary", "production").isEligible, true);
assert.equal(catalog.isSkillApproved("shift-handover", "production").isEligible, false);
assert.equal(catalog.getSkill("consult-preparation").status, "frozen");
console.log("✓ Only patient-evolution-summary remains clinically invocable");

console.log("\n[P0-4] HIS embed silent-pilot: no cards, no draft, no writeback...");
const silent = await executeHisEmbedPreRound({
  host: HOST_TYPES.HIS_EMBED,
  context: { ...engineeringContext, clinical_landing: true },
  dataFeeds: feeds,
  governance: new GovernanceStateManager("silent_pilot"),
});
assert.equal(silent.silent, true);
assert.deepEqual(silent.cards, []);
assert.equal(silent.draft, null);
assert.equal(silent.summary, null);
assert.equal(silent.shadow.clinician_display, "suppressed_silent_pilot");
assert.equal(silent.security_contract.writeback, false);

assert.throws(
  () => HospitalAgentAdapter.generateProgressNoteDraft({
    context: { ...engineeringContext, clinical_landing: true, host: HOST_TYPES.HIS_EMBED },
    summaryData: { selectable_items: [] },
    selectedItemIds: [],
  }),
  /P0_DRAFT_SUPPRESSED_SILENT_PILOT/,
);

const gov = new GovernanceStateManager("silent_pilot");
assert.throws(() => gov.assertLiveAlertsAllowed(), (err) => err.code === "GOVERNANCE_STAGE_LIVE_ALERTS_BLOCKED");
assert.throws(() => gov.assertWritebackAllowed(), (err) => err.code === "GOVERNANCE_STAGE_WRITEBACK_BLOCKED");
process.env.MEDCIUS_CLINICAL_LANDING = "1";
try {
  assert.throws(
    () => gov.advanceStage({
      targetStageId: "advisory_mode",
      actor: "test",
      reason: "clinical landing cannot leave silent pilot",
      evidence: {
        silent_pilot_shadow_study_passed: true,
        primary_endpoints_met: true,
        pharmacist_training_completed: true,
      },
    }),
    /P0_GOVERNANCE_CAP/,
  );
} finally {
  delete process.env.MEDCIUS_CLINICAL_LANDING;
}
console.log("✓ Silent-pilot suppresses clinician display and writeback");

console.log("\n[P0-5] Site activation requires IRB, agreement hash, and read-only account...");
const validSite = {
  hospital_id: "HOSP-001",
  tenant_id: "tenant-001",
  ward_id: "cardio-2",
  irb_protocol_id: "IRB-2026-001",
  data_agreement_sha256: "a".repeat(64),
  clinical_surface: "his_embed",
  governance_stage: "silent_pilot",
  readonly_account: { username: "medcius_readonly", capabilities: ["read"], system: "view_library" },
};
assert.equal(assertSiteActivated(validSite).ok, true);
assert.throws(() => assertSiteActivated({ ...validSite, irb_protocol_id: "" }), /SITE_ACTIVATION_IRB_PROTOCOL_ID_REQUIRED/);
assert.throws(
  () => assertSiteActivated({ ...validSite, readonly_account: { username: "rw", capabilities: ["read", "write"] } }),
  /SITE_ACTIVATION_WRITE_ACCOUNT_REJECTED/,
);
assert.throws(
  () => assertSiteActivated({ ...validSite, clinical_surface: "codex" }),
  /SITE_ACTIVATION_CLINICAL_SURFACE_INVALID/,
);
assert.equal(assertLiveHospitalDataAllowed({}).live, false);

const demoEvidence = classifyEvidenceReport({ dataClass: "synthetic" });
assert.equal(demoEvidence.clinical_evidence_pass, false);
console.log("✓ Live-data gate and DEMO-is-not-evidence classification hold");

console.log("\n[P0-6] Stopwatch protocol refuses to launder synthetic 79% as clinical evidence...");
const syntheticPacket = evaluateStopwatchProtocol({
  data_class: "synthetic",
  irb_protocol_id: "IRB-IGNORE",
  records: [
    { observer_id: "OBS-1", control_seconds: 510, intervention_seconds: 108, control_omissions: 1, intervention_omissions: 0 },
  ],
});
assert.equal(syntheticPacket.mean_saved_seconds >= TIME_MOTION_MIN_SAVED_SECONDS, true);
assert.equal(syntheticPacket.evidence.clinical_evidence_pass, false);
assert.ok(String(syntheticPacket.evidence.blocked_reason).includes("CLINICAL_EVIDENCE_BLOCKED"));

const incompleteStopwatch = evaluateStopwatchProtocol({
  data_class: "stopwatch_observation",
  records: [],
});
assert.equal(incompleteStopwatch.evidence.clinical_evidence_pass, false);
console.log("✓ Pre-registered 90s endpoint exists; synthetic packets stay BLOCKED");

console.log("\n[P0-1/4] HIS embed HTTP surface...");
const token = generateToken({
  sub: "DOC-TEST-001",
  name: "测试医师",
  roles: [ROLES.PHYSICIAN],
  tenant_id: "hospital_pku_cardio",
});
const { server, port, host } = await startServer(0, "127.0.0.1");
try {
  const embedRes = await fetch(`http://${host}:${port}/his/embed`);
  assert.equal(embedRes.status, 200);
  const embedHtml = await embedRes.text();
  assert.ok(embedHtml.includes("不对临床医生弹窗"));
  assert.ok((embedRes.headers.get("content-security-policy") || "").includes("frame-ancestors"));

  const captureRes = await fetch(`http://${host}:${port}/api/v1/his/embed/silent-capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Tenant-ID": "hospital_pku_cardio" },
    body: JSON.stringify({
      type: "his:patient-context",
      context: engineeringContext,
      dataFeeds: feeds,
    }),
  });
  assert.equal(captureRes.status, 200);
  const captureJson = await captureRes.json();
  assert.equal(captureJson.silent, true);
  assert.deepEqual(captureJson.cards, []);
  console.log("✓ /his/embed iframe and silent-capture API returned no clinician cards");

  process.env.MEDCIUS_CLINICAL_LANDING = "1";
  try {
    const sidebarBlocked = await fetch(`http://${host}:${port}/sidebar`);
    assert.equal(sidebarBlocked.status, 403);
    const summaryBlocked = await fetch(`http://${host}:${port}/api/v1/patient/evolution-summary`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Tenant-ID": "hospital_pku_cardio",
      },
      body: JSON.stringify({ patient_id: "p1", encounter_id: "e1" }),
    });
    assert.equal(summaryBlocked.status, 403);
    console.log("✓ Clinical landing suppresses doctor-facing sidebar and evolution-summary");
  } finally {
    delete process.env.MEDCIUS_CLINICAL_LANDING;
  }
} finally {
  server.close();
}

parseHisPatientContext({
  tenant_id: "t1",
  doctor_id: "d1",
  patient_id: "p1",
  encounter_id: "e1",
});
assert.throws(() => parseHisPatientContext({ tenant_id: "t1" }), /HIS_EMBED_CONTEXT_FAIL_CLOSED/);

console.log("\nALL P0 CLINICAL LANDING TESTS PASSED!");
