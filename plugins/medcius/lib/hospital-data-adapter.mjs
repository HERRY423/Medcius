// Hospital Multi-Source Data Fusion & Virtual FHIR Normalizer
// Ingests: NIS (Nursing vitals & 24h fluid balance), LIS (Labs & Critical Values), PACS (Imaging & Impressions), HIS (Orders & Notes)
// Outputs: Standardized FHIR R4 Bundles & Normalized Clinical Feeds for PatientEvolutionEngine

import { loadSpecialtyRulePack } from "./specialty-rule-pack.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { classifyRecordLifecycle, lifecycleFields, resolveRecordVersions } from "./record-lifecycle.mjs";

const LEGACY_SANDBOX_RULE_PACK = loadSpecialtyRulePack("cardiology-inpatient-sandbox");

/**
 * Normalized comparison helper for clinical lab values (F-06).
 * Handles standard unit conversions (e.g. glucose mmol/L <-> mg/dL, creatinine umol/L <-> mg/dL, Hb g/L <-> g/dL).
 * Returns { comparableValue, compatible, error }
 */
export function normalizeLabUnit(val, fromUnit = "", targetUnit = "", testCode = "") {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    return { comparableValue: null, compatible: false, error: "NON_NUMERIC_VALUE" };
  }
  const cleanFrom = String(fromUnit || "").trim().toLowerCase().replace(/\s+/g, "").replace(/µ/g, "μ");
  const cleanTarget = String(targetUnit || "").trim().toLowerCase().replace(/\s+/g, "").replace(/µ/g, "μ");

  if (!cleanFrom || !cleanTarget) {
    return { comparableValue: null, compatible: false, error: "UNIT_MISSING" };
  }
  if (cleanFrom === cleanTarget) {
    return { comparableValue: val, compatible: true };
  }

  const code = String(testCode || "").toLowerCase();

  // Glucose: mmol/L <-> mg/dL (1 mmol/L = 18.018 mg/dL)
  if (code === "glu" || code.includes("glucose") || code.includes("血糖")) {
    if ((cleanFrom === "mg/dl" || cleanFrom === "mg/100ml") && cleanTarget === "mmol/l") {
      return { comparableValue: Math.round((val / 18.018) * 100) / 100, compatible: true };
    }
    if (cleanFrom === "mmol/l" && (cleanTarget === "mg/dl" || cleanTarget === "mg/100ml")) {
      return { comparableValue: Math.round(val * 18.018 * 10) / 10, compatible: true };
    }
  }

  // Creatinine: umol/L <-> mg/dL (1 mg/dL = 88.4 umol/L)
  if (code === "scr" || code.includes("creatinine") || code.includes("肌酐")) {
    const micromolar = new Set(["umol/l", "μmol/l", "umol_l"]);
    if ((cleanFrom === "mg/dl" || cleanFrom === "mg/100ml") && micromolar.has(cleanTarget)) {
      return { comparableValue: Math.round(val * 88.4 * 10) / 10, compatible: true };
    }
    if (micromolar.has(cleanFrom) && (cleanTarget === "mg/dl" || cleanTarget === "mg/100ml")) {
      return { comparableValue: Math.round((val / 88.4) * 100) / 100, compatible: true };
    }
  }

  // Hemoglobin: g/L <-> g/dL (1 g/dL = 10 g/L)
  if (code === "hgb" || code === "hb" || code.includes("hemoglobin") || code.includes("血红蛋白")) {
    if (cleanFrom === "g/dl" && cleanTarget === "g/l") {
      return { comparableValue: val * 10, compatible: true };
    }
    if (cleanFrom === "g/l" && cleanTarget === "g/dl") {
      return { comparableValue: val / 10, compatible: true };
    }
  }

  // Calcium: mmol/L <-> mg/dL (1 mmol/L = 4.0 mg/dL)
  if (code === "ca" || code.includes("calcium") || code.includes("钙")) {
    if (cleanFrom === "mg/dl" && cleanTarget === "mmol/l") {
      return { comparableValue: val / 4.0, compatible: true };
    }
    if (cleanFrom === "mmol/l" && cleanTarget === "mg/dl") {
      return { comparableValue: val * 4.0, compatible: true };
    }
  }

  // Equivalent units
  if (
    (cleanFrom === "umol/l" && cleanTarget === "μmol/l") ||
    (cleanFrom === "μmol/l" && cleanTarget === "umol/l") ||
    (cleanFrom === "umol_l" && cleanTarget === "umol/l") ||
    (/^(?:k|na|cl|potassium|sodium|chloride|钾|钠|氯|血钾|血钠|血氯)$/.test(code)
      && ((cleanFrom === "mmol/l" && cleanTarget === "meq/l") || (cleanFrom === "meq/l" && cleanTarget === "mmol/l")))
  ) {
    return { comparableValue: val, compatible: true };
  }

  // Incompatible units -> Fail closed for threshold comparison
  return {
    comparableValue: null,
    compatible: false,
    error: `UNIT_MISMATCH: Cannot reliably compare unit '${fromUnit}' with threshold unit '${targetUnit}' for '${testCode}'`,
  };
}

/**
 * Compatibility export for synthetic fixtures only. Runtime normalization does
 * not apply these values unless a rule pack is passed explicitly.
 */
export const CRITICAL_VALUE_THRESHOLDS = LEGACY_SANDBOX_RULE_PACK.clinical_rules.critical_values;

/**
 * Compatibility export for synthetic fixtures only. Hospital-approved packs
 * must replace it in production.
 */
export const RESTRICTED_ANTIBIOTICS = LEGACY_SANDBOX_RULE_PACK.clinical_rules.restricted_antibiotics.map((rule) => ({
  ...rule,
  max_recommended_days: rule.review_after_days,
}));

/**
 * Calculate eGFR via CKD-EPI 2021 equation (mL/min/1.73 m2)
 * @param {number} scr - Serum creatinine in μmol/L
 * @param {number} age - Patient age
 * @param {string} gender - '男' / '女' or 'male' / 'female'
 */
