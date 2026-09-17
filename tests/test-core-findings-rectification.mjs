// Comprehensive Regression & Rectification Test Suite (F-01 to F-14)
// Validates deep rectification for all findings reported in medcius-clinical-infrastructure-evaluation.

import assert from "node:assert/strict";
import { PostHocClaimVerifier } from "../plugins/medcius/lib/post-hoc-verifier.mjs";
import { parseLabs, extractConTextAssertion } from "../plugins/medcius/lib/parse-cn-note.mjs";
import { HospitalDataAdapter, normalizeLabUnit, calculateNews2 } from "../plugins/medcius/lib/hospital-data-adapter.mjs";
import { containsRawPhi } from "../plugins/medcius/servers/phiguard/src/lib.mjs";
import { EnhancedPhiGuard } from "../plugins/medcius/lib/enhanced-phi-guard.mjs";
import { loadSpecialtyRulePack } from "../plugins/medcius/lib/specialty-rule-pack.mjs";
import { PatientEvolutionEngine } from "../plugins/medcius/lib/patient-evolution-engine.mjs";
import { DualTrackGatingEngine } from "../plugins/medcius/lib/causal-attribution-engine.mjs";
import { CDS_SERVICES, handleCdsHookRequest } from "../plugins/medcius/servers/api/src/cds-hooks.mjs";
import { SECONDARY_INTENDED_USES } from "../plugins/medcius/lib/clinical-landing-policy.mjs";

console.log("================================================================================");
console.log(" Testing Deep Rectification for Evaluation Findings (F-01 to F-14)");
console.log("================================================================================\n");

const sandboxRulePack = loadSpecialtyRulePack("cardiology-inpatient-sandbox");

// ----------------------------------------------------
// 1. Test F-01: Post-Hoc Claim-to-Evidence Verifier
// ----------------------------------------------------
console.log("▶ [Test F-01] Testing PostHocClaimVerifier...");

const verifiableItems = [
  { id: "SYM-001", title: "胸闷", summary: "患者诉轻度胸闷", presence: "positive" },
  { id: "SYM-002", title: "发热", summary: "否认发热", presence: "negative", tag: "【阴性/否定】" },
  { id: "LAB-001", title: "肌酐", summary: "血肌酐 142 μmol/L", presence: "positive" },
];

// Case A: Fully supported narrative
const validNarrative = `
【日常查房记录】
患者目前诉轻度胸闷 [^SYM-001]，否认发热 [^SYM-002]。
生化检验示血肌酐 142 μmol/L [^LAB-001]。
`;

const resA = PostHocClaimVerifier.verifyClaims({ narrativeText: validNarrative, verifiableItems });
assert.equal(resA.is_passing, true, "Valid cited claims must pass");
assert.equal(resA.supported_count, 2, "Must verify 2 supported sentences");
assert.equal(resA.total_verified_citations, 3, "Must verify 3 cited references");
assert.equal(resA.unsupported_claim_rate, 0.0, "Rate must be 0.0");

// Case B: Unsupported hallucinated clinical claims
const unsupportedNarrative = `
患者诉轻度胸闷 [^SYM-001]。
今日心率加快，伴有明显呼吸急促和咳嗽。
`;
const resB = PostHocClaimVerifier.verifyClaims({ narrativeText: unsupportedNarrative, verifiableItems });
assert.equal(resB.is_passing, false, "Uncited clinical claim must fail verification");
assert.equal(resB.unsupported_count, 1);
assert.ok(resB.unsupported_claim_rate > 0.0);

// Case C: Invalid non-existent citation ID
const invalidCiteNarrative = `患者肌酐好转 [^LAB-999-FAKE]。`;
const resC = PostHocClaimVerifier.verifyClaims({ narrativeText: invalidCiteNarrative, verifiableItems });
assert.equal(resC.is_passing, false);
assert.equal(resC.invalid_citation_count, 1);

// Case D: Contradiction check (claims positive symptom referencing negative evidence)
const contradictoryNarrative = `患者今日出现高热体温达39度 [^SYM-002]。`;
const resD = PostHocClaimVerifier.verifyClaims({ narrativeText: contradictoryNarrative, verifiableItems });
assert.equal(resD.is_passing, false);
assert.equal(resD.contradictory_count, 1);

