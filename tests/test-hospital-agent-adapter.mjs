// Unit & Integration Tests for HospitalAgentAdapter (Host-Agnostic Core Bridge)
// Tests: Fail-closed enforcement, multi-source feed fusion, PHI guard verification,
// provenance envelope calculation, and doctor-confirmed draft generation.

import assert from "node:assert/strict";
import { HospitalAgentAdapter, HOST_TYPES } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import { getCardiologyMultiSourceFeeds } from "../plugins/medcius/servers/fhir/sandbox/hospital-cardiology-sandbox.mjs";

console.log("== Testing Host-Agnostic HospitalAgentAdapter ==");

// ----------------------------------------------------
// Test 1: Fail-Closed Context Validation
// ----------------------------------------------------
console.log("\n[Test 1] Testing fail-closed security checks on invalid / missing context...");

// 1a. Missing envelope
assert.throws(
  () => HospitalAgentAdapter.validateContextEnvelope(null),
  /FAIL_CLOSED: Missing context envelope payload/,
  "Must fail closed when context envelope is null"
);

// 1b. Missing tenant_id
assert.throws(
  () => HospitalAgentAdapter.validateContextEnvelope({ doctor_id: "DOC-01", patient_id: "pat-01" }),
  /FAIL_CLOSED: Missing or invalid tenant_id/,
  "Must fail closed when tenant_id is missing"
);

// 1c. Missing doctor_id
assert.throws(
  () => HospitalAgentAdapter.validateContextEnvelope({ tenant_id: "hosp_a", patient_id: "pat-01" }),
  /FAIL_CLOSED: Missing or invalid doctor_id/,
  "Must fail closed when doctor_id is missing"
);

// 1d. Missing patient_id
assert.throws(
  () => HospitalAgentAdapter.validateContextEnvelope({ tenant_id: "hosp_a", doctor_id: "DOC-01", encounter_id: "enc-01" }),
  /FAIL_CLOSED: Missing or invalid patient_id/,
  "Must fail closed when patient_id is missing"
);

// 1e. Missing encounter_id
assert.throws(
  () => HospitalAgentAdapter.validateContextEnvelope({ tenant_id: "hosp_a", doctor_id: "DOC-01", patient_id: "pat-01" }),
  /FAIL_CLOSED: Missing or invalid encounter_id/,
  "Must fail closed when encounter_id is missing"
);

// 1f. Patient mismatch
const sampleFeeds = getCardiologyMultiSourceFeeds();
assert.throws(
  () => HospitalAgentAdapter.executePreRoundWorkflow({
    host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
    context: { tenant_id: "hosp_a", doctor_id: "DOC-01", patient_id: "pat-wrong-id", encounter_id: "enc-01" },
    dataFeeds: sampleFeeds[0],
  }),
  /FAIL_CLOSED: Patient record mismatch/,
  "Must fail closed when patient_id mismatches active ward record"
);

// 1g. PHI leakage blocks execution
const feedWithRawPhi = {
  ...sampleFeeds[0],
  notes: [{ id: "n-phi", title: "入院记录", timestamp: "2026-08-25", text: "患者李建国，身份证 110101199003072345，电话 13800138000" }],
};
assert.throws(
  () => HospitalAgentAdapter.executePreRoundWorkflow({
    host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
    context: { tenant_id: "hosp_a", doctor_id: "DOC-01", patient_id: "pat-cardio-001", encounter_id: "enc-01" },
    dataFeeds: feedWithRawPhi,
  }),
  /FAIL_CLOSED_PHI_VIOLATION/,
  "Must fail closed and block output when raw unredacted PHI is detected"
);

console.log("✓ All fail-closed security and PHI blocking assertions passed");

// ----------------------------------------------------
// Test 2: Multi-Source Pre-Round Workflow Execution for Hospital Agent
// ----------------------------------------------------
console.log("\n[Test 2] Testing multi-source workflow execution for custom Hospital Agent (Dify / LangChain)...");

const bed1Feed = sampleFeeds[0];
const resBed1 = HospitalAgentAdapter.executePreRoundWorkflow({
  host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
  context: {
    tenant_id: "hospital_pku_cardio",
    doctor_id: "DOC-PKU-8801",
    doctor_name: "林德明 (主任医师)",
    patient_id: "pat-cardio-001",
    encounter_id: "enc-cardio-001",
    time_window: "24h",
    specialty_rule_pack_id: "cardiology-inpatient-sandbox",
  },
  dataFeeds: bed1Feed,
});

assert.equal(resBed1.success, true);
assert.equal(resBed1.host_info.host_type, HOST_TYPES.HOSPITAL_CUSTOM_AGENT);
assert.equal(resBed1.security_contract.fail_closed_verified, true);
assert.equal(resBed1.security_contract.phi_leakage_detected, false);
assert.equal(resBed1.security_contract.read_only_enforced, true);

