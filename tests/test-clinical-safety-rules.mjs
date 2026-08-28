// Clinical Safety & Quality Control Rules Hardening Tests
import assert from "node:assert/strict";
import { PatientEvolutionEngine, ITEM_CATEGORIES } from "../plugins/medcius/lib/patient-evolution-engine.mjs";
import { loadSpecialtyRulePack } from "../plugins/medcius/lib/specialty-rule-pack.mjs";

const sandboxRulePack = loadSpecialtyRulePack("cardiology-inpatient-sandbox");

console.log("== Testing Clinical Safety & Quality Control Rules Hardening ==");

const patient = {
  id: "IP-2026-CARDIO-9901",
  name: "赵** (脱敏)",
  gender: "男",
  age: 72,
  bed_number: "08床",
  admission_date: "2026-08-20",
  primary_diagnosis: "急性失代偿性心力衰竭，高血压3级，慢性肾脏病3b期",
  weight_kg: 70,
};

const nursingFeed = [
  {
    temperature: 38.8,
    systolic_bp: 165,
    diastolic_bp: 95,
    heart_rate: 104,
    spo2: 93,
    oral_intake_ml: 500,
    iv_intake_ml: 1200,
    urine_output_ml: 900,
    drain_output_ml: 100,
    timestamp: new Date().toISOString(),
  },
];

const lisFeed = [
  {
    id: "obs-k-crit",
    test_code: "k",
    test_name: "血清钾",
    result_value: 2.6, // Critical Low
    unit: "mmol/L",
    reference_range_text: "3.5 - 5.3 mmol/L",
    referenceRange: [{ low: { value: 3.5, unit: "mmol/L" }, high: { value: 5.3, unit: "mmol/L" } }],
  },
  {
    id: "obs-scr-aki",
    test_code: "scr",
    test_name: "血清肌酐",
    result_value: 265,
    unit: "μmol/L",
    is_critical_reported: true,
    reference_range_text: "59 - 104 μmol/L",
    referenceRange: [{ low: { value: 59, unit: "μmol/L" }, high: { value: 104, unit: "μmol/L" } }],
  },
];

const pacsFeed = [
  {
    id: "pacs-01",
    modality: "CT",
    study_name: "胸部增强CT",
    report_status: "final",
    impression: "双下肺片状实变影伴双侧中等量胸腔积液，较前略有增多。",
  },
];

const sixDaysAgo = new Date(Date.now() - 6.2 * 24 * 3600000).toISOString();
const medications = [
  {
    id: "med-01",
    drug_name: "注射用美罗培南",
    dosage: "1.0g",
    route: "ivgtt",
    frequency: "q8h",
    authored_on: sixDaysAgo,
    change_type: "active",
  },
  {
    id: "med-02",
    drug_name: "地高辛片",
    dosage: "0.125mg",
    route: "po",
    frequency: "qd",
    authored_on: new Date().toISOString(),
    change_type: "added",
  },
];

// ----------------------------------------------------
// Test 1: Full Patient Evolution Analysis with Safety Hardening
// ----------------------------------------------------
console.log("\n[Test 1] Running PatientEvolutionEngine with Multi-Source Ingestion...");

const summary = PatientEvolutionEngine.analyzePatientEvolution({
  patient,
  timeWindow: "24h",
  notes: [
    {
      id: "note-01",
      timestamp: new Date().toISOString(),
      text: "病程记录：今日患者诉夜间端坐呼吸，双下肢水肿明显。最高体温 38.8℃，急查血钾 2.6 mmol/L。",
    },
  ],
  observations: [],
  medications,
  diagnosticReports: [],
  orders: [
    { id: "ord-01", title: "急诊心电图", status: "active", scheduled_time: "立即执行" },
  ],
  allergies: ["青霉素"],
  nursingFeed,
  pacsFeed,
  lisFeed,
  rulePack: sandboxRulePack,
});

// Assert Critical Values Detection
assert.equal(summary.critical_values.length, 2, "Must intercept critical low K (2.6 mmol/L) and critical high Scr (265 μmol/L)");
const kCrit = summary.critical_values.find((c) => c.name === "血清钾");
assert.ok(kCrit);
assert.equal(kCrit.value, 2.6);
assert.ok(kCrit.reason.includes("低于危急值下限"));
console.log("✓ LIS Critical Values (rule-pack K boundary plus source-reported Scr flag) retained for staged closure tracking");