// Case E: Strict fail-closed execution
assert.throws(
  () => PostHocClaimVerifier.verifyClaims({ narrativeText: unsupportedNarrative, verifiableItems, options: { strict: true } }),
  /POST_HOC_VERIFICATION_FAIL_CLOSED/
);

console.log("✓ F-01 PostHocClaimVerifier successfully passed all verification & fail-closed tests");

// ----------------------------------------------------
// 2. Test F-02: Expanded Lab Extraction from Clinical Notes
// ----------------------------------------------------
console.log("\n▶ [Test F-02] Testing Expanded Clinical Lab Extraction (parseLabs)...");

const complexNoteText = `
查体及辅助检查：
血常规：白细胞 11.2 *10^9/L，血红蛋白 105 g/L，血小板 230 *10^9/L，中性粒细胞比例 82.5%。
生化全套：ALT 65 U/L，AST 42 U/L，总胆红素 28.4 μmol/L，白蛋白 34 g/L。
肾功电解质：血肌酐 168 μmol/L，尿素氮 14.2 mmol/L，血钾 3.2 mmol/L，血钠 138 mmol/L，血钙 2.15 mmol/L。
心肌标志物及炎症：超敏肌钙蛋白I 0.85 ng/mL，NT-proBNP 2450 pg/mL，CRP 45 mg/L，PCT 0.35 ng/mL。
凝血及代谢：凝血酶原时间 14.5 s，INR 1.25，D-二聚体 1.8 mg/L，空腹血糖 8.4 mmol/L，HbA1c 7.2%。
`;

const extractedLabs = parseLabs(complexNoteText);
const labMap = new Map(extractedLabs.map((l) => [l.name, l]));

assert.ok(labMap.has("白细胞") && labMap.get("白细胞").value === 11.2, "WBC must be extracted");
assert.ok(labMap.has("血红蛋白") && labMap.get("血红蛋白").value === 105, "HGB must be extracted");
assert.ok(labMap.has("血小板") && labMap.get("血小板").value === 230, "PLT must be extracted");
assert.ok(labMap.has("中性粒细胞比例") && labMap.get("中性粒细胞比例").value === 82.5, "NEUT% must be extracted");
assert.ok(labMap.has("ALT") && labMap.get("ALT").value === 65, "ALT must be extracted");
assert.ok(labMap.has("总胆红素") && labMap.get("总胆红素").value === 28.4, "TBIL must be extracted");
assert.ok(labMap.has("肌酐") && labMap.get("肌酐").value === 168, "Scr must be extracted");
assert.ok(labMap.has("尿素氮") && labMap.get("尿素氮").value === 14.2, "BUN must be extracted");
assert.ok(labMap.has("血钾") && labMap.get("血钾").value === 3.2, "K must be extracted");
assert.ok(labMap.has("血钙") && labMap.get("血钙").value === 2.15, "Ca must be extracted");
assert.ok(labMap.has("肌钙蛋白I") && labMap.get("肌钙蛋白I").value === 0.85, "cTnI must be extracted");
assert.ok(labMap.has("NT-proBNP") && labMap.get("NT-proBNP").value === 2450, "NT-proBNP must be extracted");
assert.ok(labMap.has("CRP") && labMap.get("CRP").value === 45, "CRP must be extracted");
assert.ok(labMap.has("降钙素原") && labMap.get("降钙素原").value === 0.35, "PCT must be extracted");
assert.ok(labMap.has("凝血酶原时间") && labMap.get("凝血酶原时间").value === 14.5, "PT must be extracted");
assert.ok(labMap.has("INR") && labMap.get("INR").value === 1.25, "INR must be extracted");
assert.ok(labMap.has("D-二聚体") && labMap.get("D-二聚体").value === 1.8, "D-Dimer must be extracted");
assert.ok(labMap.has("血糖") && labMap.get("血糖").value === 8.4, "GLU must be extracted");
assert.ok(labMap.has("HbA1c") && labMap.get("HbA1c").value === 7.2, "HbA1c must be extracted");

console.log(`✓ F-02 parseLabs recognized ${extractedLabs.length} clinical routine indicators across 8 panels`);