export function calculateEgfrCkdEpi(scr, age, gender) {
  if (!Number.isFinite(Number(scr)) || Number(scr) <= 0 || !Number.isFinite(Number(age)) || Number(age) < 18
    || !["男", "女", "male", "female", "M", "F"].includes(gender)) return null;
  const isFemale = gender === "女" || gender === "female" || gender === "F";
  // Convert μmol/L to mg/dL: mg/dL = μmol/L / 88.4
  const scrMgDl = scr / 88.4;
  const kappa = isFemale ? 0.7 : 0.9;
  const alpha = isFemale ? -0.241 : -0.302;
  const genderMult = isFemale ? 1.012 : 1.0;

  const scrRatio = scrMgDl / kappa;
  const minPart = Math.min(scrRatio, 1) ** alpha;
  const maxPart = Math.max(scrRatio, 1) ** -1.2;
  const agePart = 0.9938 ** age;

  const egfr = 142 * minPart * maxPart * agePart * genderMult;
  return Math.round(egfr * 10) / 10;
}

/**
 * Standard National Early Warning Score 2 (NEWS2) Calculator.
 * Evaluates 6 core physiological parameters (respiration rate, SpO2, supplemental oxygen, systolic BP, heart rate, consciousness, temperature).
 * @param {object} vitals
 * @param {number|null} [vitals.respiration_rate] - Breaths per minute
 * @param {number|null} [vitals.spo2] - Oxygen saturation percentage (Scale 1)
 * @param {boolean|string|null} [vitals.supplemental_oxygen] - Whether receiving oxygen therapy
 * @param {number|null} [vitals.systolic_bp] - Systolic blood pressure (mmHg)
 * @param {number|null} [vitals.heart_rate] - Heart rate / pulse (bpm)
 * @param {string|null} [vitals.consciousness] - Alert (A) vs Voice/Pain/Unresponsive (V/P/U)
 * @param {number|null} [vitals.temperature] - Body temperature (°C)
 * @returns {object} { score, risk_level, single_trigger_red, subscores, missing_parameters }
 */
export function calculateNews2({
  respiration_rate = null,
  respiratory_rate = null,
  spo2 = null,
  supplemental_oxygen = null,
  systolic_bp = null,
  sbp = null,
  heart_rate = null,
  hr = null,
  consciousness = null,
  temperature = null,
  t = null,
} = {}) {
  const subscores = {};
  const missing = [];
  let totalScore = 0;
  let singleRed = false;

  const actualRr = respiration_rate ?? respiratory_rate;
  const actualSbp = systolic_bp ?? sbp;
  const actualHr = heart_rate ?? hr;
  const actualTemp = temperature ?? t;
  const numeric = (value) => value != null && value !== "" && typeof value !== "boolean"
    && (typeof value !== "string" || value.trim() !== "") && Number.isFinite(Number(value));

  // 1. Respiration Rate (breaths/min)
  if (numeric(actualRr)) {
    const rr = Number(actualRr);
    let s = 0;
    if (rr <= 8) s = 3;
    else if (rr <= 11) s = 1;
    else if (rr <= 20) s = 0;
    else if (rr <= 24) s = 2;
    else s = 3;
    subscores.respiration_rate = s;
    totalScore += s;
    if (s === 3) singleRed = true;
  } else {
    missing.push("respiration_rate");
  }

  // 2. Oxygen Saturation (SpO2, Scale 1)
  if (numeric(spo2) && Number(spo2) >= 0 && Number(spo2) <= 100) {
    const sp = Number(spo2);
    let s = 0;
    if (sp <= 91) s = 3;
    else if (sp <= 93) s = 2;
    else if (sp <= 95) s = 1;
    else s = 0;
    subscores.spo2 = s;
    totalScore += s;
    if (s === 3) singleRed = true;
  } else {
    missing.push("spo2");
  }

  // 3. Supplemental Oxygen (Air vs Oxygen)
  const oxygen = typeof supplemental_oxygen === "boolean" ? supplemental_oxygen
    : /^(?:true|yes|吸氧|面罩|鼻导管|oxygen|o2|文丘里|高流量)$/i.test(String(supplemental_oxygen).trim()) ? true
      : /^(?:false|no|air|room air|空气|未吸氧)$/i.test(String(supplemental_oxygen).trim()) ? false : null;
  if (oxygen != null) {
    const isO2 = oxygen;
    const s = isO2 ? 2 : 0;
    subscores.supplemental_oxygen = s;
    totalScore += s;
  } else {
    missing.push("supplemental_oxygen");
  }

  // 4. Systolic Blood Pressure (mmHg)
  if (numeric(actualSbp)) {
    const bpVal = Number(actualSbp);
    let s = 0;
    if (bpVal <= 90) s = 3;
    else if (bpVal <= 100) s = 2;
    else if (bpVal <= 110) s = 1;
    else if (bpVal <= 219) s = 0;
    else s = 3;
    subscores.systolic_bp = s;
    totalScore += s;
    if (s === 3) singleRed = true;
  } else {
    missing.push("systolic_bp");
  }

  // 5. Heart Rate (beats/min)
  if (numeric(actualHr)) {
    const hrVal = Number(actualHr);
    let s = 0;
    if (hrVal <= 40) s = 3;
    else if (hrVal <= 50) s = 1;
    else if (hrVal <= 90) s = 0;
    else if (hrVal <= 110) s = 1;
    else if (hrVal <= 130) s = 2;
    else s = 3;
    subscores.heart_rate = s;
    totalScore += s;
    if (s === 3) singleRed = true;
  } else {
    missing.push("heart_rate");
  }

  // 6. Consciousness (AVPU)
  const cStr = String(consciousness ?? "").trim().toUpperCase();
  const isAltered = /^(?:C|V|P|U|NEW CONFUSION|VOICE|PAIN|UNRESPONSIVE|ALTERED|昏迷|嗜睡|微弱|昏睡|躁动|新发谵妄|谵妄)$/.test(cStr);
  const isAlert = /^(?:A|ALERT|清醒|神志清楚)$/.test(cStr);
  if (isAltered || isAlert) {
    const s = isAltered ? 3 : 0;
    subscores.consciousness = s;
    totalScore += s;
    if (s === 3) singleRed = true;
  } else {
    missing.push("consciousness");
  }

  // 7. Temperature (°C)
  if (numeric(actualTemp)) {
    const tVal = Number(actualTemp);
    let s = 0;
    if (tVal <= 35.0) s = 3;
    else if (tVal <= 36.0) s = 1;
    else if (tVal <= 38.0) s = 0;
    else if (tVal <= 39.0) s = 1;
    else s = 2;
    subscores.temperature = s;
    totalScore += s;
    if (s === 3) singleRed = true;
  } else {
    missing.push("temperature");
  }

  if (missing.length) {
    return {
      score: null, total_score: null, risk_level: "资料不足", risk_code: "UNKNOWN", risk_category: "资料不足",
      complete: false, single_trigger_red: null, has_single_red: null,
      subscores, components: subscores, missing_parameters: missing,
      clinical_alerts_enabled: false,
    };
  }

  // Risk Classification according to Royal College of Physicians NEWS2
  let riskLevel = "低风险 (Low)";
  let riskCode = "LOW";
  if (totalScore >= 7) {
    riskLevel = "高风险 (High)";
    riskCode = "HIGH";
  } else if (totalScore >= 5 || singleRed) {
    riskLevel = singleRed ? "中等风险 (单项红色警示 3分)" : "中等风险 (Medium)";
    riskCode = singleRed ? "LOW-MEDIUM" : "MEDIUM";
  }

  return {
    complete: true,
    clinical_alerts_enabled: false,
    score: totalScore,
    total_score: totalScore,
    risk_level: riskLevel,
    risk_code: riskCode,
    risk_category: riskLevel,
    single_trigger_red: singleRed,
    has_single_red: singleRed,
    subscores,
    components: subscores,
    missing_parameters: missing,
  };
}