// Assert Vitals & 24h Fluid Balance
assert.ok(summary.blocks.what_changed.vitals_and_fluids);
assert.equal(summary.blocks.what_changed.vitals_and_fluids.vitals.t_max, 38.8);
assert.equal(summary.blocks.what_changed.vitals_and_fluids.fluids.intake_total_ml, 1700);
assert.equal(summary.blocks.what_changed.vitals_and_fluids.fluids.output_total_ml, 1000);
assert.equal(summary.blocks.what_changed.vitals_and_fluids.fluids.net_balance_ml, 700);
console.log("✓ NIS Vitals (Tmax 38.8℃, BP 165/95) and 24h Fluid Balance (+700ml) integrated");

// Assert eGFR and Renal Safety Alert
assert.ok(summary.patient.egfr !== null);
assert.ok(summary.patient.egfr < 30, `Expected eGFR < 30, got ${summary.patient.egfr}`);
const egfrRule = summary.blocks.rule_reminders.find((r) => r.id.startsWith("RULE-EGFR"));
assert.ok(egfrRule, "Must trigger eGFR < 30 renal safety warning for renal-cleared drugs");
console.log(`✓ eGFR calculated (${summary.patient.egfr} mL/min/1.73m²) & triggered renal safety guardrail`);

// Assert Antimicrobial Stewardship Alert
const antiRule = summary.blocks.rule_reminders.find((r) => r.id.startsWith("RULE-ANTI"));
assert.ok(antiRule, "Must trigger restricted antibiotic duration warning for 美罗培南");
assert.ok(antiRule.summary.includes("特殊使用级"));
assert.ok(antiRule.summary.includes("美罗培南"));
console.log(`✓ Antimicrobial Stewardship Alert: ${antiRule.summary}`);

// Assert PACS Imaging Comparative Impression
assert.equal(summary.blocks.what_changed.imaging_changes.length, 1);
assert.ok(summary.blocks.what_changed.imaging_changes[0].summary.includes("双下肺片状实变影伴双侧中等量胸腔积液"));
console.log("✓ PACS Comparative Impression integrated into What Changed");

// ----------------------------------------------------
// Test 2: Progress Note Draft with Enhanced Multi-Source Data
// ----------------------------------------------------
console.log("\n[Test 2] Testing Progress Note Draft generation with multi-source facts...");

const allIds = summary.selectable_items.map((i) => i.id);
const draft = PatientEvolutionEngine.generateProgressNoteDraft({
  summaryData: summary,
  selectedItemIds: allIds,
  doctorId: "DOC-CARDIO-8802",
  doctorName: "王主任医师",
  customAdditions: "患者心衰急性发作合并低钾血症，立即予以氯化钾注射液微泵补钾，停用地高辛以防洋地黄中毒，复查急诊心电图。",
});

assert.ok(draft.draft_text.includes("【日常查房记录 - 病情演变摘要】"));
assert.ok(draft.draft_text.includes("肾功能估算：eGFR"));
assert.ok(draft.draft_text.includes("生命体征/出入量"));
assert.ok(draft.draft_text.includes("最高体温: 38.8℃"));
assert.ok(draft.draft_text.includes("[检验] 血清钾: 2.6 mmol/L"));
assert.ok(draft.draft_text.includes("[影像] 【胸部增强CT】"));
assert.ok(draft.draft_text.includes("[临床提醒]"));
assert.ok(draft.draft_text.includes("王主任医师"));

console.log("✓ Progress note draft generated with multi-source facts, eGFR, vitals, and physician customization");

// ----------------------------------------------------
// Test 3: Unclosed Loops & Strict 4-Stage Lifecycle Non-Inference
// ----------------------------------------------------
console.log("\n[Test 3] Testing High-Risk Followup Tracker 4-Stage Lifecycle (Forbidding result -> acknowledged inference)...");

import { trackHighRiskFollowup } from "../plugins/medcius/lib/high-risk-followup-tracker.mjs";

const unclosedReports = [
  {
    id: "obs-crit-troponin",
    test_code: "ctni",
    name: "超敏肌钙蛋白I",
    value: 12.5,
    unit: "ng/mL",
    status: "final",
    is_critical_reported: true,
    resulted_at: "2026-08-28T02:00:00Z",
    acknowledged_at: null, // Doctor has NOT acknowledged yet!
  },
];

const trackerResult = trackHighRiskFollowup({
  orders: [],
  observations: unclosedReports,
  diagnosticReports: [],
  rulePack: sandboxRulePack,
  now: new Date("2026-08-28T02:30:00Z"),
});

assert.equal(trackerResult.items.length, 1);
const trackedItem = trackerResult.items[0];
assert.equal(trackedItem.stage, "resulted", "Must be in 'resulted' stage");
assert.equal(trackedItem.gap, "PENDING_CLINICIAN_ACKNOWLEDGEMENT", "Must have gap PENDING_CLINICIAN_ACKNOWLEDGEMENT");
assert.equal(trackerResult.counts.open, 1, "Must remain OPEN (unclosed) until doctor acknowledged");
assert.equal(trackerResult.counts.acknowledged, 0, "Cannot infer acknowledged from resulted");

