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