export class HospitalDataAdapter {
  /**
   * 1. Normalize NIS (Nursing Info System) Vital Signs and 24h Fluid Balance
   * Enhanced: supports explicit cutoffTime/now window filtering (F-05) and deterministic hashing IDs (F-14).
   */
  static normalizeNisFeed(nisFeed = [], { rulePack = null, cutoffTime = null, now = null } = {}) {
    if (!Array.isArray(nisFeed) || nisFeed.length === 0) {
      return { vitals_summary: null, fluid_balance: null, fhir_observations: [], discarded_outside_window_count: 0 };
    }
    nisFeed = resolveRecordVersions(nisFeed, { sourceType: "nursing", now: now ?? new Date(), cutoffTime }).current_records
      .filter((record) => !["cancelled", "entered_in_error"].includes(classifyRecordLifecycle(record, { sourceType: "nursing", now: now ?? new Date() }).result_status))
      .map((record) => ({ ...record, timestamp: record.event_time || record.timing?.t_event || record.timestamp || null }));
    if (!nisFeed.length) return { vitals_summary: null, fluid_balance: null, fhir_observations: [], discarded_outside_window_count: 0 };

    const cutoffMs = cutoffTime != null ? (typeof cutoffTime === "number" ? cutoffTime : new Date(cutoffTime).getTime()) : null;
    const nowMs = now != null ? (typeof now === "number" ? now : new Date(now).getTime()) : null;

    let tMax = -Infinity;
    let tMin = Infinity;
    let peakBpReading = null; // { s, d, timestamp }
    let nadirBpReading = null; // { s, d, timestamp }
    let spo2Min = Infinity;
    let hrSum = 0;
    let hrCount = 0;
    let latestVitalsRecord = null;
    let latestVitalsTime = -Infinity;

    let intakeTotal = 0;
    let outputTotal = 0;
    let urineTotal = 0;
    let drainTotal = 0;
    let stoolCount = 0;
    const recorded = { intake: false, output: false, urine: false, drain: false, stool: false };
    const isRecordedNumber = (value) => value != null && typeof value !== "boolean" && String(value).trim() !== "" && Number.isFinite(Number(value));
    const drainDetails = [];
    const fhirObservations = [];
    let discardedCount = 0;

    for (const record of nisFeed) {
      // Time-window filtering (F-05)
      if (cutoffMs != null) {
        const rTime = record.timestamp ? new Date(record.timestamp).getTime() : null;
        if (rTime == null || isNaN(rTime) || rTime < cutoffMs || (nowMs != null && rTime > nowMs)) {
          discardedCount++;
          continue;
        }
      }

      // Score one source measurement only. Window extrema and averages belong
      // to the trend display and must not be combined into a fictitious NEWS2.
      const measuredAt = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
      const hasVitals = ["temperature", "systolic_bp", "heart_rate", "spo2", "respiratory_rate", "rr", "consciousness", "avpu"].some((key) => record[key] != null);
      if (hasVitals && Number.isFinite(measuredAt) && measuredAt > latestVitalsTime && (nowMs == null || measuredAt <= nowMs)) {
        latestVitalsRecord = record;
        latestVitalsTime = measuredAt;
      }

      // Temperature (°C)
      if (isRecordedNumber(record.temperature)) {
        const t = Number(record.temperature);
        if (t > tMax) tMax = t;
        if (t < tMin) tMin = t;
        const detTempId = record.id || `obs-nis-temp-${sha256Hex(`nis:temp:${record.timestamp || ''}:${t}`).slice(0, 10)}`;
        fhirObservations.push({
          resourceType: "Observation",
          id: detTempId,
          code: { coding: [{ system: "http://loinc.org", code: "8310-5", display: "Body temperature" }] },
          valueQuantity: { value: t, unit: "°C" },
          effectiveDateTime: record.timestamp,
        });
      }

      // Blood Pressure (mmHg) - Track authentic paired readings from the same measurement event
      if (isRecordedNumber(record.systolic_bp) && isRecordedNumber(record.diastolic_bp)) {
        const s = Number(record.systolic_bp);
        const d = Number(record.diastolic_bp);
        if (!Number.isNaN(s) && !Number.isNaN(d)) {
          // Track peak BP measurement (highest systolic, tie-breaker: diastolic)
          if (!peakBpReading || s > peakBpReading.s || (s === peakBpReading.s && d > peakBpReading.d)) {
            peakBpReading = { s, d, timestamp: record.timestamp };
          }
          // Track nadir BP measurement (lowest systolic, tie-breaker: diastolic)
          if (!nadirBpReading || s < nadirBpReading.s || (s === nadirBpReading.s && d < nadirBpReading.d)) {
            nadirBpReading = { s, d, timestamp: record.timestamp };
          }
        }
      }

      // Heart Rate / Pulse (bpm)
      if (isRecordedNumber(record.heart_rate)) {
        hrSum += Number(record.heart_rate);
        hrCount++;
      }

      // SpO2 (%)
      if (isRecordedNumber(record.spo2)) {
        const sp = Number(record.spo2);
        if (sp < spo2Min) spo2Min = sp;
      }

      // Fluid Intake (ml) - Mutually exclusive accumulation to prevent double counting
      const hasOral = isRecordedNumber(record.oral_intake_ml);
      const hasIv = isRecordedNumber(record.iv_intake_ml);
      const hasTotalIntake = isRecordedNumber(record.intake_ml);

      if (hasOral || hasIv) {
        recorded.intake = true;
        intakeTotal += (hasOral ? Number(record.oral_intake_ml) : 0) + (hasIv ? Number(record.iv_intake_ml) : 0);
      } else if (hasTotalIntake) {
        recorded.intake = true;
        intakeTotal += Number(record.intake_ml);
      }

      // Fluid Output (ml) - Prevent double counting of sub-items and total output
      const hasUrine = isRecordedNumber(record.urine_output_ml);
      const hasDrain = isRecordedNumber(record.drain_output_ml);
      const hasTotalOutput = isRecordedNumber(record.output_ml);

      if (hasUrine) {
        recorded.output = true;
        recorded.urine = true;
        const u = Number(record.urine_output_ml);
        outputTotal += u;
        urineTotal += u;
      }
      if (hasDrain) {
        recorded.output = true;
        recorded.drain = true;
        const dr = Number(record.drain_output_ml);
        outputTotal += dr;
        drainTotal += dr;
        if (record.drain_name) {
          drainDetails.push({ name: record.drain_name, amount_ml: dr, description: record.drain_desc || "引流液" });
        }
      }
      if (!hasUrine && !hasDrain && hasTotalOutput) {
        recorded.output = true;
        outputTotal += Number(record.output_ml);
      }
      if (isRecordedNumber(record.stool_count)) {
        recorded.stool = true;
        stoolCount += Number(record.stool_count);
      }
    }

    const allDiscarded = cutoffMs != null && nisFeed.length > 0 && discardedCount === nisFeed.length;
    if (allDiscarded) {
      return {
        vitals_summary: null,
        fluid_balance: null,
        fhir_observations: [],
        discarded_outside_window_count: discardedCount,
        data_gaps: [{
          gap_type: "NIS_WINDOW_EMPTY",
          severity: "MEDIUM",
          title: "窗口内无护理记录",
          summary: "护理记录缺少时间，或全部落在当前窗口之外，未生成当前生命体征摘要。",
          source_type: "NursingRecord",
          source_id: null,
        }],
      };
    }

    const news2 = {
      ...calculateNews2({
        ...(latestVitalsRecord || {}),
        respiratory_rate: latestVitalsRecord?.respiratory_rate ?? latestVitalsRecord?.rr,
        supplemental_oxygen: latestVitalsRecord?.supplemental_oxygen ?? latestVitalsRecord?.oxygen ?? latestVitalsRecord?.o2,
        consciousness: latestVitalsRecord?.consciousness ?? latestVitalsRecord?.avpu,
      }),
      source_id: latestVitalsRecord?.id || null,
      timestamp: latestVitalsRecord?.timestamp || null,
      calculation_basis: "single_source_record",
    };

    const vitalsSummary = {
      t_max: tMax === -Infinity ? null : tMax,
      t_min: tMin === Infinity ? null : tMin,
      bp_max: peakBpReading ? `${peakBpReading.s}/${peakBpReading.d} mmHg` : null,
      bp_min: nadirBpReading ? `${nadirBpReading.s}/${nadirBpReading.d} mmHg` : null,
      hr_avg: hrCount > 0 ? Math.round(hrSum / hrCount) : null,
      spo2_min: spo2Min === Infinity ? null : `${spo2Min}%`,
      news2,
    };

    const netBalance = recorded.intake && recorded.output ? intakeTotal - outputTotal : null;
    const fluidThresholds = rulePack?.clinical_rules?.ward_thresholds?.fluid_balance_net_ml;
    let fluidStatus = netBalance == null ? "出入量资料不完整，无法计算净平衡" : "已记录（未配置专科判断阈值）";
    if (fluidThresholds && netBalance != null) {
      if (netBalance > fluidThresholds.high_attention_above) {
        fluidStatus = `触发规则包净正平衡关注边界 (> ${fluidThresholds.high_attention_above} ml)`;
      } else if (netBalance < fluidThresholds.low_attention_below) {
        fluidStatus = `触发规则包净负平衡关注边界 (< ${fluidThresholds.low_attention_below} ml)`;
      } else {
        fluidStatus = "未触发规则包液体平衡关注边界";
      }
    }
    const fluidBalance = {
      intake_total_ml: recorded.intake ? intakeTotal : null,
      output_total_ml: recorded.output ? outputTotal : null,
      net_balance_ml: netBalance,
      net_balance_label: netBalance == null ? "资料不足" : `${netBalance >= 0 ? "+" : ""}${netBalance} ml`,
      urine_24h_ml: recorded.urine ? urineTotal : null,
      drain_24h_ml: recorded.drain ? drainTotal : null,
      stool_24h_count: recorded.stool ? stoolCount : null,
      recorded_components: recorded,
      drain_details: drainDetails,
      status: fluidStatus,
      rule_pack_id: rulePack?.pack_id || null,
      window_filtered: cutoffMs != null,
      discarded_outside_window_count: discardedCount,
      aggregation_window: cutoffMs != null ? {
        cutoff_time: new Date(cutoffMs).toISOString(),
        end_time: nowMs ? new Date(nowMs).toISOString() : null,
      } : null,
    };

    return {
      vitals_summary: vitalsSummary,
      fluid_balance: Object.values(recorded).some(Boolean) ? fluidBalance : null,
      fhir_observations: fhirObservations,
      discarded_outside_window_count: discardedCount,
    };
  }

