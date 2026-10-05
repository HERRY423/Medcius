// Synthetic regression cases; these checks do not validate clinical efficacy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PostHocClaimVerifier } from "../plugins/medcius/lib/post-hoc-verifier.mjs";
import { calculateNews2, HospitalDataAdapter, normalizeLabUnit } from "../plugins/medcius/lib/hospital-data-adapter.mjs";
import { PatientEvolutionEngine } from "../plugins/medcius/lib/patient-evolution-engine.mjs";

const now = "2026-10-04T12:00:00Z";
const fullVitals = { id: "nis-synthetic", timestamp: now, respiratory_rate: 16, spo2: 98, supplemental_oxygen: false, systolic_bp: 120, diastolic_bp: 80, heart_rate: 80, consciousness: "V", temperature: 37 };
const items = [
  { id: "E1", summary: "体温37℃", source_id: "n1", span: "体温37℃", presence: "positive" },
  { id: "E2", summary: "否认胸痛", source_id: "n1", span: "否认胸痛", presence: "negative" },
];
const verify = (text) => PostHocClaimVerifier.verifyClaims({ narrativeText: text, verifiableItems: items });

test("existing citation cannot validate changed numbers, units, polarity, or unrelated content", () => {
  for (const text of ["体温42℃ [E1]。", "体温37mg/dL [E1]。", "胸痛 [E2]。", "心率37次/分 [E1]。", "体温37℃且胸痛 [E1]。", "未见发热，出现胸痛 [E2]。"] ) {
    assert.equal(verify(text).is_passing, false, text);
  }
  assert.equal(verify("体温37℃ [E1]，否认胸痛 [E2]。").is_passing, true);
  assert.equal(verify("体温37℃ [E1]。").claims_detail[0].verification_basis, "exact_evidence_text");
  assert.equal(PostHocClaimVerifier.verifyClaims({ narrativeText: "3.7 mmol/L [L]", verifiableItems: [{ id: "L", summary: "7 mmol/L" }] }).is_passing, false);
});

test("heading prefixes and unrecognized prose cannot hide unverified claims", () => {
  for (const text of ["【事实】体温42℃。", "一、体温42℃。", "肾功能估算：eGFR 200。", "主诊断：疾病X。", "患者患有疾病X。", "【体温42℃】体温37℃ [E1]。", "体温37℃ [E1]。\n胸痛"] ) {
    assert.equal(verify(text).is_passing, false, text);
  }
  assert.equal(verify("【日常查房记录】").total_audited_claims, 0);
  assert.equal(verify("").is_passing, false, "empty text cannot demonstrate support");
});

test("ambiguous evidence IDs are rejected instead of last-write-wins", () => {
  assert.throws(() => PostHocClaimVerifier.verifyClaims({ narrativeText: "体温37℃ [E1]。", verifiableItems: [...items, { ...items[0], summary: "体温42℃" }] }), /DUPLICATE_EVIDENCE_ID/);
});

test("missing, invalid, and unspecified NEWS2 inputs never produce a complete risk score", () => {
  for (const input of [{}, { ...fullVitals, consciousness: null }, { ...fullVitals, supplemental_oxygen: "unknown" }, { ...fullVitals, temperature: "" }, { ...fullVitals, heart_rate: Infinity }]) {
    const result = calculateNews2(input);
    assert.equal(result.total_score, null);
    assert.equal(result.risk_code, "UNKNOWN");
    assert.equal(result.complete, false);
    assert.ok(result.missing_parameters.length > 0);
  }
});

test("NEWS2 preserves source consciousness and never mixes measurements across times", () => {
  const direct = calculateNews2(fullVitals);
  const normalized = HospitalDataAdapter.normalizeNisFeed([fullVitals]);
  assert.equal(direct.subscores.consciousness, 3);
  assert.equal(normalized.vitals_summary.news2.subscores.consciousness, 3);
  assert.equal(normalized.vitals_summary.news2.source_id, fullVitals.id);
  const split = HospitalDataAdapter.normalizeNisFeed([
    { id: "older", timestamp: "2026-10-04T11:00:00Z", temperature: 37, systolic_bp: 120, diastolic_bp: 80, heart_rate: 80 },
    { id: "newer", timestamp: now, respiratory_rate: 16, spo2: 98, supplemental_oxygen: false, consciousness: "A" },
  ]);
  assert.equal(split.vitals_summary.news2.total_score, null);
});

