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

console.log("\nALL HOSPITAL AGENT ADAPTER TESTS PASSED!");