  /**
   * 2. Normalize LIS (Laboratory Info System) and Detect Critical Values
   * Enhanced:
   * - No new Date() fabrication when timestamp is missing (F-04)
   * - Unit-aware critical value comparison with fail-closed DATA_GAP (F-06)
   * - Deterministic ID generation (F-14)
   */
  static normalizeLisFeed(lisFeed = [], { rulePack = null, cutoffTime = null, now = null } = {}) {
    if (!Array.isArray(lisFeed)) return { observations: [], critical_values: [], data_gaps: [] };

    const observations = [];
    const historyRecords = [];
    const criticalValues = [];
    const dataGaps = [];

    const cutoffMs = cutoffTime != null ? (typeof cutoffTime === "number" ? cutoffTime : new Date(cutoffTime).getTime()) : null;
    const nowMs = now != null ? (typeof now === "number" ? now : new Date(now).getTime()) : null;

    for (const item of lisFeed) {
      const codeKey = (item.code || item.test_code || "").toLowerCase();
      const rawValue = item.value ?? item.result_value;
      const val = rawValue == null || typeof rawValue === "boolean" || String(rawValue).trim() === "" ? NaN : Number(rawValue);
      const unit = item.unit || "";
      const reportName = item.report_name || item.test_name || "检验报告";

      // F-04: Do NOT fabricate timestamp with new Date(). Respect actual timestamp or mark missing.
      const rawSampleTime = item.effective_time || item.sample_time || null;
      const sampleTime = rawSampleTime;
      const historyRecord = {
        ...item, ...lifecycleFields(item),
        id: item.id || `obs-lis-${sha256Hex(`${codeKey}:${val}:${unit}:${sampleTime || 'no-time'}`).slice(0, 12)}`,
        code: codeKey, value: Number.isFinite(val) ? val : null, unit,
        name: item.name || item.test_name || item.code || null,
        effective_time: sampleTime, status: item.status || item.result_status || null,
        resulted_at: item.resulted_at || item.issued || null,
      };
      historyRecords.push(historyRecord);

      // Check time window if cutoffTime is provided
      if (cutoffMs != null) {
        const sTimeMs = sampleTime ? new Date(sampleTime).getTime() : null;
        if (sTimeMs == null || isNaN(sTimeMs) || sTimeMs < cutoffMs || (nowMs != null && sTimeMs > nowMs)) {
          // If timestamp is absent, record data gap and exclude from recent window
          if (sTimeMs == null || isNaN(sTimeMs)) {
            dataGaps.push({
              code: codeKey,
              name: reportName,
              value: val,
              unit,
              reason: "LIS_SAMPLE_TIME_MISSING: 采样时间缺失，依据安全契约禁止伪造时间，已记录资料缺口并排除于新近时间窗计算",
            });
          }
          continue;
        }
      }

      let isCritical = false;
      let criticalReason = null;

      // F-06: Unit-aware comparison with fail-closed safety
      const thresh = rulePack?.clinical_rules?.critical_values?.[codeKey];
      if (thresh && !isNaN(val)) {
        const normResult = normalizeLabUnit(val, unit, thresh.unit, codeKey);
        if (normResult.compatible && normResult.comparableValue != null) {
          const compVal = normResult.comparableValue;
          if (thresh.low != null && compVal <= thresh.low) {
            isCritical = true;
            criticalReason = `低于危急值下限 (≤ ${thresh.low} ${thresh.unit}): ${thresh.danger_hint}`;
          } else if (thresh.high != null && compVal >= thresh.high) {
            isCritical = true;
            criticalReason = `高于危急值上限 (≥ ${thresh.high} ${thresh.unit}): ${thresh.danger_hint}`;
          }
        } else if (!normResult.compatible) {
          // Incompatible units -> Fail closed: do not miscalculate critical threshold, generate DATA_GAP
          dataGaps.push({
            code: codeKey,
            name: reportName,
            value: val,
            unit: unit,
            expected_unit: thresh.unit,
            reason: `CRITICAL_VALUE_UNIT_INCOMPATIBLE: ${normResult.error}. 数值未做盲目比对，已上报资料缺口`,
          });
        }
      }

      // Explicit LIS flag override
      if (item.is_critical_reported || item.is_critical) {
        isCritical = true;
        if (!criticalReason) criticalReason = "LIS 实验室系统上报危急值警报";
      }

      // F-14: Deterministic ID generation using content digest
      const detId = item.id || `obs-lis-${sha256Hex(`${codeKey}:${val}:${unit}:${sampleTime || 'no-time'}`).slice(0, 12)}`;

      const obsObj = {
        ...lifecycleFields(item),
        id: detId,
        name: item.name || item.test_name || thresh?.name || item.code,
        code: codeKey || item.code,
        value: Number.isFinite(val) ? val : null,
        unit: unit,
        effective_time: sampleTime,
        timestamp_status: sampleTime ? "VALID" : "MISSING",
        report_name: reportName,
        referenceRange: item.referenceRange || (item.reference_range_text ? [{ text: item.reference_range_text }] : []),
        ref_low: item.ref_low ?? null,
        ref_high: item.ref_high ?? null,
        ref_text: item.ref_text ?? null,
        reference_range: item.reference_range ?? null,
        reference_range_text: item.reference_range_text ?? null,
        is_critical: isCritical,
        critical_reason: criticalReason,
        span: item.span || null,
        status: item.status || item.result_status || null,
        priority: item.priority || item.urgency || null,
        order_id: item.order_id || item.service_request_id || null,
        collected_at: item.collected_at || item.specimen_received_at || item.sample_time || null,
        resulted_at: item.resulted_at || item.issued || null,
        acknowledged_at: item.acknowledged_at || null,
        _source: item._source || null,
      };

      observations.push(obsObj);
      Object.assign(historyRecord, obsObj);

      const lifecycle = classifyRecordLifecycle(obsObj, { sourceType: "observation", now: now ?? new Date(), cutoffTime });
      if (isCritical && !["cancelled", "entered_in_error"].includes(lifecycle.result_status)) {
        criticalValues.push({
          observation_id: obsObj.id,
          version_id: lifecycle.version_id,
          result_status: lifecycle.result_status,
          name: obsObj.name,
          value: obsObj.value,
          unit: obsObj.unit,
          report_name: reportName,
          sample_time: sampleTime,
          reason: criticalReason,
          urgency_action: "按医院批准的危急值制度完成临床确认与闭环；本插件仅追踪阶段，不给出处置建议",
          acknowledged_at: item.acknowledged_at || null,
          order_id: item.order_id || item.service_request_id || null,
        });
      }
    }

    const current = resolveRecordVersions(historyRecords, { sourceType: "observation", now: now ?? new Date(), cutoffTime }).current_records;
    const currentCritical = criticalValues.filter((value) => current.some((record) => record.id === value.observation_id
      && (record.version_id ?? record.meta?.versionId ?? null) === value.version_id
      && !["cancelled", "entered_in_error"].includes(classifyRecordLifecycle(record, { now: now ?? new Date() }).result_status)));
    return { observations, history_records: historyRecords, critical_values: currentCritical, data_gaps: dataGaps };
  }

