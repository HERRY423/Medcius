// Unit & Integration Tests for Shift Handover Workflow (SBAR Model)
// Validates: Situation, Background, Assessment, Recommendation blocks, drain alerts,
// critical value detection, and HospitalAgentAdapter handover execution.

import assert from "node:assert/strict";
import { ShiftHandoverEngine, SHIFT_TYPES } from "../plugins/medcius/lib/shift-handover-engine.mjs";
import { HospitalAgentAdapter, HOST_TYPES } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import { getCardiologyMultiSourceFeeds } from "../plugins/medcius/servers/fhir/sandbox/hospital-cardiology-sandbox.mjs";

console.log("== Testing Clinical Shift Handover (SBAR Model) ==");

const wardFeeds = getCardiologyMultiSourceFeeds();
const bed1 = wardFeeds[0]; // Bed 01: ACS post-PCI with drain & cTnI critical
const bed2 = wardFeeds[1]; // Bed 02: Acute HF with fluid overload & pending consult

// ----------------------------------------------------
// Test 1: SBAR Extraction for Post-PCI Patient (Bed 01)
// ----------------------------------------------------
console.log("\n[Test 1] Testing SBAR extraction for post-PCI Bed 01...");

const nis1 = {
  vitals_summary: { t_max: 36.8, spo2_min: "97%", bp_max: "135/85 mmHg" },
  fluid_balance: {
    status: "基本平衡",
    drain_details: [{ name: "心包穿刺引流", amount_ml: 50, description: "淡黄色清亮液体" }],
  },
};

const handover1 = ShiftHandoverEngine.analyzePatientHandover({
  patient: bed1.patient,
  encounter: bed1.encounter,
  notes: bed1.notes,
  vitals: nis1,
  observations: bed1.lis,
  medications: bed1.his_orders.filter((o) => o.is_medication),
  orders: bed1.his_orders.filter((o) => !o.is_medication),
  allergies: bed1.allergies,
  shiftType: SHIFT_TYPES.MORNING_TO_EVENING,
});

const sbar1 = handover1.sbar;

// Check Situation
assert.equal(sbar1.situation.bed_number, "01床");
assert.ok(sbar1.situation.primary_diagnosis.includes("心肌梗死") || sbar1.situation.primary_diagnosis.includes("PCI"));
assert.equal(sbar1.situation.care_level, "特级护理");

// Check Background
assert.ok(sbar1.background.allergy_summary.includes("青霉素"));
assert.equal(sbar1.background.has_allergy_gap, false);

// Check Assessment
assert.ok(sbar1.assessment.critical_values.length > 0, "Must identify critical cTnI / K+");
assert.ok(sbar1.assessment.drain_alerts.some((d) => d.includes("心包穿刺引流")));

// Check Recommendation & Contingency Plans
assert.ok(sbar1.recommendation.contingency_plans.some((cp) => cp.includes("胸痛应急")));

console.log("✓ Bed 01 SBAR accurately constructed with drain & critical value monitoring");

// ----------------------------------------------------
// Test 2: SBAR Extraction for Heart Failure Patient with Allergy Gap (Bed 02)
// ----------------------------------------------------
console.log("\n[Test 2] Testing Bed 02 with fluid overload, allergy gap & pending consult...");

const nis2 = {
  vitals_summary: { t_max: 37.2, spo2_min: "95%" },
  fluid_balance: {
    status: "显著正平衡 (需警惕容量负荷过重)",
    net_balance_ml: 1200,
    drain_details: [],
  },
};

const handover2 = ShiftHandoverEngine.analyzePatientHandover({
  patient: bed2.patient,
  encounter: bed2.encounter,
  notes: bed2.notes,
  vitals: nis2,
  observations: bed2.lis,
  medications: bed2.his_orders.filter((o) => o.is_medication),
  orders: bed2.his_orders.filter((o) => !o.is_medication),
  allergies: bed2.allergies,
  shiftType: SHIFT_TYPES.MORNING_TO_EVENING,
});

const sbar2 = handover2.sbar;
assert.equal(sbar2.background.has_allergy_gap, true, "Must flag allergy gap on Bed 02");
assert.ok(sbar2.recommendation.contingency_plans.some((cp) => cp.includes("心衰容量负荷")));

console.log("✓ Bed 02 accurately flagged allergy gap and heart failure contingency");

// ----------------------------------------------------
// Test 3: Structured Handover Text Formatting
// ----------------------------------------------------
console.log("\n[Test 3] Testing formatted SBAR handover text generation...");

const handoffText = ShiftHandoverEngine.generateHandoverText({
  handoverData: handover1,
  outgoingDoctor: "林德明 (住院总)",
  incomingDoctor: "张主治 (夜班)",
});

assert.ok(handoffText.includes("【临床交接班记录 (SBAR 模型)】"));
assert.ok(handoffText.includes("一、S (现状 Situation)"));
assert.ok(handoffText.includes("二、B (背景 Background)"));
assert.ok(handoffText.includes("三、A (评估 Assessment)"));
assert.ok(handoffText.includes("四、R (建议与值班预案 Recommendation)"));
assert.ok(handoffText.includes("心包穿刺引流"));
assert.ok(handoffText.includes("林德明 (住院总)"));
assert.ok(handoffText.includes("张主治 (夜班)"));

console.log("✓ SBAR text generated with physician sign-off attributions");

// ----------------------------------------------------
// Test 4: HospitalAgentAdapter Integration for Handover
// ----------------------------------------------------
console.log("\n[Test 4] Testing HospitalAgentAdapter.executeShiftHandoverWorkflow...");

const adapterRes = HospitalAgentAdapter.executeShiftHandoverWorkflow({
  host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
  context: {
    tenant_id: "hospital_pku_cardio",
    doctor_id: "DOC-PKU-8801",
    doctor_name: "林德明",
    patient_id: "pat-cardio-001",
    encounter_id: "enc-cardio-001",
  },
  dataFeeds: bed1,
  shiftType: SHIFT_TYPES.MORNING_TO_EVENING,
});

assert.equal(adapterRes.success, true);
assert.equal(adapterRes.host_info.workflow, "shift-handover");
assert.ok(adapterRes.provenance.envelope_sha256);
assert.equal(adapterRes.security_contract.fail_closed_verified, true);
assert.ok(adapterRes.draft_text.includes("【临床交接班记录 (SBAR 模型)】"));

console.log("✓ HospitalAgentAdapter shift handover execution verified");

console.log("\nALL SHIFT HANDOVER TESTS PASSED!");