test("unobserved fluids remain unknown; explicitly recorded zero remains zero", () => {
  assert.equal(HospitalDataAdapter.normalizeNisFeed([fullVitals]).fluid_balance, null);
  assert.equal(HospitalDataAdapter.normalizeNisFeed([{ id: "invalid", timestamp: now, intake_ml: "", output_ml: Infinity }]).fluid_balance, null);
  const partial = HospitalDataAdapter.normalizeNisFeed([{ id: "intake", timestamp: now, intake_ml: 250 }]).fluid_balance;
  assert.equal(partial.intake_total_ml, 250);
  assert.equal(partial.output_total_ml, null);
  assert.equal(partial.net_balance_ml, null);
  const zero = HospitalDataAdapter.normalizeNisFeed([{ id: "zero", timestamp: now, intake_ml: 0, output_ml: 0 }]).fluid_balance;
  assert.equal(zero.net_balance_ml, 0);
  assert.equal(zero.urine_24h_ml, null);
});

test("invalid-time observations do not conceal earlier valid records or supply a baseline", () => {
  const result = PatientEvolutionEngine.analyzePatientEvolution({ patient: { id: "synthetic-patient" }, now,
    observations: [
      { id: "current", code: "test", value: 4, unit: "mmol/L", effective_time: now },
      { id: "future", code: "test", value: 400, unit: "mmol/L", effective_time: "2099-01-01T00:00:00Z" },
      { id: "undated", code: "test", value: 40, unit: "mmol/L" },
    ] });
  const item = result.blocks.what_changed.abnormal_labs[0];
  assert.equal(item.source_id, "current");
  assert.equal(item.delta_summary.includes("基线"), false);
  assert.ok(result.blocks.data_gaps.some((gap) => gap.gap_type === "OBSERVATION_TIME_FUTURE"));
});

test("laboratory trends require compatible units and never turn missing values into zero", () => {
  const result = PatientEvolutionEngine.analyzePatientEvolution({ patient: { id: "synthetic-patient" }, now,
    observations: [
      { id: "current", code: "test", value: 4, unit: "mmol/L", effective_time: now },
      { id: "prior", code: "test", value: 400, unit: "other", effective_time: "2026-10-04T10:00:00Z" },
      { id: "missing", code: "empty", value: null, unit: "U/L", effective_time: now, ref_low: 1, ref_high: 4 },
    ] });
  assert.equal(result.blocks.what_changed.abnormal_labs[0].trend_direction, null);
  const missing = result.blocks.what_changed.abnormal_labs.find((item) => item.source_id === "missing");
  assert.equal(missing.current_value, null);
  assert.equal(missing.is_abnormal, false);
  assert.notEqual(missing.status_label, "正常");
});

test("missing laboratory units cannot silently authorize a conversion", () => {
  assert.equal(normalizeLabUnit(88.4, "", "mg/dL", "scr").compatible, false);
  assert.equal(normalizeLabUnit(88.4, "umol/L", "", "scr").compatible, false);
  assert.equal(normalizeLabUnit(88.4, "umol/L", "mg/dL", "scr").comparableValue, 1);
  assert.equal(normalizeLabUnit(88.4, "mmol/L", "mg/dL", "scr").compatible, false);
  assert.equal(normalizeLabUnit(2.4, "mEq/L", "mmol/L", "ca").compatible, false);
});