  /**
   * 3. Normalize PACS (Imaging System) Reports and Extract Comparative Impressions
   */
  static normalizePacsFeed(pacsFeed = [], { cutoffTime = null, now = null } = {}) {
    if (!Array.isArray(pacsFeed)) return { diagnostic_reports: [], imaging_impressions: [] };

    const diagnosticReports = [];
    const imagingImpressions = [];
    const timeGaps = [];

    for (const item of pacsFeed) {
      const modality = item.modality || "影像检查";
      const name = item.name || item.study_name || `${modality} 检查`;
      const status = item.status || item.report_status || null;
      const orderedRaw = item.ordered_at || null;
      const orderedKnown = orderedRaw != null && orderedRaw !== "" && Number.isFinite(new Date(orderedRaw).getTime());
      const orderedAt = orderedKnown ? orderedRaw : null;
      const studyRaw = item.study_time || item.effectiveDateTime || item.effective_time || item.event_time || null;
      const studyKnown = studyRaw != null && studyRaw !== "" && Number.isFinite(new Date(studyRaw).getTime());
      const studyAt = studyKnown ? studyRaw : null;
      const impression = item.impression || item.impression_text || item.findings || "";

      diagnosticReports.push({
        ...lifecycleFields(item),
        id: item.id || `pacs-rep-${sha256Hex(`${modality}:${name}:${orderedAt}:${impression}`).slice(0, 12)}`,
        name: name,
        modality: modality,
        status: status,
        ordered_at: orderedAt,
        study_time: studyAt,
        event_time: item.event_time || studyAt,
        impression: impression,
        code: item.code || item.study_code || null,
        priority: item.priority || item.urgency || null,
        order_id: item.order_id || item.service_request_id || item.based_on_id || null,
        scheduled_time: item.scheduled_time || null,
        resulted_at: item.resulted_at || item.issued || null,
        acknowledged_at: item.acknowledged_at || null,
        _source: item._source || null,
      });

    }

    const currentReports = resolveRecordVersions(diagnosticReports, { sourceType: "diagnostic_report", now: now ?? new Date(), cutoffTime }).current_records;
    for (const report of currentReports) {
      const lifecycle = classifyRecordLifecycle(report, { sourceType: "diagnostic_report", now: now ?? new Date(), cutoffTime });
      if (["unknown", "invalid"].includes(lifecycle.event_time_status)) {
        timeGaps.push({
          gap_type: "IMAGING_TIME_UNKNOWN",
          severity: "MEDIUM",
          title: "影像时间未知",
          summary: `${report.name} 缺少可确认的检查时间，开单时间不能代替检查时间，印象未纳入当前窗口。`,
          source_type: "DiagnosticReport",
          source_id: report.id || null,
        });
      } else if (report.impression && ["final", "preliminary", "revised"].includes(lifecycle.result_status)
        && lifecycle.event_time_status === "in_window") {
        imagingImpressions.push({
          id: report.id,
          ordered_at: report.ordered_at,
          study_time: report.study_time,
          event_time: lifecycle.event_time,
          report_name: report.name,
          status: report.status,
          version_id: report.version_id ?? report.meta?.versionId ?? null,
          impression_summary: report.impression.trim(),
        });
      }
    }

    return { diagnostic_reports: diagnosticReports, history_records: diagnosticReports,
      current_diagnostic_reports: currentReports, imaging_impressions: imagingImpressions, time_gaps: timeGaps };
  }

