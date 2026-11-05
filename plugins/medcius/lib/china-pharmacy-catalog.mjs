import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { deepFreeze } from "../servers/shared/immutable.mjs";
import { CHINA_CLINICAL_REFERENCE } from "./calculation-reference.mjs";

const text = value => typeof value === "string" && value.trim().length > 0;
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const kinds = new Set(["product", "antimicrobial_grade", "reimbursement", "dual_channel", "vbp"]);
const productFields = ["approval_number", "manufacturer", "dosage_form", "spec"];
const sourceFields = ["organization", "url", "version", "locator", "document_sha256", "reviewed_by"];
const safeUrl = value => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } };
const validated = new WeakSet();

export function validateChinaPharmacyCatalog(bundle, { production = false } = {}) {
  const errors = [];
  if (bundle?.schema_version !== "medcius.china-pharmacy-catalog.v1" || !text(bundle?.version) || !Array.isArray(bundle?.records)) return { ok: false, errors: ["CN_PHARMACY_SCHEMA_INVALID"] };
  if (bundle.records.length > 20000) errors.push("CN_PHARMACY_RECORD_LIMIT");
  const ids = new Set();
  for (const row of bundle.records) {
    if (!text(row?.id) || ids.has(row.id)) errors.push("CN_PHARMACY_ID_INVALID_OR_DUPLICATE");
    ids.add(row?.id);
    if (!kinds.has(row?.kind) || productFields.some(key => !text(row?.product?.[key]))) errors.push("CN_PHARMACY_PRODUCT_BINDING_REQUIRED");
    if (!["official", "synthetic"].includes(row?.data_class) || (production && row?.data_class !== "official")) errors.push("CN_PHARMACY_OFFICIAL_REQUIRED");
    if (sourceFields.some(key => !text(row?.source?.[key])) || !safeUrl(row?.source?.url)
      || !/^[a-f0-9]{64}$/.test(row?.source?.document_sha256 || "") || row?.source?.review_status !== "approved") errors.push("CN_PHARMACY_REVIEWED_SOURCE_REQUIRED");
    try {
      if (!date(row?.effective_from) || !date(row?.effective_to) || row.effective_from > row.effective_to) errors.push("CN_PHARMACY_EFFECTIVE_PERIOD_REQUIRED");
    } catch { errors.push("CN_PHARMACY_EFFECTIVE_PERIOD_REQUIRED"); }
    if (!text(row?.region)) errors.push("CN_PHARMACY_REGION_REQUIRED");
    if (row?.kind === "antimicrobial_grade" && (!["non_restricted", "restricted", "special"].includes(row.grade) || !text(row.hospital_id))) errors.push("CN_PHARMACY_LOCAL_GRADE_REQUIRED");
    if (row?.kind === "product") {
      if (!Array.isArray(row.ingredients) || row.ingredients.length === 0 || row.ingredients.some(i => !text(i))) errors.push("CN_PHARMACY_INGREDIENTS_REQUIRED");
      if (row.tcm_injection === true && (!Array.isArray(row.diluents) || !row.diluents.length)) errors.push("CN_PHARMACY_DILUENT_RULES_REQUIRED");
      if (row.diluents != null && !Array.isArray(row.diluents)) errors.push("CN_PHARMACY_DILUENT_RULE_INVALID");
      for (const d of Array.isArray(row.diluents) ? row.diluents : []) {
        if (!d || typeof d !== "object") { errors.push("CN_PHARMACY_DILUENT_RULE_INVALID"); continue; }
        if (!["infusion", "reconstitution"].includes(d.phase) || !text(d.solvent) || !Number.isFinite(d.concentration_percent) || d.concentration_percent < 0
          || !Number.isFinite(d.min_ml) || !Number.isFinite(d.max_ml) || d.min_ml <= 0 || d.max_ml < d.min_ml) errors.push("CN_PHARMACY_DILUENT_RULE_INVALID");
      }
    }
    if (row?.kind === "reimbursement" && (!["A", "B", "not_listed"].includes(row.category) || !text(row.catalog_code)
      || !text(row.payment_scope) || typeof row.negotiated !== "boolean")) errors.push("CN_PHARMACY_PAYMENT_SCOPE_REQUIRED");
    if (["dual_channel", "vbp"].includes(row?.kind) && (row.region === "CN" || typeof row.selected !== "boolean")) errors.push("CN_PHARMACY_LOCAL_SELECTION_REQUIRED");
    if (row?.kind === "vbp" && !text(row.procurement_batch)) errors.push("CN_PHARMACY_VBP_BATCH_REQUIRED");
    // This clinical adapter does not import payment prices, credentials or patient data.
    const allowed = new Set(["id", "kind", "product", "data_class", "source", "effective_from", "effective_to", "region", "hospital_id", "grade", "ingredients", "tcm_injection", "diluents", "category", "catalog_code", "payment_scope", "negotiated", "selected", "procurement_batch"]);
    if (row && Object.keys(row).some(key => !allowed.has(key))) errors.push("CN_PHARMACY_UNSUPPORTED_FIELD");
    if (row?.product && Object.keys(row.product).some(key => !productFields.includes(key))) errors.push("CN_PHARMACY_UNSUPPORTED_PRODUCT_FIELD");
    if (row?.source && Object.keys(row.source).some(key => ![...sourceFields, "review_status"].includes(key))) errors.push("CN_PHARMACY_UNSUPPORTED_SOURCE_FIELD");
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function prepareChinaPharmacyCatalog(bundle, options = {}) {
  const check = validateChinaPharmacyCatalog(bundle, options);
  if (!check.ok) throw new Error(check.errors.join(","));
  const copy = deepFreeze({ schema_version: bundle.schema_version, version: bundle.version, records: structuredClone(bundle.records),
    sha256: sha256Hex(canonicalJson({ version: bundle.version, records: bundle.records })) });
  validated.add(copy);
  return copy;
}

export function chinaPharmacyCatalogPath() {
  return process.env.MEDCIUS_CN_PHARMACY_CATALOG || join(process.env.CLAUDE_MEDCIUS_DATA || join(homedir(), ".claude", "data", "medcius"), "drug-labels", "china-pharmacy.v1.json");
}
export function loadChinaPharmacyCatalog({ path = chinaPharmacyCatalogPath(), production = false } = {}) {
  if (!existsSync(path)) {
    if (process.env.MEDCIUS_CN_PHARMACY_CATALOG) throw new Error("CN_PHARMACY_CONFIGURED_CATALOG_MISSING");
    return prepareChinaPharmacyCatalog({ schema_version: "medcius.china-pharmacy-catalog.v1", version: "empty", records: [] }, { production });
  }
  try {
    if (statSync(path).size > 10 * 1024 * 1024) throw new Error("CN_PHARMACY_CATALOG_SIZE_LIMIT");
    return prepareChinaPharmacyCatalog(JSON.parse(readFileSync(path, "utf8")), { production });
  } catch (error) {
    if (/^CN_PHARMACY_[A-Z_]+(?:,CN_PHARMACY_[A-Z_]+)*$/.test(error?.message || "")) throw error;
    throw new Error("CN_PHARMACY_CATALOG_LOAD_FAILED");
  }
}

export function resolveChinaPharmacyRecord(catalog, kind, medication, { region, hospital_id, as_of, production = false } = {}) {
  if (!validated.has(catalog)) catalog = prepareChinaPharmacyCatalog(catalog, { production });
  if (production && catalog.records.some(row => row.data_class !== "official")) throw new Error("CN_PHARMACY_OFFICIAL_REQUIRED");
  const day = typeof as_of === "string" && Number.isFinite(Date.parse(as_of)) ? new Date(as_of).toISOString().slice(0, 10) : null;
  if (!day || productFields.some(key => !text(medication?.[key]))) return { status: "unknown", reason: "PRODUCT_IDENTITY_OR_AS_OF_MISSING" };
  const candidates = catalog.records.filter(row => row.kind === kind && productFields.every(key => row.product[key] === medication[key])
    && (row.region === region || row.region === "CN") && (!row.hospital_id || row.hospital_id === hospital_id)
    && row.effective_from <= day && day <= row.effective_to);
  // Overlap is a conflict, not an invitation to silently choose the newest row.
  if (candidates.length !== 1) return { status: "unknown", reason: candidates.length ? "CATALOG_CONFLICT" : "NO_CURRENT_SCOPED_RECORD" };
  return { status: "matched", record: candidates[0], catalog_version: catalog.version, catalog_sha256: catalog.sha256 };
}

// Keep unrelated products out of patient snapshots and per-patient NER work.
// Matching still checks region/date/conflicts later; no candidate is selected by name.
export function selectChinaPharmacyCatalog(catalog, medications, { production = false } = {}) {
  const checked = prepareChinaPharmacyCatalog(catalog, { production });
  return prepareChinaPharmacyCatalog({ schema_version: checked.schema_version, version: checked.version,
    records: checked.records.filter(row => medications.some(med => productFields.every(key => text(med?.[key]) && row.product[key] === med[key]))) }, { production });
}

const ingredientAliases = new Map([["对乙酰氨基酚", "acetaminophen"], ["paracetamol", "acetaminophen"], ["acetaminophen", "acetaminophen"]]);
const ingredient = value => ingredientAliases.get(value.toLowerCase()) || value;
const referenceNames = new Set(["复方感冒灵片", "复方感冒灵颗粒", "复方感冒灵胶囊"]);
const acetaminophenNames = new Set(["对乙酰氨基酚", "对乙酰氨基酚片", "对乙酰氨基酚缓释片", "paracetamol", "acetaminophen"]);
export const SPECIAL_ANTIMICROBIAL_CANDIDATES = Object.freeze(["美罗培南", "亚胺培南西司他丁", "厄他培南", "比阿培南", "帕尼培南倍他米隆", "替加环素", "万古霉素"]);
export function specialAntimicrobialCandidate(drugName) {
  return SPECIAL_ANTIMICROBIAL_CANDIDATES.some(name => String(drugName || "").replace(/[\s·、/]/g, "").includes(name));
}

export function checkChinaMedicationSafety({ medications = [], catalog = loadChinaPharmacyCatalog(), context = {} } = {}) {
  const findings = [], profiles = [];
  for (const med of medications) {
    const resolved = resolveChinaPharmacyRecord(catalog, "product", med, context);
    const row = resolved.record;
    const drugName = med.drug_name || med.generic_name || "";
    let ingredients = row?.ingredients.map(ingredient) || [];
    const fallback = !row && (referenceNames.has(drugName) || acetaminophenNames.has(drugName.toLowerCase()));
    if (fallback) ingredients = ["acetaminophen"];
    profiles.push({ medication_id: med.id ?? null, ingredients, source: row?.source || (fallback ? CHINA_CLINICAL_REFERENCE.sources.tcm_overlap : null), reference_only: fallback });
    if (!row) findings.push({ code: "PRODUCT_LABEL_NOT_BOUND", status: "unknown", medication_ids: [med.id ?? null], reason: resolved.reason });
    if (row?.tcm_injection || med.tcm_injection === true) {
      for (const phase of ["reconstitution", "infusion"].filter(p => row?.diluents?.some(d => d.phase === p) || p === "infusion")) {
        const actual = med.diluents?.find(d => d.phase === phase);
        const evaluable = row && Array.isArray(row.diluents) && actual && text(actual.solvent) && Number.isFinite(actual.concentration_percent) && Number.isFinite(actual.volume_ml) && actual.volume_ml > 0;
        const match = evaluable && row.diluents.some(d => d.phase === phase && d.solvent === actual.solvent
          && d.concentration_percent === actual.concentration_percent && d.min_ml <= actual.volume_ml && actual.volume_ml <= d.max_ml);
        findings.push({ code: "TCM_INJECTION_DILUENT", phase, status: !evaluable ? "unknown" : match ? "documented" : "review_required",
          medication_ids: [med.id ?? null], source: row?.source ?? null, reason: !evaluable ? "PRODUCT_SPECIFIC_LABEL_AND_DILUENT_REQUIRED" : match ? "MATCHES_REVIEWED_LABEL_PARAMETERS_ONLY" : "OUTSIDE_REVIEWED_LABEL_PARAMETERS" });
      }
      if (med.mixed_with_other_drugs !== false) findings.push({ code: "TCM_INJECTION_ADMIXTURE_REVIEW", status: "unknown", medication_ids: [med.id ?? null] });
    }
  }
  for (let i = 0; i < profiles.length; i++) for (let j = i + 1; j < profiles.length; j++) {
    const overlap = [...new Set(profiles[i].ingredients.filter(x => profiles[j].ingredients.includes(x)))];
    if (overlap.length) findings.push({ code: "ACTIVE_INGREDIENT_DUPLICATION", status: "review_required", medication_ids: [profiles[i].medication_id, profiles[j].medication_id],
      ingredients: overlap, potential_risk: overlap.includes("acetaminophen") ? "ACETAMINOPHEN_CUMULATIVE_EXPOSURE_AND_HEPATIC_RISK_REVIEW" : "DUPLICATE_EXPOSURE_REVIEW",
      sources: [profiles[i].source, profiles[j].source], reference_only: profiles[i].reference_only || profiles[j].reference_only });
  }
  return { status: "bounded_screen_only", findings, negative_screen_means_safe: false };
}

export function buildChinaMedicationCoverage({ medications = [], catalog = loadChinaPharmacyCatalog(), context = {} } = {}) {
  return medications.map(med => {
    const lookup = kind => resolveChinaPharmacyRecord(catalog, kind, med, context);
    const reimbursement = lookup("reimbursement"), channel = lookup("dual_channel"), vbp = lookup("vbp");
    return { medication_id: med.id ?? null, status: reimbursement.status === "matched" ? "catalog_facts_only" : "unknown",
      insurance_category: reimbursement.record?.category ?? null, negotiated: reimbursement.record?.negotiated ?? null,
      payment_scope: reimbursement.record?.payment_scope ?? null, dual_channel: channel.record?.selected ?? null,
      vbp_selected: vbp.record?.selected ?? null, procurement_batch: vbp.record?.procurement_batch ?? null,
      catalog_code: reimbursement.record?.catalog_code ?? null,
      sources: [reimbursement, channel, vbp].filter(x => x.record).map(x => ({ record_id: x.record.id, source: x.record.source, region: x.record.region,
        effective_from: x.record.effective_from, effective_to: x.record.effective_to, catalog_version: x.catalog_version, catalog_sha256: x.catalog_sha256 })),
      gaps: [["reimbursement", reimbursement], ["dual_channel", channel], ["vbp", vbp]].filter(([, r]) => r.status !== "matched").map(([kind, r]) => ({ kind, reason: r.reason })),
      patient_payment_eligibility: "not_determined", action: "VERIFY_PATIENT_INDICATION_PAYMENT_TERMS_AND_LOCAL_CHANNEL", automatic_substitution: false };
  });
}