console.log("✓ High-Risk Followup correctly preserved 'resulted' stage as unclosed (open=1, acknowledged=0, gap=PENDING_CLINICIAN_ACKNOWLEDGEMENT)");

// ----------------------------------------------------
// Test 4: Deterministic Missing Reference Range Handling (No Guessed Abnormality)
// ----------------------------------------------------
console.log("\n[Test 4] Testing Missing Reference Range Handling (Value & trend only, no speculative abnormality)...");

const summaryNoRef = PatientEvolutionEngine.analyzePatientEvolution({
  patient,
  timeWindow: "24h",
  notes: [],
  observations: [
    {
      id: "obs-special-marker",
      code: "special-chem-marker",
      name: "未知生化标志物X",
      value: 88.5,
      unit: "U/L",
      referenceRange: [], // Missing reference range
      effective_time: new Date().toISOString(),
    },
  ],
  medications: [],
  diagnosticReports: [],
  orders: [],
  allergies: ["青霉素"],
  rulePack: sandboxRulePack,
});

const labX = summaryNoRef.blocks.what_changed.abnormal_labs.find((l) => l.test_name === "未知生化标志物X");
assert.ok(labX, "Must capture raw lab record");
assert.equal(labX.has_reference_range, false, "Must flag has_reference_range = false");
assert.equal(labX.is_abnormal, false, "Must NOT set is_abnormal = true without reference range");
assert.ok(labX.status_label.includes("无参考区间"), "Status label must explicitly state missing reference range");

console.log("✓ Missing reference range correctly yielded raw numeric trend without guessing abnormality");

// ----------------------------------------------------
// Test 5: ConText 3-Axis Assertion Model (Presence, Temporality, Experiencer)
// ----------------------------------------------------
console.log("\n[Test 5] Testing ConText 3-Axis Assertion Extraction (Positive, Negative, Not Evaluated, Familial)...");

import { extractConTextAssertion } from "../plugins/medcius/lib/parse-cn-note.mjs";

const posAssertion = extractConTextAssertion("患者诉轻度胸闷，双下肢可凹性水肿");
assert.equal(posAssertion.presence, "positive");
assert.equal(posAssertion.temporality, "current");
assert.equal(posAssertion.experiencer, "patient");

const negAssertion = extractConTextAssertion("患者否认夜间发热及阵发性呼吸困难");
assert.equal(negAssertion.presence, "negative");
assert.equal(negAssertion.presence_label, "【阴性/否定】");

const notEvalAssertion = extractConTextAssertion("未行直肠指检，未查病理反射");
assert.equal(notEvalAssertion.presence, "not_evaluated");
assert.equal(notEvalAssertion.presence_label, "【未评估】");

const famAssertion = extractConTextAssertion("母亲有高血压与冠心病史");
assert.equal(famAssertion.experiencer, "family_member");

const histAssertion = extractConTextAssertion("既往有十二指肠溃疡病史5年");
assert.equal(histAssertion.temporality, "historical");

console.log("✓ ConText 3-Axis strictly distinguished: positive, negative (否认), not_evaluated (未查), family_member, and historical");

// ----------------------------------------------------
// Test 6: Explicit Data Gaps (Allergy, Renal, Weight, Rule-Pack)
// ----------------------------------------------------
console.log("\n[Test 6] Testing Explicit Data Gaps Detection...");

const summaryWithGaps = PatientEvolutionEngine.analyzePatientEvolution({
  patient: { id: "P-GAPS-001", name: "未知患者" }, // Missing age, gender, weight
  timeWindow: "24h",
  notes: [],
  observations: [], // No creatinine
  medications: [],
  diagnosticReports: [],
  orders: [],
  allergies: null, // Missing allergy
  rulePack: null,  // Missing rule pack
});

const gapTypes = summaryWithGaps.blocks.data_gaps.map((g) => g.gap_type);
assert.ok(gapTypes.includes("ALLERGY_MISSING"), "Must flag ALLERGY_MISSING");
assert.ok(gapTypes.includes("RENAL_FUNCTION_MISSING"), "Must flag RENAL_FUNCTION_MISSING");
assert.ok(gapTypes.includes("WEIGHT_MISSING"), "Must flag WEIGHT_MISSING");
assert.ok(gapTypes.includes("RULE_PACK_MISSING"), "Must flag RULE_PACK_MISSING");

console.log(`✓ Explicitly identified ${gapTypes.length} critical data gaps: ${gapTypes.join(", ")}`);

console.log("\nALL CLINICAL SAFETY & QUALITY CONTROL HARDENING TESTS PASSED!\n");