// ----------------------------------------------------
// 3. Test F-03: Scoped ConText Negation & Pseudo-Negation Fix
// ----------------------------------------------------
console.log("\n▶ [Test F-03] Testing ConText Negation and Pseudo-Negation Resolution...");

// Pseudo-negation phrases (Symptoms persisting, NOT negative!)
const a1 = extractConTextAssertion("患者胸闷无缓解");
assert.equal(a1.presence, "positive", "‘胸闷无缓解’表示症状持续，绝不可误判为阴性！");

const a2 = extractConTextAssertion("发热无明显下降趋势");
assert.equal(a2.presence, "positive", "‘发热无明显下降趋势’必须判定为阳性/现症");

const a3 = extractConTextAssertion("咳嗽咳痰未见好转");
assert.equal(a3.presence, "positive", "‘未见好转’必须判定为阳性/现症");

const a4 = extractConTextAssertion("双下肢水肿无明显消退");
assert.equal(a4.presence, "positive", "‘无明显消退’必须判定为阳性/现症");

// True negation phrases
const a5 = extractConTextAssertion("患者否认夜间阵发性呼吸困难及心悸");
assert.equal(a5.presence, "negative", "‘否认’必须判定为阴性");

const a6 = extractConTextAssertion("查体：未闻及干湿啰音，未触及肿块");
assert.equal(a6.presence, "negative", "‘未闻及/未触及’必须判定为阴性");

// Not evaluated
const a7 = extractConTextAssertion("未行急诊冠脉造影，未做直肠指检");
assert.equal(a7.presence, "not_evaluated", "‘未行/未做’必须判定为未评估");

// Historical & Family
const a8 = extractConTextAssertion("既往有十二指肠球部溃疡病史8年");
assert.equal(a8.temporality, "historical", "既往病史必须判定为 historical");

const a9 = extractConTextAssertion("父亲有早期胃癌切除史");
assert.equal(a9.experiencer, "family_member", "父亲病史必须判定为 family_member");

console.log("✓ F-03 Scoped ConText correctly resolved all pseudo-negation and clinical polarity traps");

// ----------------------------------------------------
// 4. Test F-04: No Fabricated Timestamps in LIS
// ----------------------------------------------------
console.log("\n▶ [Test F-04] Testing LIS Missing Timestamp Handling (No new Date() Fabrication)...");

const missingTimeFeed = [
  {
    id: "lis-notime-01",
    code: "scr",
    name: "血肌酐",
    value: 150,
    unit: "μmol/L",
    // effective_time & sample_time omitted!
  },
];

// When cutoffTime is specified, records without timestamps must be quarantined to data_gaps
const lisWindowRes = HospitalDataAdapter.normalizeLisFeed(missingTimeFeed, {
  rulePack: sandboxRulePack,
  cutoffTime: Date.now() - 24 * 3600000,
  now: Date.now(),
});

assert.equal(lisWindowRes.observations.length, 0, "Missing timestamp record must NOT enter sliding 24h window");
assert.equal(lisWindowRes.data_gaps.length, 1, "Missing timestamp must produce an explicit DATA_GAP");
assert.ok(lisWindowRes.data_gaps[0].reason.includes("采样时间缺失"));

// When normalized without window, sample_time must be null, NOT new Date()
const lisRawRes = HospitalDataAdapter.normalizeLisFeed(missingTimeFeed, { rulePack: sandboxRulePack });
assert.equal(lisRawRes.observations[0].effective_time, null, "effective_time must be null, NOT new Date()");
assert.equal(lisRawRes.observations[0].timestamp_status, "MISSING");

console.log("✓ F-04 LIS missing timestamp strictly verified: zero fabricated timestamps, quarantined to DATA_GAP");

// ----------------------------------------------------
// 5. Test F-05: Nursing Feed Time-Window Filtering
// ----------------------------------------------------
console.log("\n▶ [Test F-05] Testing NIS Feed Explicit Time-Window Filtering...");

const now = Date.now();
const nisMixedFeed = [
  {
    id: "nis-recent",
    timestamp: new Date(now - 3 * 3600000).toISOString(), // 3 hours ago -> in window
    temperature: 37.5,
    oral_intake_ml: 500,
    urine_output_ml: 400,
  },
  {
    id: "nis-old",
    timestamp: new Date(now - 48 * 3600000).toISOString(), // 48 hours ago -> OUT of 24h window
    temperature: 39.2,
    oral_intake_ml: 2000,
    urine_output_ml: 1500,
  },
];

