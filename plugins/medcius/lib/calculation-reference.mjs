import { readFileSync } from "node:fs";
import { sha256Hex } from "../servers/shared/crypto.mjs";
import { deepFreeze as freeze } from "../servers/shared/immutable.mjs";
const bytes = readFileSync(new URL("../rule-packs/calculation-reference.v1.json", import.meta.url));
export const CALCULATION_REFERENCE = freeze(JSON.parse(bytes));
export const CALCULATION_PROVENANCE = freeze({ id: CALCULATION_REFERENCE.id, version: CALCULATION_REFERENCE.version, sha256: sha256Hex(bytes), status: CALCULATION_REFERENCE.status });
export function newsSubscore(key, value) { return CALCULATION_REFERENCE.news2[key].find(([max]) => max === null || value <= max)[1]; }
export function renalStabilityPolicy(rulePack) {
  const policy = rulePack?.clinical_rules?.renal_stability;
  if (policy && (!Number.isFinite(policy.absolute_rise_umol_l) || policy.absolute_rise_umol_l <= 0 || !Number.isFinite(policy.relative_rise) || policy.relative_rise <= 0)) throw new Error("RENAL_STABILITY_POLICY_INVALID");
  return policy || CALCULATION_REFERENCE.renal_stability;
}

// A conservative data-quality hold, not a population reference interval,
// an inference about the correct unit, or an AKI/renal diagnosis.
export function isAmbiguousMassUnit(unit) {
  return typeof unit === 'string' && /(?:^|\/)(?:Mg|MG|mG|NG|Ng|nG|PG|Pg|pG|UG|Ug|uG)(?=\/|$)/.test(unit.trim());
}
export function checkCreatinineDataQuality(value, unit) {
  const reject = reason => ({ eligible: false, status: 'not_evaluable', reason, normalized_value: null,
    unit: 'umol/L', clinical_interpretation: null, provenance: CALCULATION_PROVENANCE });
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return reject('CREATININE_VALUE_INVALID');
  if (typeof unit !== 'string' || !unit.trim() || isAmbiguousMassUnit(unit)) return reject('CREATININE_UNIT_MISSING_OR_AMBIGUOUS');
  const u = unit.trim().replace(/[µμ]/g, 'u');
  let converted;
  if (['umol/L', 'umol/l', 'umol_l'].includes(u)) converted = value;
  else if (['mg/dL', 'mg/dl', 'mg/100mL', 'mg/100ml'].includes(u)) converted = value * CALCULATION_REFERENCE.unit_factors.creatinine;
  else return reject('CREATININE_UNIT_UNSUPPORTED');
  if (!Number.isFinite(converted)) return reject('CREATININE_VALUE_NONFINITE');
  const policy = CALCULATION_REFERENCE.creatinine_data_quality;
  if (!policy || !Number.isFinite(policy.minimum_umol_l) || !Number.isFinite(policy.maximum_umol_l)
    || policy.minimum_umol_l <= 0 || policy.maximum_umol_l <= policy.minimum_umol_l) throw new Error('CREATININE_DATA_QUALITY_POLICY_INVALID');
  if (converted < policy.minimum_umol_l || converted > policy.maximum_umol_l) return {
    ...reject('CREATININE_MAGNITUDE_REQUIRES_SOURCE_REVIEW'), status: 'held', normalized_value: converted };
  return { eligible: true, status: 'accepted_for_calculation', reason: null, normalized_value: converted,
    unit: 'umol/L', clinical_interpretation: null, provenance: CALCULATION_PROVENANCE };
}

const temporalBytes = readFileSync(new URL("../rule-packs/temporal-reference.v1.json", import.meta.url));
export const TEMPORAL_REFERENCE = freeze(JSON.parse(temporalBytes));
export const TEMPORAL_PROVENANCE = freeze({ id: TEMPORAL_REFERENCE.id, version: TEMPORAL_REFERENCE.version,
  sha256: sha256Hex(temporalBytes), status: TEMPORAL_REFERENCE.status });

// No host-timezone fallback or normalized impossible dates in longitudinal math.
export function temporalTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)
    || /[+-]14:(?!00)/.test(value) || Number(value.slice(11, 13)) > 23
    || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
  const date = Date.parse(`${value.slice(0, 10)}T00:00:00Z`), time = Date.parse(value);
  return Number.isFinite(date) && Number.isFinite(time) && new Date(date).toISOString().slice(0, 10) === value.slice(0, 10) ? time : null;
}

// Pure arithmetic on already normalized, provenance-bound measurements.
// Unit normalization, ownership, availability, and clinical applicability are
// checked by the caller. No rounding before threshold evaluation.
export function calculateTemporalDelta(before, after, { maxHours = 72 } = {}) {
  const empty = reason => ({ status: 'not_evaluable', reason, delta: null, relative_delta: null,
    elapsed_hours: null, slope_per_hour: null, unit: after?.unit ?? null });
  if (![before?.value, after?.value].every(v => typeof v === 'number' && Number.isFinite(v))) return empty('VALUE_MISSING_OR_INVALID');
  if (!before.unit || before.unit !== after.unit) return empty('UNIT_MISMATCH');
  const start = temporalTimestamp(before.timestamp), end = temporalTimestamp(after.timestamp);
  if (start == null || end == null || end <= start) return empty('TIME_NOT_STRICTLY_ORDERED');
  if (!Number.isFinite(maxHours) || maxHours <= 0 || end - start > maxHours * 3600000) return empty('OUTSIDE_COMPARISON_WINDOW');
  const delta = after.value - before.value, hours = (end - start) / 3600000;
  const slope = delta / hours, relative = before.value === 0 ? null : delta / before.value;
  if (![delta, slope].every(Number.isFinite) || (relative != null && !Number.isFinite(relative))) return empty('CALCULATION_NONFINITE');
  return { status: 'calculated', reason: null, delta, relative_delta: relative,
    elapsed_hours: hours, slope_per_hour: slope, unit: after.unit };
}