// Verify multi-source additions
const whatChanged = resBed1.summary.blocks.what_changed;
assert.ok(whatChanged.nursing_vitals_summary);
assert.ok(whatChanged.fluid_balance_24h);
assert.ok(whatChanged.critical_values?.length > 0);
assert.ok(whatChanged.imaging_impressions?.length > 0);

// Verify provenance envelope
assert.ok(resBed1.provenance.envelope_sha256);
assert.equal(resBed1.provenance.envelope_sha256.length, 64);
assert.ok(resBed1.provenance.evidence_count >= 5);

console.log(`✓ Hospital Agent execution succeeded (Total items: ${resBed1.summary.total_items_count}, SHA-256: ${resBed1.provenance.envelope_sha256.slice(0, 12)}...)`);

// ----------------------------------------------------
// Test 3: Antibiotic Duration Tracking on Bed 3
// ----------------------------------------------------
console.log("\n[Test 3] Testing restricted/special antibiotic duration tracking on Bed 3...");

const bed3Feed = sampleFeeds[2];
const resBed3 = HospitalAgentAdapter.executePreRoundWorkflow({
  host: HOST_TYPES.CDS_HOOKS_ADAPTER,
  context: {
    tenant_id: "hospital_pku_cardio",
    doctor_id: "DOC-PKU-8801",
    doctor_name: "林德明 (主任医师)",
    patient_id: "pat-cardio-003",
    encounter_id: "enc-cardio-003",
    time_window: "24h",
    specialty_rule_pack_id: "cardiology-inpatient-sandbox",
  },
  dataFeeds: bed3Feed,
});

const alerts = resBed3.summary.blocks.what_changed.antibiotic_duration_alerts;
assert.ok(alerts?.length > 0);
assert.equal(alerts[0].drug_name, "注射用美罗培南");
assert.equal(alerts[0].level, "特殊使用级");
assert.equal(alerts[0].is_overdue, true);
console.log(`✓ Detected restricted antibiotic alert: ${alerts[0].alert_message.slice(0, 45)}...`);

// ----------------------------------------------------
// Test 4: Doctor-Confirmed Draft Generation
// ----------------------------------------------------
console.log("\n[Test 4] Testing doctor-confirmed progress note draft generation via adapter...");

const selectedItemIds = [
  resBed1.summary.blocks.what_changed.clinical_symptoms[0]?.id,
  resBed1.summary.blocks.what_changed.abnormal_labs[0]?.id,
].filter(Boolean);

const draftRes = HospitalAgentAdapter.generateProgressNoteDraft({
  context: {
    tenant_id: "hospital_pku_cardio",
    doctor_id: "DOC-PKU-8801",
    doctor_name: "林德明 (主任医师)",
    patient_id: "pat-cardio-001",
    encounter_id: "enc-cardio-001",
  },
  summaryData: resBed1.summary,
  selectedItemIds,
  customNotes: "患者今日精神状态佳，继续密切观察心肌酶谱与肌酐走势。",
});

assert.equal(draftRes.success, true);
assert.ok(draftRes.draft.draft_text.includes("【日常查房记录 - 病情演变摘要】"));
assert.ok(draftRes.draft.draft_text.includes("林德明 (主任医师)"));
assert.ok(draftRes.draft.draft_text.includes("继续密切观察心肌酶谱"));
assert.equal(draftRes.audit.doctor_id, "DOC-PKU-8801");

console.log("✓ Progress note draft generated with doctor sign-off metadata");

// ----------------------------------------------------
// Test 5: Intent Routing & Catalog Approval Gate (4.1)
// ----------------------------------------------------
console.log("\n[Test 5] Testing Intent Routing & Catalog Approval Gate...");

import { ClinicalSkillCatalog } from "../plugins/medcius/lib/clinical-skill-catalog.mjs";

const sampleCatalog = new ClinicalSkillCatalog({
  catalog_id: "inpatient-catalog-v1",
  version: "1.0.0",
  skills: [
    {
      skill_id: "patient-evolution-summary",
      status: "approved",
      approval_metadata: { approved_by: "林主任医师 (Cardio)" },
    },
    {
      skill_id: "shift-handover",
      status: "approved",
      approval_metadata: { approved_by: "林主任医师 (Cardio)" },
    },
    {
      skill_id: "unapproved-improvised-diagnostics",
      status: "draft",
    },
    {
      skill_id: "quarantined-experimental-skill",
      status: "quarantined",
    },
  ],
});