const nisWindowRes = HospitalDataAdapter.normalizeNisFeed(nisMixedFeed, {
  rulePack: sandboxRulePack,
  cutoffTime: now - 24 * 3600000,
  now: now,
});

assert.equal(nisWindowRes.fluid_balance.intake_total_ml, 500, "Must only aggregate 500ml from in-window record");
assert.equal(nisWindowRes.fluid_balance.output_total_ml, 400, "Must only aggregate 400ml from in-window record");
assert.equal(nisWindowRes.vitals_summary.t_max, 37.5, "Peak temp must be 37.5℃, ignoring 48h-old 39.2℃");
assert.equal(nisWindowRes.discarded_outside_window_count, 1, "Must discard 1 out-of-window record");
assert.equal(nisWindowRes.fluid_balance.window_filtered, true);

console.log("✓ F-05 NIS 24h window filtering strictly excludes out-of-window records");

// ----------------------------------------------------
// 6. Test F-06: Unit-Aware Critical Value Comparison
// ----------------------------------------------------
console.log("\n▶ [Test F-06] Testing Unit Normalization and Fail-Closed Critical Value Check...");

// Test helper directly
const gluMgDl = normalizeLabUnit(90, "mg/dL", "mmol/L", "glu");
assert.equal(gluMgDl.compatible, true);
assert.ok(gluMgDl.comparableValue > 4.9 && gluMgDl.comparableValue < 5.1, "90 mg/dL should be approx 5.0 mmol/L");

const gluHighMgDl = normalizeLabUnit(400, "mg/dL", "mmol/L", "glu");
assert.ok(gluHighMgDl.comparableValue > 22.0, "400 mg/dL should be > 22.0 mmol/L");

const scrMgDl = normalizeLabUnit(4.5, "mg/dL", "μmol/L", "scr");
assert.equal(scrMgDl.compatible, true);
assert.ok(scrMgDl.comparableValue > 390, "4.5 mg/dL should be approx 397 μmol/L");

// Incompatible unit check
const badUnit = normalizeLabUnit(150, "cups", "mmol/L", "glu");
assert.equal(badUnit.compatible, false);
assert.ok(badUnit.error.includes("UNIT_MISMATCH"));

// Integration with normalizeLisFeed
const lisUnitFeed = [
  {
    id: "glu-normal-mgdl",
    code: "glu",
    name: "血糖",
    value: 90, // 90 mg/dL = 5.0 mmol/L, normal
    unit: "mg/dL",
    effective_time: new Date().toISOString(),
  },
  {
    id: "glu-crit-mgdl",
    code: "glu",
    name: "血糖",
    value: 400, // 400 mg/dL = 22.2 mmol/L, critical high (> 16.6)
    unit: "mg/dL",
    effective_time: new Date().toISOString(),
  },
  {
    id: "glu-incompatible",
    code: "glu",
    name: "血糖",
    value: 50,
    unit: "incompatible_unit",
    effective_time: new Date().toISOString(),
  },
];

const lisUnitRes = HospitalDataAdapter.normalizeLisFeed(lisUnitFeed, { rulePack: sandboxRulePack });
// In rule pack: critical high glu threshold is 16.6 mmol/L
const gluCrits = lisUnitRes.critical_values.filter((c) => c.name === "血糖");
assert.equal(gluCrits.length, 1, "Only 400 mg/dL should be flagged as critical, not 90 mg/dL");
assert.equal(gluCrits[0].observation_id, "glu-crit-mgdl");

// Incompatible unit must generate data_gap, not false critical
const incompatGap = lisUnitRes.data_gaps.find((g) => g.code === "glu");
assert.ok(incompatGap);
assert.ok(incompatGap.reason.includes("CRITICAL_VALUE_UNIT_INCOMPATIBLE"));

console.log("✓ F-06 Unit-aware conversion correctly evaluated mg/dL vs mmol/L and isolated incompatible units");

// ----------------------------------------------------
// 7. Test F-14: Deterministic ID Generation
// ----------------------------------------------------
console.log("\n▶ [Test F-14] Testing Deterministic Observation ID Replay...");