  /**
   * 4. Normalize HIS (Hospital Info System) Orders & Track Antibiotic Durations
   */
  static normalizeHisOrders(ordersFeed = [], { rulePack = null, now = Date.now() } = {}) {
    if (!Array.isArray(ordersFeed)) return { medications: [], orders: [], antibiotic_alerts: [] };

    const medications = [];
    const orders = [];
    const antibioticAlerts = [];
    const timeGaps = [];
    const antibioticRules = rulePack?.clinical_rules?.restricted_antibiotics || [];
    const nowMs = new Date(now).getTime();
    const isMedication = item => item.is_medication || item.drug_name;
    const selectedMedications = new Set(resolveRecordVersions(ordersFeed.filter(isMedication), { sourceType: "medication", now }).current_records);
    const selectedOrders = new Set(resolveRecordVersions(ordersFeed.filter(item => !isMedication(item)), { sourceType: "order", now }).current_records);
    const currentMedications = [];
    const currentOrders = [];

    for (const item of ordersFeed) {
      if (item.is_medication || item.drug_name) {
        const drugName = item.drug_name || item.name;
        const authoredRaw = item.authored_on || item.start_time || null;
        const authoredMs = authoredRaw == null ? NaN : new Date(authoredRaw).getTime();
        const authoredFuture = Number.isFinite(authoredMs) && authoredMs > nowMs;
        const authoredKnown = Number.isFinite(authoredMs) && !authoredFuture;
        const activeStatus = String(item.status ?? item.result_status ?? "").trim().toLowerCase() === "active";
        const endTime = item.end_date ?? item.stopped_at ?? null;
        const endMs = endTime == null || endTime === "" ? null : new Date(endTime).getTime();
        const isCurrentActive = selectedMedications.has(item) && activeStatus && (endMs == null || Number.isFinite(endMs) && endMs > nowMs);
        if (!authoredKnown) {
          timeGaps.push({
            gap_type: authoredFuture ? "ORDER_TIME_FUTURE" : "ORDER_TIME_UNKNOWN",
            severity: "MEDIUM",
            title: "医嘱时间未知",
            summary: `${drugName || "医嘱"} 的开立时间不可用，未推算抗菌药物使用时长。`,
            source_type: "MedicationRequest",
            source_id: item.id || null,
          });
          medications.push({
            ...lifecycleFields(item),
            id: item.id || `med-his-undated-${sha256Hex(`${drugName || ""}:${item.dosage || ""}`).slice(0, 12)}`,
            drug_name: drugName,
            dosage: item.dosage || "",
            route: item.route || null,
            frequency: item.frequency || null,
            change_type: item.change_type || null,
            status: item.status || null,
            previous_dosage: item.previous_dosage,
            authored_on: authoredRaw,
            stop_reason: item.stop_reason,
            antibiotic_info: null,
            _source: item._source || null,
          });
          if (isCurrentActive) currentMedications.push(medications.at(-1));
          continue;
        }
        const authoredOn = authoredRaw;
        const startTimestamp = new Date(authoredOn).getTime();
        const durationDays = Math.max(1, Math.ceil((nowMs - startTimestamp) / (24 * 3600000)));

        // Check if restricted/special antibiotic
        const matchAnti = antibioticRules.find((a) => String(drugName || "").includes(a.name));
        let antiInfo = null;

        if (matchAnti && isCurrentActive) {
          const reviewAfterDays = matchAnti.review_after_days;
          const isOverdue = Number.isFinite(reviewAfterDays) ? durationDays >= reviewAfterDays : null;
          antiInfo = {
            drug_name: drugName,
            class: matchAnti.class,
            level: matchAnti.level,
            duration_days: durationDays,
            duration_basis: "elapsed_since_order_authored_not_administration",
            review_after_days: reviewAfterDays ?? null,
            is_overdue: isOverdue,
            alert_message: `【${matchAnti.level}】${drugName}的来源医嘱仍标记有效，距开立第 ${durationDays} 天，实际给药天数未确认。${isOverdue === true ? "已达到院内规则包配置的复核时间点，需由临床团队复核。" : isOverdue === false ? "尚未达到规则包复核时间点。" : "规则包复核时间点未提供。"}`,
          };
          antibioticAlerts.push(antiInfo);
        }

        medications.push({
          ...lifecycleFields(item),
          id: item.id || `med-his-${sha256Hex(canonicalJson(item)).slice(0, 16)}`,
          drug_name: drugName,
          dosage: item.dosage || "",
          route: item.route || null,
          frequency: item.frequency || null,
          change_type: item.change_type || null,
          status: item.status || null,
          previous_dosage: item.previous_dosage,
          authored_on: authoredOn,
          stop_reason: item.stop_reason,
          antibiotic_info: antiInfo,
          _source: item._source || null,
        });
        if (isCurrentActive) currentMedications.push(medications.at(-1));
      } else {
        orders.push({
          ...lifecycleFields(item),
          id: item.id || `ord-his-${sha256Hex(canonicalJson(item)).slice(0, 16)}`,
          title: item.title || item.name,
          order_type: item.order_type || "general",
          department: item.department,
          purpose: item.purpose,
          status: item.status || null,
          scheduled_time: item.scheduled_time || null,
          code: item.code || item.order_code || null,
          priority: item.priority || item.urgency || item.order_priority || null,
          authored_on: item.authored_on || item.ordered_at || null,
          collected_at: item.collected_at || null,
          resulted_at: item.resulted_at || null,
          acknowledged_at: item.acknowledged_at || null,
          _source: item._source || null,
        });
        if (selectedOrders.has(item)) currentOrders.push(orders.at(-1));
      }
    }

    return { medications, orders, history_records: [...medications, ...orders], current_medications: currentMedications,
      current_orders: currentOrders, antibiotic_alerts: antibioticAlerts, time_gaps: timeGaps };
  }

