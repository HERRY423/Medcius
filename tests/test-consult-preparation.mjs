// Unit & Integration Tests for Consultation Preparation Workflow
// Validates: Targeted lab & diagnostic timeline, specialty notes excerpt, pending reports,
// active regimen synthesis, and HospitalAgentAdapter consult workflow execution.

import assert from "node:assert/strict";
import { ConsultPreparationEngine } from "../plugins/medcius/lib/consult-preparation-engine.mjs";
import { HospitalAgentAdapter, HOST_TYPES } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import { getCardiologyMultiSourceFeeds } from "../plugins/medcius/servers/fhir/sandbox/hospital-cardiology-sandbox.mjs";

console.log("== Testing Specialist Consultation Preparation ==");

const wardFeeds = getCardiologyMultiSourceFeeds();
const bed2 = wardFeeds[1]; // Bed 02: Heart failure with renal consult request

// ----------------------------------------------------
// Test 1: Consult Dossier Generation for Bed 02 (Nephrology Consult)
// ----------------------------------------------------
console.log("\n[Test 1] Testing Nephrology consult dossier generation on Bed 02...");

const consultRequest = {
  department: "肾内科",
  purpose: "评估顽固性心衰利尿剂抵抗及低钾电解质紊乱方案",
  urgency: "急会诊 (2h内完成)",
  requested_at: new Date().toISOString(),
};

const dossier = ConsultPreparationEngine.prepareConsultDossier({
  patient: bed2.patient,
  encounter: bed2.encounter,
  consultRequest,
  notes: bed2.notes,
  observations: bed2.lis,
  diagnosticReports: bed2.pacs,
  medications: bed2.his_orders.filter((o) => o.is_medication),
  allergies: bed2.allergies,
});

assert.equal(dossier.success, true);
assert.equal(dossier.header.target_department, "肾内科");
assert.equal(dossier.header.bed_number, "02床");
assert.ok(dossier.header.purpose.includes("利尿剂抵抗"));

// Check targeted specialty labs (NT-proBNP, K+)
assert.ok(dossier.targeted_labs_timeline.length >= 2, "Must include NT-proBNP and Potassium labs");
assert.ok(dossier.targeted_labs_timeline.some((l) => l.test_name.includes("BNP") || l.test_name.includes("K+")));

// Check active medications (呋塞米, 氯化钾)
assert.ok(dossier.active_medications.some((m) => m.drug_name.includes("呋塞米")));
assert.ok(dossier.active_medications.some((m) => m.drug_name.includes("氯化钾")));

// Check data gap (Bed 02 allergy missing)
assert.ok(dossier.data_gaps.length > 0);
assert.ok(dossier.data_gaps[0].includes("ALLERGY_MISSING"));

console.log("✓ Nephrology consult dossier generated with targeted labs and active medications");

// ----------------------------------------------------
// Test 2: Consult Dossier Brief Formatting
// ----------------------------------------------------
console.log("\n[Test 2] Testing formatted consult brief report text...");

const briefText = ConsultPreparationEngine.generateConsultBriefText({
  consultDossier: dossier,
  requestingDoctor: "心内科二病区住院总",
});

assert.ok(briefText.includes("【肾内科会诊前资料摘要包】"));
assert.ok(briefText.includes("一、会诊目的与拟解决核心问题"));
assert.ok(briefText.includes("二、本专科重点病程演变与病历摘录"));
assert.ok(briefText.includes("三、针对性专科检验指标时间轴"));
assert.ok(briefText.includes("六、当前主要用药方案"));
assert.ok(briefText.includes("呋塞米"));
assert.ok(briefText.includes("心内科二病区住院总"));

console.log("✓ Formatted consult brief report generated");

// ----------------------------------------------------
// Test 3: HospitalAgentAdapter Consult Workflow Execution
// ----------------------------------------------------
console.log("\n[Test 3] Testing HospitalAgentAdapter.executeConsultPrepWorkflow...");

const adapterRes = HospitalAgentAdapter.executeConsultPrepWorkflow({
  host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
  context: {
    tenant_id: "hospital_pku_cardio",
    doctor_id: "DOC-PKU-8801",
    doctor_name: "林德明 (主治医师)",
    patient_id: "pat-cardio-002",
    encounter_id: "enc-cardio-002",
  },
  dataFeeds: bed2,
  consultRequest,
});

assert.equal(adapterRes.success, true);
assert.equal(adapterRes.host_info.workflow, "consult-preparation");
assert.ok(adapterRes.provenance.envelope_sha256);
assert.equal(adapterRes.security_contract.fail_closed_verified, true);
assert.ok(adapterRes.brief_text.includes("【肾内科会诊前资料摘要包】"));

console.log("✓ HospitalAgentAdapter consult workflow execution passed");

// ----------------------------------------------------
// Test 4: Fail-Closed on Missing Target Department
// ----------------------------------------------------
console.log("\n[Test 4] Testing fail-closed on missing consult department...");

assert.throws(
  () => HospitalAgentAdapter.executeConsultPrepWorkflow({
    host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
    context: { tenant_id: "hosp_a", doctor_id: "DOC-01", patient_id: "pat-cardio-002", encounter_id: "enc-cardio-002" },
    dataFeeds: bed2,
    consultRequest: {}, // Missing department
  }),
  /FAIL_CLOSED: Missing target department/,
  "Must fail closed when consultRequest.department is missing"
);

console.log("✓ Fail-closed verified on missing consult department");

console.log("\nALL CONSULTATION PREPARATION TESTS PASSED!");