const rawLisItem = [
  {
    code: "alt",
    value: 88,
    unit: "U/L",
    effective_time: "2026-09-06T12:00:00.000Z",
  },
];

const run1 = HospitalDataAdapter.normalizeLisFeed(rawLisItem, { rulePack: sandboxRulePack });
const run2 = HospitalDataAdapter.normalizeLisFeed(rawLisItem, { rulePack: sandboxRulePack });

assert.equal(run1.observations[0].id, run2.observations[0].id, "IDs generated across runs on identical data MUST be deterministic!");
assert.ok(!run1.observations[0].id.includes("NaN") && !run1.observations[0].id.includes("undefined"));

console.log(`✓ F-14 Deterministic ID verified: ${run1.observations[0].id} identical across multiple runs`);

// ----------------------------------------------------
// 8. Test F-08: PHI Guard Quick-Path Alignment
// ----------------------------------------------------
console.log("\n▶ [Test F-08] Testing PHI Guard Quick-Path Alignment & Contextual Sanitization...");

assert.equal(containsRawPhi("咨询请拨打分机电话：010-69156699 获取报告").hit, true, "Fixed phone must trigger hit");
assert.equal(containsRawPhi("联系邮箱：doctor_zhang@pku.edu.cn 索取资料").hit, true, "Email must trigger hit");
assert.equal(containsRawPhi("普通临床数值：体温36.5度，血压120/80").hit, false, "Ordinary clinical text must be clean");

const contextualPatText = "患者李建国诉昨日胸骨后压榨性疼痛，由其子李小军送入急诊。诊断：库欣综合征。";
const sanResult = EnhancedPhiGuard.sanitize(contextualPatText);
assert.ok(!sanResult.sanitized.includes("李建国"), "Contextual patient name ‘李建国’ must be tokenized");
assert.ok(!sanResult.sanitized.includes("李小军"), "Contextual relative name ‘李小军’ must be tokenized");
assert.ok(sanResult.sanitized.includes("库欣"), "Medical eponym ‘库欣综合征’ MUST be protected from tokenization!");

console.log("✓ F-08 PHI Guard successfully aligned quick-path and protected medical eponyms");

// ----------------------------------------------------
// 9. Test eGFR Unit Normalization (Last-Mile Resolution)
// ----------------------------------------------------
console.log("\n▶ [Test 09] Testing eGFR Unit Normalization & Incompatible Unit Isolation...");

const testPatient = {
  id: "P-MGDL",
  name: "张伟",
  age: 60,
  gender: "male",
};

// Test 9a: mg/dL unit normalization (1.0 mg/dL = 88.4 umol/L)
const evolutionMgDl = PatientEvolutionEngine.analyzePatientEvolution({
  patient: testPatient,
  observations: [
    {
      id: "scr-mgdl-1",
      name: "肌酐",
      code: "creatinine",
      value: 1.0,
      unit: "mg/dL",
      effective_time: new Date().toISOString(),
    },
  ],
  rulePack: sandboxRulePack,
});

assert.ok(evolutionMgDl.patient.egfr != null, "eGFR with 1.0 mg/dL must be calculated via unit normalization to umol/L");
assert.ok(evolutionMgDl.patient.egfr > 70 && evolutionMgDl.patient.egfr < 100, `eGFR ${evolutionMgDl.patient.egfr} should be within normal range (~83-88)`);

// Test 9b: Incompatible unit produces null eGFR and GAP-EGFR-UNIT
const evolutionIncompat = PatientEvolutionEngine.analyzePatientEvolution({
  patient: testPatient,
  observations: [
    {
      id: "scr-incompat-1",
      name: "肌酐",
      code: "creatinine",
      value: 90,
      unit: "incompatible_unit",
      effective_time: new Date().toISOString(),
    },
  ],
  rulePack: sandboxRulePack,
});

assert.equal(evolutionIncompat.patient.egfr, null, "Incompatible creatinine unit must fail closed to null eGFR");
const egfrGap = evolutionIncompat.blocks.data_gaps.find((g) => g.gap_type === "CREATININE_UNIT_INCOMPATIBLE");
assert.ok(egfrGap, "Must emit CREATININE_UNIT_INCOMPATIBLE data gap");