// 5a. Route approved skill succeeds with progressive views
const routedPreRound = HospitalAgentAdapter.routeAndExecuteWorkflow({
  skillId: "patient-evolution-summary",
  catalog: sampleCatalog,
  mode: "production",
  context: {
    tenant_id: "hospital_pku_cardio",
    doctor_id: "DOC-PKU-8801",
    patient_id: "pat-cardio-001",
    encounter_id: "enc-cardio-001",
  },
  dataFeeds: bed1Feed,
});
assert.equal(routedPreRound.success, true);
assert.ok(routedPreRound.progressive_views);
assert.ok(routedPreRound.progressive_views.glance);
assert.ok(routedPreRound.progressive_views.digest);
assert.ok(routedPreRound.progressive_views.drilldown);
console.log("✓ Intent routed to 'patient-evolution-summary' with 3-tier progressive views generated");

// 5b. Unapproved skill blocked in production
assert.throws(
  () => HospitalAgentAdapter.routeAndExecuteWorkflow({
    skillId: "unapproved-improvised-diagnostics",
    catalog: sampleCatalog,
    mode: "production",
    context: { tenant_id: "hosp_a", doctor_id: "doc_1", patient_id: "pat-cardio-001", encounter_id: "enc-01" },
    dataFeeds: bed1Feed,
  }),
  /FAIL_CLOSED_SKILL_UNAPPROVED/,
  "Must reject unapproved draft skill in production"
);

// 5c. Quarantined skill blocked
assert.throws(
  () => HospitalAgentAdapter.routeAndExecuteWorkflow({
    skillId: "quarantined-experimental-skill",
    catalog: sampleCatalog,
    mode: "production",
    context: { tenant_id: "hosp_a", doctor_id: "doc_1", patient_id: "pat-cardio-001", encounter_id: "enc-01" },
    dataFeeds: bed1Feed,
  }),
  /FAIL_CLOSED_SKILL_UNAPPROVED/,
  "Must reject quarantined skill"
);

// 5d. Improvised unregistered workflow outside catalog blocked
assert.throws(
  () => HospitalAgentAdapter.routeAndExecuteWorkflow({
    skillId: "improvised-multiagent-differential-diagnostician",
    catalog: sampleCatalog,
    mode: "production",
    context: { tenant_id: "hosp_a", doctor_id: "doc_1", patient_id: "pat-cardio-001", encounter_id: "enc-01" },
    dataFeeds: bed1Feed,
  }),
  /FAIL_CLOSED_SKILL_UNAPPROVED/,
  "Must reject unregistered improvised workflow"
);

console.log("✓ All catalog approval and intent routing gates strictly enforced in production mode");

// ----------------------------------------------------
// Test 6: 3-Tier Progressive Views (4.6 L1 / L2 / L3)
// ----------------------------------------------------
console.log("\n[Test 6] Testing 3-tier progressive disclosure (~3s L1 / ~15s L2 / Bedside L3)...");

const views = routedPreRound.progressive_views;
// L1 Glance
assert.ok(views.glance.time_budget.includes("3s"));
assert.ok(["STABLE", "CHANGED", "CRITICAL"].includes(views.glance.status));
assert.ok(views.glance.recommended_workflow_action);
assert.ok(views.glance.disclaimer.includes("不构成医疗医嘱"));

// L2 Digest
assert.ok(views.digest.time_budget.includes("15s"));
assert.ok(views.digest.blocks.what_changed);
assert.ok(views.digest.blocks.whats_pending);
assert.ok(views.digest.blocks.clinical_data_gaps);

// L3 Drilldown
assert.ok(views.drilldown.full_evidence_spans.length >= 5);
assert.ok(views.drilldown.verbatim_spans_available >= 1);

console.log(`✓ 3-tier progressive views validated: L1 (${views.glance.status}), L2 (4 blocks), L3 (${views.drilldown.total_evidence_count} evidence items)`);

// ----------------------------------------------------
// Test 7: Staged Draft Service Human-in-the-Loop & Write-Back Blocking (4.7)
// ----------------------------------------------------
console.log("\n[Test 7] Testing StagedDraftService sandbox creation & write-back block...");

import { StagedDraftService } from "../plugins/medcius/lib/staged-draft-service.mjs";

const stagedDraft = StagedDraftService.createStagedDraft({
  patient: bed1Feed.patient,
  encounterId: "enc-cardio-001",
  author: "林德明 (主任医师)",
  progressiveViews: views,
});

assert.ok(stagedDraft.draft_id.startsWith("DRAFT-"));
assert.equal(stagedDraft.status, "PENDING_PHYSICIAN_CA_SIGNATURE");
assert.equal(stagedDraft.human_verification_required, true);
assert.equal(stagedDraft.write_back_blocked, true, "Must strictly block automated writeback");
assert.ok(stagedDraft.rendered_markdown.includes("【查房前病情演变与交班记录草稿】"));
assert.ok(stagedDraft.rendered_markdown.includes("加盖 CA 电子签名入库"));

console.log("✓ Staged draft sandbox generated with write_back_blocked=true and pending CA signature");

console.log("\nALL HOSPITAL AGENT ADAPTER TESTS PASSED!\n");

