// Unit Tests for Hospital Multi-Source Data Adapter & Virtual FHIR Normalizer
import assert from "node:assert/strict";
import {
  HospitalDataAdapter,
  calculateEgfrCkdEpi,
  CRITICAL_VALUE_THRESHOLDS,
  RESTRICTED_ANTIBIOTICS,
} from "../plugins/medcius/lib/hospital-data-adapter.mjs";

console.log("== Testing Hospital Multi-Source Data Fusion Adapter ==");

// ----------------------------------------------------
// Test 1: CKD-EPI eGFR Calculation
// ----------------------------------------------------
console.log("\n[Test 1] Testing CKD-EPI 2021 eGFR equation...");

// Male, 65yo, Scr 88.4 umol/L (1.0 mg/dL) -> eGFR approx 86 mL/min/1.73m2
const egfrNormalMale = calculateEgfrCkdEpi(88.4, 65, "男");
assert.ok(egfrNormalMale > 75 && egfrNormalMale < 95, `Expected ~86, got ${egfrNormalMale}`);

// Female, 72yo, Scr 176.8 umol/L (2.0 mg/dL) -> eGFR approx 28.5 mL/min/1.73m2 (< 30)
const egfrSevereFemale = calculateEgfrCkdEpi(176.8, 72, "女");
assert.ok(egfrSevereFemale < 35, `Expected <35, got ${egfrSevereFemale}`);

console.log(`✓ eGFR CKD-EPI verified: Male (Scr 88.4) = ${egfrNormalMale} mL/min, Female (Scr 176.8) = ${egfrSevereFemale} mL/min`);

// ----------------------------------------------------
// Test 2: NIS (Nursing Info System) Ingestion & 24h Fluid Balance
// ----------------------------------------------------
console.log("\n[Test 2] Testing NIS Vital Signs & 24h Fluid Balance extraction...");

const nisSample = [
  {
    id: "nis-01",
    timestamp: new Date(Date.now() - 4 * 3600000).toISOString(),
    temperature: 38.6,
    systolic_bp: 145,
    diastolic_bp: 88,
    heart_rate: 98,
    spo2: 95,
    oral_intake_ml: 600,
    iv_intake_ml: 1500,
    urine_output_ml: 1200,
    drain_output_ml: 150,
    drain_name: "腹腔引流管",
    drain_desc: "淡红色浆液性引流液",
    stool_count: 1,
  },
  {
    id: "nis-02",
    timestamp: new Date(Date.now() - 12 * 3600000).toISOString(),
    temperature: 37.2,
    systolic_bp: 120,
    diastolic_bp: 75,
    heart_rate: 76,
    spo2: 98,
    oral_intake_ml: 400,
    iv_intake_ml: 500,
    urine_output_ml: 650,
    drain_output_ml: 50,
    drain_name: "腹腔引流管",
    stool_count: 0,
  },
];

const nisResult = HospitalDataAdapter.normalizeNisFeed(nisSample);

assert.equal(nisResult.vitals_summary.t_max, 38.6, "Must capture peak temperature");
assert.equal(nisResult.vitals_summary.t_min, 37.2, "Must capture minimum temperature");
assert.equal(nisResult.vitals_summary.bp_max, "145/88 mmHg");
assert.equal(nisResult.fluid_balance.intake_total_ml, 3000, "Total intake must be 600+1500+400+500 = 3000ml");
assert.equal(nisResult.fluid_balance.output_total_ml, 2050, "Total output must be 1200+150+650+50 = 2050ml");
assert.equal(nisResult.fluid_balance.urine_24h_ml, 1850, "Total urine must be 1200+650 = 1850ml");
assert.equal(nisResult.fluid_balance.drain_24h_ml, 200, "Total drain must be 150+50 = 200ml");
assert.equal(nisResult.fluid_balance.net_balance_ml, 950, "Net balance must be +950ml");
assert.equal(nisResult.fluid_balance.net_balance_label, "+950 ml");

console.log("✓ NIS normalization accurately parsed vitals (Tmax 38.6℃, BP 145/88) and 24h fluid balance (+950ml)");