console.log("✓ Test 09 eGFR unit normalization correctly handled mg/dL and isolated incompatible units with data gap");

// ----------------------------------------------------
// 10. Test AKI Creatinine Stability Check (KDIGO Safety Guard)
// ----------------------------------------------------
console.log("\n▶ [Test 10] Testing KDIGO AKI Creatinine Non-Steady-State eGFR Block...");

const evolutionAki = PatientEvolutionEngine.analyzePatientEvolution({
  patient: testPatient,
  observations: [
    {
      id: "scr-base-01",
      name: "肌酐",
      code: "creatinine",
      value: 80,
      unit: "umol/L",
      effective_time: new Date(Date.now() - 3600 * 1000 * 20).toISOString(),
    },
    {
      id: "scr-latest-01",
      name: "肌酐",
      code: "creatinine",
      value: 135, // acute surge +55 umol/L (>= 26.5 umol/L and >= 50%)
      unit: "umol/L",
      effective_time: new Date().toISOString(),
    },
  ],
  rulePack: sandboxRulePack,
});

assert.equal(evolutionAki.patient.egfr, null, "Static eGFR must be blocked during acute creatinine instability/AKI");
const akiAlert = evolutionAki.blocks.high_risk_followup.items.find((r) => r.tracking_id.includes("aki:"));
assert.ok(akiAlert, "Must emit KDIGO AKI risk alert in high_risk_followup");
const akiGap = evolutionAki.blocks.data_gaps.find((g) => g.gap_type === "CREATININE_NON_STEADY_STATE");
assert.ok(akiGap, "Must emit CREATININE_NON_STEADY_STATE data gap");

console.log("✓ Test 10 KDIGO AKI creatinine surge correctly blocked eGFR and generated AKI risk alert");

// ----------------------------------------------------
// 11. Test NEWS2 Early Warning Score Calculation & Integration
// ----------------------------------------------------
console.log("\n▶ [Test 11] Testing NEWS2 Calculation, Single Red Trigger & Vitals Integration...");

// 11a: Normal physiology
const newsNormal = calculateNews2({
  respiratory_rate: 16,
  spo2: 98,
  supplemental_oxygen: false,
  sbp: 120,
  heart_rate: 72,
  temperature: 36.8,
  consciousness: "A",
});
assert.equal(newsNormal.total_score, 0);
assert.equal(newsNormal.risk_code, "LOW");
assert.equal(newsNormal.has_single_red, false);

// 11b: Single red parameter trigger (e.g. severe hypoxemia SpO2 <= 91% -> 3 pts)
const newsSingleRed = calculateNews2({
  respiratory_rate: 18,
  spo2: 90, // 3 pts (red)
  supplemental_oxygen: false,
  sbp: 125,
  heart_rate: 80,
  temperature: 37.0,
  consciousness: "A",
});
assert.equal(newsSingleRed.total_score, 3);
assert.equal(newsSingleRed.has_single_red, true);
assert.equal(newsSingleRed.risk_code, "LOW-MEDIUM");

// 11c: High risk aggregate score (>= 7)
const newsHighRisk = calculateNews2({
  respiratory_rate: 28, // 3 pts
  spo2: 91, // 3 pts
  supplemental_oxygen: true, // 2 pts
  sbp: 85, // 3 pts
  heart_rate: 135, // 3 pts
  temperature: 39.5, // 2 pts
  consciousness: "V", // 3 pts
});
assert.ok(newsHighRisk.total_score >= 7, "High risk aggregate score should be >= 7");
assert.equal(newsHighRisk.risk_code, "HIGH");
assert.equal(newsHighRisk.has_single_red, true);

// 11d: Integration into PatientEvolutionEngine
const nisFeedWithNews = [
  {
    timestamp: new Date().toISOString(),
    temperature: 39.2,
    respiratory_rate: 26,
    spo2: 92,
    supplemental_oxygen: true,
    systolic_bp: 88,
    diastolic_bp: 55,
    heart_rate: 125,
  },
];
const evolutionNews = PatientEvolutionEngine.analyzePatientEvolution({
  patient: testPatient,
  nisFeed: nisFeedWithNews,
  rulePack: sandboxRulePack,
});