test("reference ranges require valid boundaries and comparable units", () => {
  const result = PatientEvolutionEngine.analyzePatientEvolution({ patient: { id: "synthetic-patient" }, now,
    observations: [
      { id: "invalid-ref", code: "na", value: 140, unit: "mmol/L", ref_low: "unknown", ref_high: "unknown", effective_time: now },
      { id: "converted-ref", code: "scr", value: 2, unit: "mg/dL", referenceRange: [{ low: { value: 57, unit: "umol/L" }, high: { value: 111, unit: "umol/L" } }], effective_time: now },
      { id: "reversed-ref", code: "test", value: 5, unit: "U/L", ref_low: 9, ref_high: 1, effective_time: now },
    ] });
  const labs = result.blocks.what_changed.abnormal_labs;
  assert.equal(labs.find((item) => item.source_id === "invalid-ref").has_reference_range, false);
  assert.equal(labs.find((item) => item.source_id === "reversed-ref").has_reference_range, false);
  const converted = labs.find((item) => item.source_id === "converted-ref");
  assert.equal(converted.status_label, "⚠️ 偏高");
  assert.ok(converted.ref_high < 2);
});

test("normalization preserves missing lab values and medication instructions", () => {
  const lab = HospitalDataAdapter.normalizeLisFeed([{ code: "k", result_value: "", unit: "mmol/L", sample_time: now }]);
  assert.equal(lab.observations[0].value, null);
  assert.equal(lab.critical_values.length, 0);
  const nis = HospitalDataAdapter.normalizeNisFeed([{ id: "empty", timestamp: now, temperature: "", heart_rate: false, spo2: "", stool_count: "" }]);
  assert.equal(nis.vitals_summary.t_max, null);
  assert.equal(nis.vitals_summary.hr_avg, null);
  assert.equal(nis.vitals_summary.spo2_min, null);
  assert.equal(nis.fluid_balance, null);
  const input = [{ drug_name: "synthetic", order_type: "medication", authored_on: now }];
  const first = HospitalDataAdapter.normalizeHisOrders(input, { now: Date.parse(now) });
  const second = HospitalDataAdapter.normalizeHisOrders(input, { now: Date.parse(now) });
  assert.equal(first.medications[0].id, second.medications[0].id);
  assert.equal(first.medications[0].route, null);
  assert.equal(first.medications[0].frequency, null);
});

test("cross-source alignment does not invent abnormality, negative findings, or treatment relations", () => {
  const result = HospitalDataAdapter.alignMultiSourceTimeline({ observations: [{ id: "k-normal", name: "血钾", value: 4, unit: "mmol/L" }], medications: [{ drug_name: "阿司匹林" }] });
  assert.equal(result.find((item) => item.domain_id === "electrolytes_replenishment").lis_summary.includes("异常"), false);
  assert.equal(result.find((item) => item.domain_id === "cardiovascular_biomarkers_medication").nis_summary, "未提供相关体征记录");
});

test("P0 summary does not issue an unapproved NEWS2 clinical response instruction", () => {
  const result = PatientEvolutionEngine.analyzePatientEvolution({ patient: { id: "synthetic-patient" }, now, nisFeed: [{ ...fullVitals, spo2: 80, systolic_bp: 80 }] });
  assert.equal(result.blocks.rule_reminders.some((item) => item.id.startsWith("RULE-NEWS2")), false);
  assert.equal(JSON.stringify(result).includes("启动快速反应流程"), false);
});

test("undated and future medication changes and imaging are excluded from current changes", () => {
  const result = PatientEvolutionEngine.analyzePatientEvolution({
    patient: { id: "synthetic-patient" }, now,
    medications: [
      { id: "missing", drug_name: "synthetic-A", change_type: "added" },
      { id: "future", drug_name: "synthetic-B", change_type: "added", authored_on: "2099-01-01T00:00:00Z" },
      { id: "current", drug_name: "synthetic-C", change_type: "added", authored_on: now },
    ],
    pacsFeed: [{ id: "future-pacs", name: "synthetic-imaging", ordered_at: "2099-01-01T00:00:00Z", impression: "synthetic finding" }],
  });
  assert.deepEqual(result.blocks.what_changed.medication_diff.added.map((item) => item.source_id), ["current"]);
  assert.equal(result.blocks.what_changed.imaging_changes.length, 0);
  assert.ok(result.blocks.data_gaps.some((item) => item.gap_type === "MEDICATION_TIME_UNKNOWN"));
});
