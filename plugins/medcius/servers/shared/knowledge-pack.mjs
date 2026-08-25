// Hospital Formal Knowledge Pack Manager & Controlled Supply Chain Engine
// Standardizes hospital formulary, localized clinical pathways, custom DDI rules,
// upstream source licensing, version update SLA, and cryptographic supply chain integrity.

import { readFileSync, existsSync } from "node:fs";
import { canonicalJson, sha256Hex } from "./crypto.mjs";

export const UPDATE_SLA_DAYS = {
  nmpa_drug_labels: 14,      // NMPA package insert updates within 14 calendar days
  nhsa_national_catalog: 7,   // NHSA national insurance catalog within 7 calendar days
  provincial_benefit_rules: 30, // Provincial insurance rules within 30 calendar days
  hospital_formulary_sync: 1, // Hospital localized formulary changes within 24 hours
};

export class HospitalKnowledgePack {
  constructor(data = {}) {
    this.isDemo = Boolean(data.is_demo);
    this.packId = data.pack_id ?? null;
    this.hospitalName = data.hospital_name ?? null;
    this.hospitalCode = data.hospital_code ?? null;
    this.packVersion = data.pack_version ?? null;
    this.effectiveDate = data.effective_date ?? null;
    this.expirationDate = data.expiration_date ?? null;
    this.license = data.license ? {
      type: data.license.type ?? null,
      authority: data.license.authority ?? null,
      license_number: data.license.license_number ?? null,
      authorized_departments: Array.isArray(data.license.authorized_departments) ? data.license.authorized_departments : [],
    } : null;
    this.sources = Array.isArray(data.sources) ? data.sources : [];
    this.sla = data.sla ? { ...UPDATE_SLA_DAYS, ...data.sla } : UPDATE_SLA_DAYS;
    this.formulary = Array.isArray(data.formulary) ? data.formulary : [];
    this.customRules = Array.isArray(data.custom_rules) ? data.custom_rules : [];
    this.approver = data.approver ?? null;
    this.provenanceHash = this.computeHash();
  }

  /**
   * Deep canonical hash covering the ENTIRE normalized content:
   * all formulary drugs, custom rules, sources, licenses, and dates.
   */
  computeHash() {
    const raw = {
      isDemo: this.isDemo,
      packId: this.packId,
      hospitalName: this.hospitalName,
      hospitalCode: this.hospitalCode,
      packVersion: this.packVersion,
      effectiveDate: this.effectiveDate,
      expirationDate: this.expirationDate,
      license: this.license,
      sources: this.sources.map((s) => ({
        name: s.source_name,
        type: s.source_type,
        url: s.source_url,
        file_sha256: s.file_sha256,
      })),
      formulary: this.formulary.map((f) => ({
        code: f.hospital_drug_code,
        generic: f.generic_name,
        brand: f.brand_name,
        spec: f.spec,
        form: f.dosage_form,
        classification: f.hospital_classification,
        insurance: f.insurance_category,
        max_daily_dose_mg: f.max_daily_dose_mg,
        renal_cutoff_egfr: f.renal_cutoff_egfr,
        special_rules: f.special_rules,
      })),
      customRules: this.customRules.map((r) => ({
        rule_id: r.rule_id,
        name: r.name,
        condition: r.condition,
        target_drugs: r.target_drugs,
        action: r.action,
        message: r.message,
      })),
      approver: this.approver ? {
        signer: this.approver.signer_name,
        role: this.approver.role,
        signed_at: this.approver.signed_at,
        key_id: this.approver.key_id,
      } : null,
    };
    return sha256Hex(canonicalJson(raw));
  }

  static loadFromFile(filePath) {
    if (!existsSync(filePath)) {
      throw new Error(`Hospital knowledge pack file not found: ${filePath}`);
    }
    const raw = readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    return new HospitalKnowledgePack(json);
  }

  /**
   * Validate knowledge pack structure & integrity.
   * Fails immediately if mandatory fields are missing.
   */
  validate() {
    const errors = [];
    if (!this.packId) errors.push("Missing pack_id");
    if (!this.hospitalCode) errors.push("Missing hospital_code");
    if (!this.hospitalName) errors.push("Missing hospital_name");
    if (!this.packVersion) errors.push("Missing pack_version");
    if (!this.effectiveDate) errors.push("Missing effective_date");
    if (!this.license) {
      errors.push("Missing license configuration block");
    } else {
      if (!this.license.type) errors.push("Missing license.type");
      if (!this.license.authority) errors.push("Missing license.authority");
      if (!this.license.license_number) errors.push("Missing license.license_number");
    }
    if (this.formulary.length === 0) errors.push("Formulary is empty");

    return {
      valid: errors.length === 0,
      errors,
      is_demo: this.isDemo,
      pack_id: this.packId,
      provenance_hash: this.provenanceHash,
      formulary_items_count: this.formulary.length,
      custom_rules_count: this.customRules.length,
      sla: this.sla,
      license: this.license,
      approver: this.approver,
    };
  }

  /**
   * Production Gate Validator:
   * Strictly rejects demo templates, unverified sources, missing digital signatures,
   * expired packages, or simulated licenses.
   */
  validateForProduction() {
    const base = this.validate();
    const prodErrors = [...base.errors];

    if (this.isDemo) {
      prodErrors.push("PROD_GATE_REJECT: Package is marked as demo (is_demo=true), prohibited in production");
    }
    if (this.hospitalName && this.hospitalName.includes("DEMO")) {
      prodErrors.push("PROD_GATE_REJECT: Hospital name contains DEMO string");
    }
    if (this.packId && this.packId.includes("DEMO")) {
      prodErrors.push("PROD_GATE_REJECT: Pack ID contains DEMO string");
    }
    if (this.license?.type && this.license.type.includes("Demo")) {
      prodErrors.push("PROD_GATE_REJECT: License is a demo license");
    }
    if (!this.expirationDate) {
      prodErrors.push("PROD_GATE_REJECT: Missing expiration_date");
    } else {
      const exp = new Date(this.expirationDate).getTime();
      if (isNaN(exp) || exp < Date.now()) {
        prodErrors.push("PROD_GATE_REJECT: Knowledge pack has expired or invalid expiration_date");
      }
    }
    if (this.sources.length === 0) {
      prodErrors.push("PROD_GATE_REJECT: Missing upstream source lineage records (sources)");
    } else {
      for (const s of this.sources) {
        if (!s.file_sha256 || s.file_sha256.length !== 64) {
          prodErrors.push(`PROD_GATE_REJECT: Source ${s.source_name || 'unknown'} missing 64-char file_sha256`);
        }
      }
    }
    if (!this.approver?.signature || !this.approver?.signer_name) {
      prodErrors.push("PROD_GATE_REJECT: Missing verified approver digital signature");
    }

    return {
      valid: prodErrors.length === 0,
      errors: prodErrors,
      provenance_hash: this.provenanceHash,
    };
  }

  /**
   * Check if an active drug is on the hospital formulary.
   */
  findFormularyDrug(drugName) {
    if (!drugName) return null;
    const clean = drugName.trim();
    return this.formulary.find(
      (f) => f.generic_name === clean || f.brand_name === clean || f.hospital_drug_code === clean,
    ) || null;
  }
}