export function evaluateTemporalDelta(ruleId, before, after) {
  const rule = TEMPORAL_REFERENCE.delta_rules[ruleId];
  if (!rule) throw new Error('TEMPORAL_RULE_UNKNOWN');
  const comparison = calculateTemporalDelta(before, after, { maxHours: rule.max_hours });
  if (ruleId === 'creatinine_48h' && (!checkCreatinineDataQuality(before?.value, before?.unit).eligible
    || !checkCreatinineDataQuality(after?.value, after?.unit).eligible)) {
    Object.assign(comparison, { status: 'not_evaluable', reason: 'CREATININE_DATA_QUALITY_HOLD', delta: null, relative_delta: null, slope_per_hour: null });
  }
  if (after?.unit !== rule.unit) Object.assign(comparison, { status: 'not_evaluable', reason: 'RULE_UNIT_MISMATCH' });
  let rise = comparison.delta, threshold = rule.absolute_rise;
  // Preserve the published native mg/dL threshold at its own precision.
  if (ruleId === 'creatinine_48h' && before?.original_unit === 'mg/dL' && after?.original_unit === 'mg/dL'
    && Number.isFinite(before.original_value) && Number.isFinite(after.original_value)) {
    rise = after.original_value - before.original_value; threshold = rule.native_mg_dl_rise;
  }
  const triggered = comparison.status === 'calculated' ? rise >= threshold - Number.EPSILON * Math.max(1, Math.abs(rise), threshold) * 8 : null;
  return { rule_id: ruleId, basis: rule.basis, status: triggered == null ? 'not_evaluable' : triggered ? 'triggered' : 'not_triggered',
    triggered, category: triggered ? 'RULE_ALERT' : null, comparison, threshold: rule.absolute_rise,
    threshold_unit: rule.unit, clinical_alerts_enabled: false, diagnosis: null, provenance: TEMPORAL_PROVENANCE };
}

const chinaBytes = readFileSync(new URL("../rule-packs/china-clinical-reference.v1.json", import.meta.url));
export const CHINA_CLINICAL_REFERENCE = freeze(JSON.parse(chinaBytes));
export const CHINA_CALCULATION_PROVENANCE = freeze({ version: CHINA_CLINICAL_REFERENCE.version,
  sha256: sha256Hex(chinaBytes), status: CHINA_CLINICAL_REFERENCE.status });
const unavailable = (method, reason) => ({ method, status: "not_calculated", value: null, reason, provenance: CHINA_CALCULATION_PROVENANCE });

// Explicit units and applicability are required. This indexed estimate is not CrCl.
export function calculateChineseMdrd({ age, sex, creatinine, creatinine_unit, stable_renal_function,
  adult_ckd, pregnant = null, dialysis = null } = {}) {
  const r = CHINA_CLINICAL_REFERENCE.c_mdrd;
  if (!Number.isFinite(age) || age < r.minimum_age || !["male", "female"].includes(sex)) return unavailable(r.id, "ADULT_AGE_AND_SEX_REQUIRED");
  if (stable_renal_function !== true || adult_ckd !== true || pregnant !== false || dialysis !== false) return unavailable(r.id, "APPLICABILITY_NOT_CONFIRMED");
  if (!Number.isFinite(creatinine) || creatinine <= 0 || !["umol/L", "μmol/L", "µmol/L", "mg/dL"].includes(creatinine_unit)) return unavailable(r.id, "EXPLICIT_CREATININE_UNIT_AND_VALUE_REQUIRED");
  if (!checkCreatinineDataQuality(creatinine, creatinine_unit).eligible) return unavailable(r.id, "CREATININE_DATA_QUALITY_HOLD");
  const scr = creatinine_unit === "mg/dL" ? creatinine : creatinine / CALCULATION_REFERENCE.unit_factors.creatinine;
  const value = r.coefficient * scr ** r.creatinine_exponent * age ** r.age_exponent * (sex === "female" ? r.female_multiplier : 1);
  if (!Number.isFinite(value)) return unavailable(r.id, "CALCULATION_NONFINITE");
  return { method: r.id, status: "calculated", value: Math.round(value * 10) / 10, unit: r.unit,
    source: CHINA_CLINICAL_REFERENCE.sources.c_mdrd, provenance: CHINA_CALCULATION_PROVENANCE, dose_adjustment_basis: false };
}

export function classifyChineseAdultBmi({ age, weight_kg, height_cm, pregnant_or_postpartum, athlete } = {}) {
  const r = CHINA_CLINICAL_REFERENCE.bmi;
  if (!Number.isFinite(age) || age < r.minimum_age || pregnant_or_postpartum !== false || athlete !== false) return unavailable(r.id, "ADULT_BMI_APPLICABILITY_NOT_CONFIRMED");
  if (!Number.isFinite(weight_kg) || !Number.isFinite(height_cm) || weight_kg <= 0 || height_cm <= 0) return unavailable(r.id, "HEIGHT_CM_AND_WEIGHT_KG_REQUIRED");
  const value = weight_kg / (height_cm / 100) ** 2;
  if (!Number.isFinite(value)) return unavailable(r.id, "CALCULATION_NONFINITE");
  const category = value < r.underweight_below ? "underweight" : value < r.overweight_at ? "normal" : value < r.obesity_at ? "overweight" : "obesity";
  return { method: r.id, status: "calculated", value: Math.round(value * 100) / 100, unrounded_value: value,
    unit: r.unit, category, source: CHINA_CLINICAL_REFERENCE.sources.bmi, provenance: CHINA_CALCULATION_PROVENANCE };
}