// ----------------------------------------------------
// Test 3: LIS (Lab System) & Critical Value Interception
// ----------------------------------------------------
console.log("\n[Test 3] Testing LIS normalization and critical value interception...");

const lisSample = [
  {
    id: "lis-k-crit",
    test_code: "k",
    test_name: "血钾测定",
    result_value: 2.4, // Critical low (< 2.8)
    unit: "mmol/L",
    reference_range_text: "3.5 - 5.3 mmol/L",
  },
  {
    id: "lis-scr-high",
    test_code: "scr",
    test_name: "血肌酐测定",
    result_value: 410, // Critical high (> 350)
    unit: "μmol/L",
    reference_range_text: "59 - 104 μmol/L",
  },
  {
    id: "lis-na-norm",
    test_code: "na",
    test_name: "血钠测定",
    result_value: 139,
    unit: "mmol/L",
    reference_range_text: "135 - 145 mmol/L",
  },
];

const lisResult = HospitalDataAdapter.normalizeLisFeed(lisSample);
assert.equal(lisResult.observations.length, 3);
assert.equal(lisResult.critical_values.length, 2, "Must intercept 2 critical values (K=2.4 and Scr=410)");

const kCrit = lisResult.critical_values.find((c) => c.name === "血钾测定");
assert.ok(kCrit);
assert.ok(kCrit.reason.includes("低于危急值下限"));

console.log(`✓ LIS intercepted ${lisResult.critical_values.length} critical values with urgency action tags`);

// ----------------------------------------------------
// Test 4: PACS (Imaging System) & Impressions Extraction
// ----------------------------------------------------
console.log("\n[Test 4] Testing PACS normalization and comparative impressions...");

const pacsSample = [
  {
    id: "pacs-01",
    modality: "CT",
    study_name: "胸部高分辨CT平扫",
    report_status: "final",
    impression: "双肺间质性改变；右肺中叶条索影，较 2026-08-18 旧片吸收；双侧胸膜局限性增厚。",
  },
];

const pacsResult = HospitalDataAdapter.normalizePacsFeed(pacsSample);
assert.equal(pacsResult.diagnostic_reports.length, 1);
assert.equal(pacsResult.imaging_impressions.length, 1);
assert.ok(pacsResult.imaging_impressions[0].impression_summary.includes("较 2026-08-18 旧片吸收"));

console.log("✓ PACS normalization accurately extracted comparative imaging impression");

// ----------------------------------------------------
// Test 5: HIS Antimicrobial Stewardship & Duration Monitor
// ----------------------------------------------------
console.log("\n[Test 5] Testing HIS Orders and Antibiotic Duration Monitor...");

const fiveDaysAgo = new Date(Date.now() - 5.5 * 24 * 3600000).toISOString();
const hisSample = [
  {
    id: "ord-med-01",
    drug_name: "注射用头孢曲松钠",
    dosage: "2.0g",
    route: "ivgtt",
    frequency: "qd",
    authored_on: fiveDaysAgo,
    change_type: "active",
  },
  {
    id: "ord-med-02",
    drug_name: "阿司匹林肠溶片",
    dosage: "100mg",
    route: "po",
    frequency: "qd",
    authored_on: new Date().toISOString(),
    change_type: "active",
  },
];

const hisResult = HospitalDataAdapter.normalizeHisOrders(hisSample);
assert.equal(hisResult.antibiotic_alerts.length, 1, "Must detect restricted antibiotic头孢曲松");
const antiAlert = hisResult.antibiotic_alerts[0];
assert.equal(antiAlert.drug_name, "注射用头孢曲松钠");
assert.equal(antiAlert.level, "限制使用级");
assert.ok(antiAlert.duration_days >= 5, `Expected >= 5 days, got ${antiAlert.duration_days}`);

console.log(`✓ HIS Antimicrobial Monitor detected: ${antiAlert.alert_message}`);

console.log("\nALL HOSPITAL MULTI-SOURCE ADAPTER TESTS PASSED!\n");