  /**
   * 5. Structured Multi-Source Priority Alignment (结构化多源临床对齐图谱)
   * Correlates NIS vitals/fluids, LIS lab trends/criticals, PACS imaging impressions, and HIS orders
   * into cohesive clinical domains without forcing doctors to mentally reconstruct cross-system streams.
   */
  static alignMultiSourceTimeline({
    vitalsSummary = null,
    fluidBalance = null,
    observations = [],
    criticalValues = [],
    diagnosticReports = [],
    medications = [],
    orders = [],
    patient = {},
    rulePack = null,
  } = {}) {
    const alignments = [];
    const statusLabel = (record, sourceType = "observation") => ({ final: "正式结果", preliminary: "初步结果", revised: "修订结果", unknown: "来源状态未知" })[
      classifyRecordLifecycle(record, { sourceType }).result_status] || "来源阶段待核对";
    const labText = (record, label = record.name || record.code) => `${label}: ${record.value ?? "数值未知"} ${record.unit || "单位未提供"}（${statusLabel(record)}）`;

    // Helper: find observations by keyword
    const findObs = (kw) => {
      const target = kw.toLowerCase();
      return observations.filter((o) => {
        const code = String(o.code || "").toLowerCase();
        const name = String(o.name || "").toLowerCase();
        return code.includes(target) || name.includes(target);
      });
    };

    // Helper: find medications by keyword
    const findMeds = (kw) => {
      return medications.filter((m) => {
        const dName = String(m.drug_name || m.medication || "").toLowerCase();
        return dName.includes(kw.toLowerCase());
      });
    };

    // --- Domain 1: 液体平衡 - 肾功能 - 血压 - 利尿对齐 (Fluid / Renal / Hemodynamics) ---
    const scrObs = [...new Set([...findObs("肌酐"), ...findObs("scr"), ...findObs("creatinine")])];
    const diuretics = medications.filter((m) => {
      const d = String(m.drug_name || m.medication || "");
      return /呋塞米|托拉塞米|螺内酯|氢氯噻嗪|布美他尼|重组人脑利钠肽|新活素/.test(d);
    });
    const vasoactives = medications.filter((m) => {
      const d = String(m.drug_name || m.medication || "");
      return /硝普钠|硝酸甘油|去甲肾上腺素|多巴胺|肾上腺素|硝苯地平|美托洛尔|比索洛尔|卡维地洛/.test(d);
    });

    const hasFluid = fluidBalance != null;
    const hasScr = scrObs.length > 0;
    const hasDiuretic = diuretics.length > 0;
    const hasVaso = vasoactives.length > 0;

    if (hasFluid || hasScr || hasDiuretic || hasVaso) {
      const nisParts = [];
      if (fluidBalance) {
        nisParts.push(`24h入量 ${fluidBalance.intake_total_ml ?? "未提供"}ml, 出量 ${fluidBalance.output_total_ml ?? "未提供"}ml (尿量 ${fluidBalance.urine_24h_ml ?? "未提供"}ml), 净平衡 ${fluidBalance.net_balance_label}`);
      }
      if (vitalsSummary?.bp_max) {
        nisParts.push(`血压极值: ${vitalsSummary.bp_max} ~ ${vitalsSummary.bp_min || ""}`);
      }

      const lisParts = [];
      if (scrObs.length > 0) {
        const latestScr = scrObs[0];
        lisParts.push(labText(latestScr, "血肌酐"));
      }

      const hisParts = [];
      if (diuretics.length > 0) {
        hisParts.push(`利尿药: ${diuretics.map((d) => d.drug_name || d.medication).join("、")}`);
      }
      if (vasoactives.length > 0) {
        hisParts.push(`心血管/血管活性药: ${vasoactives.map((d) => d.drug_name || d.medication).join("、")}`);
      }

      const syn = "并列展示已提供的出入量、肾功能及医嘱记录，不推断诊断或治疗关系";

      alignments.push({
        domain_id: "fluid_renal_hemodynamic",
        domain_title: "液体平衡 - 肾功能 - 循环与利尿对齐",
        nis_summary: nisParts.join("；") || "未提供相关护理记录",
        lis_summary: lisParts.join("；") || "未提供肌酐记录",
        his_summary: hisParts.join("；") || "未提供相关医嘱记录",
        clinical_synthesis: syn,
        requires_attention: scrObs.some((o) => o.is_critical === true),
      });
    }

    // --- Domain 2: 体温 - 感染指标 - 抗菌药物对齐 (Infection / Antimicrobial) ---
    const infObs = observations.filter((o) => {
      const n = String(o.name || o.code || "");
      return /白细胞|wbc|中性粒|crp|c反应蛋白|pct|降钙素原|培养/.test(n.toLowerCase());
    });
    const antibiotics = medications.filter((m) => {
      return m.antibiotic_info != null || /头孢|青霉素|他唑巴坦|舒巴坦|卡巴培南|培南|莫西沙星|左氧氟沙星|阿奇霉素|万古霉素|替考拉宁|利奈唑胺|阿米卡星/.test(m.drug_name || m.medication || "");
    });

    if (vitalsSummary?.t_max != null || infObs.length > 0 || antibiotics.length > 0) {
      const nisParts = [];
      if (vitalsSummary?.t_max) {
        nisParts.push(`最高体温: ${vitalsSummary.t_max}℃`);
      }

      const lisParts = infObs.map((o) => labText(o));
      const hisParts = antibiotics.map((a) => {
        const name = a.drug_name || a.medication;
        const dur = a.antibiotic_info?.duration_days ? `距医嘱开立第${a.antibiotic_info.duration_days}天，实际给药天数未知` : "";
        const lvl = a.antibiotic_info?.level ? `[${a.antibiotic_info.level}]` : "";
        return `${name} ${dur} ${lvl}`.trim();
      });

      const syn = antibiotics.some((a) => a.antibiotic_info?.is_overdue)
        ? "抗菌药物记录达到院内规则包复核时间点，请核对来源与规则；不提供停药或降阶梯建议"
        : "并列展示已提供的体温、检验及抗菌药医嘱记录";

      alignments.push({
        domain_id: "infection_temperature_antimicrobial",
        domain_title: "体温 - 感染指标 - 抗菌药物对齐",
        nis_summary: nisParts.join("；") || "未提供体温记录",
        lis_summary: lisParts.join("；") || "未提供相关检验记录",
        his_summary: hisParts.join("；") || "未提供抗菌药医嘱记录",
        clinical_synthesis: syn,
        requires_attention: infObs.some((o) => o.is_critical === true) || antibiotics.some((a) => a.antibiotic_info?.is_overdue),
      });
    }

    // --- Domain 3: 电解质异常与补给闭环对齐 (Electrolyte Balance & Replenishment) ---
    const electrolyteObs = observations.filter((o) => {
      const n = String(o.name || o.code || "").toLowerCase();
      return /钾|钠|钙|镁|potassium|sodium|calcium|magnesium|^(?:k|na|ca|mg)$/.test(n);
    });
    const replenishments = medications.filter((m) => {
      const d = String(m.drug_name || m.medication || "");
      return /氯化钾|枸橼酸钾|碳酸氢钠|浓氯化钠|葡萄糖酸钙|硫酸镁/.test(d);
    });

    if (electrolyteObs.length > 0 || replenishments.length > 0) {
      const lisParts = electrolyteObs.map((o) => `${labText(o)}${o.is_critical === true ? " (来源危急标记)" : ""}`);
      const hisParts = replenishments.map((m) => `${m.drug_name || m.medication} ${m.dosage || ""} ${m.route || ""}`);

      alignments.push({
        domain_id: "electrolytes_replenishment",
        domain_title: "电解质异常 - 纠正医嘱 - 复查闭环对齐",
        nis_summary: vitalsSummary ? "生命体征记录另见护理摘要；未证明与检验同步采集" : "未提供相关生命体征记录",
        lis_summary: lisParts.join("；") || "未提供电解质记录",
        his_summary: hisParts.join("；") || "未提供电解质补充医嘱记录",
        clinical_synthesis: "并列展示已提供的电解质与医嘱记录，不推断异常或治疗对应关系",
        requires_attention: electrolyteObs.some((o) => o.is_critical),
      });
    }

    // --- Domain 4: 心血管标志物与抗栓/扩冠用药对齐 (Cardiovascular Markers & Therapy) ---
    const cardiacObs = observations.filter((o) => {
      const n = String(o.name || o.code || "").toLowerCase();
      return /肌钙蛋白|ctni|ctnt|bnp|probnp|d-二聚体|ck-mb|inr|凝血/.test(n);
    });
    const cardiacMeds = medications.filter((m) => {
      const d = String(m.drug_name || m.medication || "");
      return /阿司匹林|氯吡格雷|替格瑞洛|肝素|依诺肝素|华法林|利伐沙班|达比加群|阿托伐他汀|瑞舒伐他汀|硝酸异山梨酯|单硝酸/.test(d);
    });
    const cardiacPacs = diagnosticReports.filter((r) => {
      const n = String(r.name || r.modality || "");
      return /心|冠脉|超声心动|cta|血管/.test(n);
    });

    if (cardiacObs.length > 0 || cardiacMeds.length > 0 || cardiacPacs.length > 0) {
      const lisParts = cardiacObs.map((o) => labText(o));
      const pacsParts = cardiacPacs.map((p) => `${p.name}: ${p.impression || "印象未提供"}（${statusLabel(p, "diagnostic_report")}）`);
      const hisParts = cardiacMeds.map((m) => `${m.drug_name || m.medication}`);

      alignments.push({
        domain_id: "cardiovascular_biomarkers_medication",
        domain_title: "心血管标志物 - 影像 - 抗栓与调脂对齐",
        nis_summary: vitalsSummary?.bp_max ? `血压: ${vitalsSummary.bp_max}, 心率: ${vitalsSummary.hr_avg ?? "未提供"} bpm` : "未提供相关体征记录",
        lis_summary: lisParts.join("；") || "未提供相关检验记录",
        pacs_summary: pacsParts.join("；") || "未提供相关影像报告",
        his_summary: hisParts.join("；") || "未提供相关医嘱记录",
        clinical_synthesis: "并列展示已提供的心血管检验、影像和医嘱记录，不推断正在监测或实际给药",
        requires_attention: cardiacObs.some((o) => o.is_critical),
      });
    }

    return alignments;
  }
}
