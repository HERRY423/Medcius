// Unit & Integration Tests for Discharge Readiness & Completeness Check Workflow
// Validates: Pending diagnostic closure, medication reconciliation (IV transition & DAPT),
// allergy & follow-up gaps, source-bound affordability context, red flags,
// and HospitalAgentAdapter discharge workflow execution.

import assert from "node:assert/strict";
import { DischargeReadinessEngine } from "../plugins/medcius/lib/discharge-readiness-engine.mjs";
import { HospitalAgentAdapter, HOST_TYPES } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import { getCardiologyMultiSourceFeeds } from "../plugins/medcius/servers/fhir/sandbox/hospital-cardiology-sandbox.mjs";

console.log("== Testing Inpatient Discharge Readiness & Completeness Check ==");

const wardFeeds = getCardiologyMultiSourceFeeds();
const bed1 = wardFeeds[0]; // Bed 01: ACS post-PCI with preliminary echocardiogram

// ----------------------------------------------------
// Test 1: Unready Patient Evaluation (Pending Report & Missing Discharge DAPT)
// ----------------------------------------------------
console.log("\n[Test 1] Testing unready patient check (pending echocardiogram)...");

const unreadyRes = DischargeReadinessEngine.evaluateDischargeReadiness({
  patient: bed1.patient,
  encounter: bed1.encounter,
  diagnosticReports: bed1.pacs, // has preliminary bedside echo
  inpatientMedications: bed1.his_orders.filter((o) => o.is_medication),
  dischargeMedications: [], // empty -> missing DAPT alert for cardiac patient!
  notes: bed1.notes,
  allergies: bed1.allergies,
});

assert.equal(unreadyRes.readiness_verdict.is_ready, false);
assert.ok(unreadyRes.readiness_verdict.status_label.includes("存在待闭环检查或安全缺口"));
assert.ok(unreadyRes.pending_diagnostic_reports.length > 0);
assert.ok(unreadyRes.medication_reconciliation_issues.some((m) => m.type === "ANTIPLATELET_DISCONTINUITY"));

console.log("✓ Detected pending diagnostic report and antiplatelet discontinuity");

// ----------------------------------------------------
// Test 2: Ready Patient Evaluation (Closed Reports, DAPT Present, Follow-up Scheduled)
// ----------------------------------------------------
console.log("\n[Test 2] Testing ready patient check with complete closure...");

const closedReports = [
  { id: "rep-001-final", name: "床旁超声心动图", status: "final", ordered_at: "2026-08-24", impression: "LVEF 55%，室壁运动基本协调" },
];

const completeDischargeMeds = [
  { drug_name: "阿司匹林肠溶片", dosage: "100mg po qd", route: "po" },
  { drug_name: "替格瑞洛片", dosage: "90mg po bid", route: "po" },
  { drug_name: "阿托伐他汀钙片", dosage: "20mg po qn", route: "po" },
];

const followUpNotes = [
  { id: "note-dis", title: "出院记录", timestamp: "2026-08-25", text: "出院医嘱：嘱患者低盐饮食，出院后2周门诊复诊复查生化全套与心电图。" },
];

const readyRes = DischargeReadinessEngine.evaluateDischargeReadiness({
  patient: bed1.patient,
  encounter: bed1.encounter,
  diagnosticReports: closedReports,
  inpatientMedications: bed1.his_orders.filter((o) => o.is_medication),
  dischargeMedications: completeDischargeMeds,
  notes: followUpNotes,
  allergies: ["青霉素"],
});

assert.equal(readyRes.readiness_verdict.is_ready, true);
assert.ok(readyRes.readiness_verdict.status_label.includes("出院资料齐备"));
assert.equal(readyRes.pending_diagnostic_reports.length, 0);
assert.equal(readyRes.medication_reconciliation_issues.length, 0);
assert.equal(readyRes.discharge_safety_gaps.length, 0);
assert.equal(readyRes.patient_affordability.assessment_status, "unknown");
assert.ok(readyRes.patient_affordability.data_gaps.some((gap) => gap.code === "AFFORDABILITY_SCREEN_NOT_AVAILABLE"));
assert.equal(readyRes.patient_affordability.boundary.affects_clinical_discharge_verdict, false);

console.log("✓ Ready patient successfully verified with zero safety gaps");

// ----------------------------------------------------
// Test 3: Discharge Checklist Report Formatting
// ----------------------------------------------------
console.log("\n[Test 3] Testing formatted Discharge Checklist text output...");

const checklistText = DischargeReadinessEngine.generateDischargeChecklistText({
  readinessResult: readyRes,
  attendingDoctor: "林德明 (主治医师)",
});

assert.ok(checklistText.includes("【出院资料完整性与安全准备度核对清单 (Discharge Checklist)】"));
assert.ok(checklistText.includes("一、关键检查检验闭环核查"));
assert.ok(checklistText.includes("二、出院带药与在院医嘱一致性核对"));
assert.ok(checklistText.includes("四、患者可负担性与医疗可获得性核对"));
assert.ok(checklistText.includes("不能推断“无经济障碍”"));
assert.ok(checklistText.includes("五、出院健康宣教与红旗预警体征"));
assert.ok(checklistText.includes("胸痛再次加重"));
assert.ok(checklistText.includes("林德明 (主治医师)"));