assert.ok(evolutionNews.blocks.what_changed.vitals_and_fluids.summary.includes("NEWS2早期预警评分"), "Vitals summary must include NEWS2 score");
const newsReminder = evolutionNews.blocks.rule_reminders.find((r) => r.id.includes("RULE-NEWS2"));
assert.ok(newsReminder, "NEWS2 alert must be emitted in ruleReminders when score indicates high clinical deterioration risk");

console.log("✓ Test 11 NEWS2 physiology calculation, single-red trigger, and vitals integration verified");

// ----------------------------------------------------
// 12. Test DualTrackGatingEngine RulePack Potassium & Deprecation
// ----------------------------------------------------
console.log("\n▶ [Test 12] Testing DualTrackGatingEngine RulePack Potassium & Normalization...");

const customRulePackK = {
  clinical_rules: {
    critical_values: {
      k: { low: 3.0, high: 6.0, unit: "mmol/L" },
    },
  },
};

// Obs with 6.1 mmol/L triggers critical hyperkalemia under custom 6.0 threshold
const gateRes = DualTrackGatingEngine.evaluateHardRules(
  [{ id: "k-obs-test", conceptName: "血钾", value: 6.1, unit: "mmol/L" }],
  [],
  { rulePack: customRulePackK }
);
assert.equal(gateRes.passed, false, "6.1 mmol/L must trigger critical violation when high threshold is 6.0");
assert.equal(gateRes.violations[0].code, "CRITICAL_HYPERKALEMIA");

console.log("✓ Test 12 DualTrackGatingEngine potassium threshold migrated to rulePack and evaluated properly");

// ----------------------------------------------------
// 13. Test CDS Hooks AllergyIntolerance Prefetch & Parsing
// ----------------------------------------------------
console.log("\n▶ [Test 13] Testing CDS Hooks AllergyIntolerance Prefetch & Parsing...");

assert.ok(CDS_SERVICES[0].prefetch.allergies.includes("AllergyIntolerance"), "Prefetch must contain AllergyIntolerance query");

const liveGovernance = {
  getCurrentStage: () => ({ id: "stage-live-pilot", allows_live_alerts: true }),
};

const cdsResponse = await handleCdsHookRequest(
  "medcius-patient-evolution",
  {
    hook: "patient-view",
    user: "Practitioner/doc-888",
    context: {
      userId: "doc-888",
      patientId: "pat-888",
    },
    prefetch: {
      patient: { id: "pat-888", name: [{ text: "赵六" }], birthDate: "1965-05-12", gender: "male" },
      allergies: {
        resourceType: "Bundle",
        entry: [
          {
            resource: {
              resourceType: "AllergyIntolerance",
              id: "alg-001",
              code: { text: "阿莫西林" },
              clinicalStatus: { coding: [{ code: "active" }] },
            },
          },
        ],
      },
    },
  },
  { governance: liveGovernance }
);

assert.ok(cdsResponse.cards.length > 0, "CDS Hook response must return cards for authorized clinician under live alert governance");
const cardSummaryText = cdsResponse.cards[0].detail;
assert.ok(!cardSummaryText.includes("未见明确过敏史记录"), "Prefetched AllergyIntolerance must satisfy allergy history without GAP-ALLERGY");

console.log("✓ Test 13 CDS Hooks AllergyIntolerance prefetch and parsing verified");

// ----------------------------------------------------
// 14. Test Secondary Intended Use Declarations
// ----------------------------------------------------
console.log("\n▶ [Test 14] Testing Secondary Intended Use Policy Boundaries...");

assert.ok(Array.isArray(SECONDARY_INTENDED_USES), "SECONDARY_INTENDED_USES must be exported");
assert.ok(SECONDARY_INTENDED_USES.includes("nhsa-record-quality"), "Must declare nhsa-record-quality as secondary");
assert.ok(SECONDARY_INTENDED_USES.includes("settlement-check"), "Must declare settlement-check as secondary");

console.log("✓ Test 14 Secondary Intended Use Policy Boundaries verified");

console.log("\n================================================================================");
console.log("🎉 ALL CORE FINDINGS RECTIFICATION TESTS PASSED (F-01 to F-14 VERIFIED)");
console.log("================================================================================");
