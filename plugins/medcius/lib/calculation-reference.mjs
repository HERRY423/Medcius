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