console.log("✓ Formatted discharge checklist generated");

// ----------------------------------------------------
// Test 4: Source-Bound Affordability Barrier Without Automated Clinical Decision
// ----------------------------------------------------
console.log("\n[Test 4] Testing source-bound affordability and access context...");

const financialAccessRecords = [
  {
    id: "aff-screen-001",
    kind: "affordability_screen",
    category: "medication",
    status: "barrier_reported",
    recorded_at: "2026-08-25T08:00:00Z",
    source_reference: { source_system: "hospital-questionnaire", resource_id: "QuestionnaireResponse/aff-screen-001" },
  },
  {
    id: "coverage-001",
    kind: "coverage_verification",
    category: "medication",
    status: "pending",
    recorded_at: "2026-08-25T08:05:00Z",
    source_reference: { source_system: "hospital-insurance-desk", resource_id: "CoverageEligibilityResponse/coverage-001" },
  },
  {
    id: "estimate-001",
    kind: "patient_cost_estimate",
    category: "follow_up",
    status: "available",
    amount: 120,
    currency: "CNY",
    valid_until: "2026-09-01T00:00:00Z",
    estimate_scope_code: "FOLLOW_UP_VISIT_ESTIMATE",
    recorded_at: "2026-08-25T08:10:00Z",
    source_reference: { source_system: "hospital-estimator", resource_id: "Estimate/estimate-001" },
  },
  {
    id: "unbound-claim",
    kind: "affordability_screen",
    category: "transportation",
    status: "no_barrier_reported",
    recorded_at: "2026-08-25T08:15:00Z",
  },
];

const affordabilityRes = DischargeReadinessEngine.evaluateDischargeReadiness({
  patient: bed1.patient,
  encounter: bed1.encounter,
  diagnosticReports: closedReports,
  inpatientMedications: bed1.his_orders.filter((o) => o.is_medication),
  dischargeMedications: completeDischargeMeds,
  notes: followUpNotes,
  allergies: ["青霉素"],
  financialAccessRecords,
});

assert.equal(affordabilityRes.readiness_verdict.is_ready, true, "financial barrier must not become an automated discharge decision");
assert.equal(affordabilityRes.patient_affordability.assessment_status, "action_needed");
assert.ok(affordabilityRes.patient_affordability.action_items.some((item) => item.code === "REFER_FOR_HUMAN_AFFORDABILITY_REVIEW"));
assert.ok(affordabilityRes.patient_affordability.action_items.some((item) => item.code === "VERIFY_COVERAGE_WITH_AUTHORIZED_SERVICE"));
assert.ok(affordabilityRes.patient_affordability.data_gaps.some((gap) => gap.record_id === "unbound-claim" && gap.reason === "SOURCE_REFERENCE_REQUIRED"));
const estimateFact = affordabilityRes.patient_affordability.verified_facts.find((fact) => fact.id === "estimate-001");
assert.equal(estimateFact.amount, 120);
assert.equal(estimateFact.currency, "CNY");
assert.ok(estimateFact.disclaimer.includes("not a bill"));
const affordabilityChecklist = DischargeReadinessEngine.generateDischargeChecklistText({
  readinessResult: affordabilityRes,
  attendingDoctor: "林德明",
});
assert.ok(affordabilityChecklist.includes("120 CNY"));
assert.ok(affordabilityChecklist.includes("非账单或待遇裁定"));

console.log("✓ Affordability barriers remain source-bound and route to human review without altering the clinical verdict");

// ----------------------------------------------------
// Test 5: HospitalAgentAdapter Integration for Discharge
// ----------------------------------------------------
console.log("\n[Test 5] Testing HospitalAgentAdapter.executeDischargeReadinessWorkflow...");

const adapterRes = HospitalAgentAdapter.executeDischargeReadinessWorkflow({
  host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
  context: {
    tenant_id: "hospital_pku_cardio",
    doctor_id: "DOC-PKU-8801",
    doctor_name: "林德明",
    patient_id: "pat-cardio-001",
    encounter_id: "enc-cardio-001",
  },
  dataFeeds: { ...bed1, financial_access: financialAccessRecords },
  dischargeMedications: completeDischargeMeds,
});

assert.equal(adapterRes.success, true);
assert.equal(adapterRes.host_info.workflow, "discharge-readiness-check");
assert.ok(adapterRes.provenance.envelope_sha256);
assert.equal(adapterRes.security_contract.fail_closed_verified, true);
assert.equal(adapterRes.readiness.patient_affordability.assessment_status, "action_needed");
assert.ok(adapterRes.checklist_text.includes("【出院资料完整性与安全准备度核对清单 (Discharge Checklist)】"));

console.log("✓ HospitalAgentAdapter discharge readiness execution passed");

console.log("\nALL DISCHARGE READINESS CHECK TESTS PASSED!");
