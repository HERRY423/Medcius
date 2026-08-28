import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACK_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const DEFAULT_RULE_PACK_DIRECTORY = fileURLToPath(
  new URL("../rule-packs/specialties/", import.meta.url),
);

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function rulePackDigest(pack) {
  return createHash("sha256").update(stableJson(pack)).digest("hex");
}

export function validateSpecialtyRulePack(pack, { production = false } = {}) {
  const errors = [];
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    return { ok: false, errors: ["RULE_PACK_OBJECT_REQUIRED"] };
  }

  if (pack.schema_version !== "medcius.specialty-rule-pack.v1") errors.push("UNSUPPORTED_SCHEMA_VERSION");
  if (!PACK_ID_RE.test(pack.pack_id || "")) errors.push("INVALID_PACK_ID");
  for (const field of ["version", "specialty", "care_setting", "data_class", "status"]) {
    if (typeof pack[field] !== "string" || !pack[field].trim()) errors.push(`MISSING_${field.toUpperCase()}`);
  }

  const authority = pack.authority;
  if (!authority || typeof authority !== "object") {
    errors.push("AUTHORITY_REQUIRED");
  } else {
    if (typeof authority.organization !== "string" || !authority.organization.trim()) errors.push("AUTHORITY_ORGANIZATION_REQUIRED");
    if (!isIsoDate(authority.effective_from)) errors.push("VALID_EFFECTIVE_FROM_REQUIRED");
    if (authority.review_due != null && !isIsoDate(authority.review_due)) errors.push("INVALID_REVIEW_DUE");
  }

  const rules = pack.clinical_rules;
  if (!rules || typeof rules !== "object") {
    errors.push("CLINICAL_RULES_REQUIRED");
  } else {
    if (!rules.critical_values || typeof rules.critical_values !== "object" || Array.isArray(rules.critical_values)) errors.push("CRITICAL_VALUE_RULES_OBJECT_REQUIRED");
    if (!Array.isArray(rules.restricted_antibiotics)) errors.push("RESTRICTED_ANTIBIOTICS_ARRAY_REQUIRED");
    const wardThresholds = rules.ward_thresholds;
    if (!wardThresholds || typeof wardThresholds !== "object" || Array.isArray(wardThresholds)) {
      errors.push("WARD_THRESHOLDS_OBJECT_REQUIRED");
    } else {
      const fluid = wardThresholds.fluid_balance_net_ml;
      if (!fluid || !Number.isFinite(fluid.high_attention_above) || !Number.isFinite(fluid.low_attention_below)) {
        errors.push("FLUID_BALANCE_THRESHOLDS_REQUIRED");
      } else if (fluid.low_attention_below >= fluid.high_attention_above) {
        errors.push("FLUID_BALANCE_THRESHOLDS_INVALID_ORDER");
      }
      if (!Number.isFinite(wardThresholds.egfr_attention_below) || wardThresholds.egfr_attention_below <= 0) {
        errors.push("EGFR_ATTENTION_THRESHOLD_REQUIRED");
      }
    }
    if (!Array.isArray(rules.followup)) errors.push("FOLLOWUP_RULES_ARRAY_REQUIRED");
    const ids = new Set();
    for (const rule of rules.followup || []) {
      if (!rule?.rule_id || ids.has(rule.rule_id)) errors.push("FOLLOWUP_RULE_ID_REQUIRED_AND_UNIQUE");
      ids.add(rule?.rule_id);
      if (!Array.isArray(rule?.required_stages) || rule.required_stages.length === 0) errors.push(`FOLLOWUP_REQUIRED_STAGES:${rule?.rule_id || "unknown"}`);
    }
  }

  if (production) {
    if (pack.data_class !== "official") errors.push("PRODUCTION_REQUIRES_OFFICIAL_DATA_CLASS");
    if (pack.status !== "approved") errors.push("PRODUCTION_REQUIRES_APPROVED_STATUS");
    if (!authority?.approved_by) errors.push("PRODUCTION_REQUIRES_NAMED_APPROVER");
    if (!authority?.hospital_scope) errors.push("PRODUCTION_REQUIRES_HOSPITAL_SCOPE");
  }

  return { ok: errors.length === 0, errors };
}

export function loadSpecialtyRulePack(packId, {
  directory = process.env.MEDCIUS_RULE_PACK_DIR || DEFAULT_RULE_PACK_DIRECTORY,
  production = false,
} = {}) {
  if (!PACK_ID_RE.test(packId || "")) throw new Error("RULE_PACK_INVALID_ID: path-like or malformed pack id rejected");
  const filePath = join(directory, `${packId}.json`);
  if (basename(filePath) !== `${packId}.json` || !existsSync(filePath)) {
    throw new Error(`RULE_PACK_NOT_FOUND: ${packId}`);
  }
  const pack = JSON.parse(readFileSync(filePath, "utf8"));
  if (pack.pack_id !== packId) throw new Error(`RULE_PACK_ID_MISMATCH: expected ${packId}, received ${pack.pack_id}`);
  const validation = validateSpecialtyRulePack(pack, { production });
  if (!validation.ok) throw new Error(`RULE_PACK_REJECTED: ${validation.errors.join(",")}`);
  return Object.freeze({ ...pack, sha256: rulePackDigest(pack) });
}

export function listSpecialtyRulePacks({ directory = process.env.MEDCIUS_RULE_PACK_DIR || DEFAULT_RULE_PACK_DIRECTORY } = {}) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .filter((id) => PACK_ID_RE.test(id))
    .sort();
}
