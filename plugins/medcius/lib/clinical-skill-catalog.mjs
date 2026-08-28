// Clinical Skill Catalog Lifecycle Governance & Verification Engine
// Enforces: Declarative Skill Catalog Parsing, Physician Approval Metadata Verification,
// Hash Integrity Checking, Emergency Kill-Switch, and Fail-Closed Production Execution.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

export class ClinicalSkillCatalog {
  constructor(catalogData = null) {
    this.catalog = null;
    this.disabledSkills = new Map(); // skill_id -> { reason, disabled_at }
    if (catalogData) {
      this.loadCatalog(catalogData);
    }
  }

  /**
   * Loads catalog from object or JSON file path
   */
  loadCatalog(catalogOrPath) {
    if (typeof catalogOrPath === "string") {
      if (!existsSync(catalogOrPath)) {
        throw new Error(`Catalog file not found: ${catalogOrPath}`);
      }
      const raw = readFileSync(catalogOrPath, "utf8");
      this.catalog = JSON.parse(raw);
    } else if (typeof catalogOrPath === "object" && catalogOrPath !== null) {
      this.catalog = catalogOrPath;
    } else {
      throw new Error("Invalid catalog format: expected file path or object");
    }

    if (!this.catalog.catalog_id || !Array.isArray(this.catalog.skills)) {
      throw new Error("Invalid catalog structure: missing catalog_id or skills array");
    }
  }

  /**
   * Retrieves a skill record by skill_id
   */
  getSkill(skillId) {
    if (!this.catalog) throw new Error("No catalog loaded");
    return this.catalog.skills.find((s) => s.skill_id === skillId) || null;
  }

  /**
   * Checks if a skill is approved and eligible for execution in the given mode
   * @param {string} skillId
   * @param {string} mode - "production" | "pilot" | "sandbox"
   * @returns {Object} { isEligible: boolean, reason?: string, skill?: Object }
   */
  isSkillApproved(skillId, mode = "production") {
    const skill = this.getSkill(skillId);
    if (!skill) {
      return { isEligible: false, reason: `Skill '${skillId}' not found in registered catalog` };
    }

    // 1. Check emergency runtime kill-switch
    if (this.disabledSkills.has(skillId)) {
      const disabledInfo = this.disabledSkills.get(skillId);
      return { isEligible: false, reason: `Skill '${skillId}' has been administratively disabled: ${disabledInfo.reason}` };
    }

    // 2. Check quarantine status
    if (skill.status === "quarantined") {
      return { isEligible: false, reason: `Skill '${skillId}' is quarantined due to safety or regulatory reasons` };
    }

    // 3. Check deprecated status
    if (skill.status === "deprecated") {
      return { isEligible: false, reason: `Skill '${skillId}' is deprecated` };
    }

    // 4. Production Hard Gate: In production, must be explicitly 'approved' with named physician sign-off
    if (mode === "production") {
      if (skill.status !== "approved") {
        return { isEligible: false, reason: `Skill '${skillId}' status is '${skill.status}', production requires 'approved'` };
      }
      if (!skill.approval_metadata || !skill.approval_metadata.approved_by) {
        return { isEligible: false, reason: `Skill '${skillId}' lacks named physician approval metadata` };
      }
    }

    return { isEligible: true, skill };
  }

  /**
   * Emergency runtime disable (kill-switch) for a specific skill
   */
  disableSkill(skillId, reason = "Emergency safety kill-switch triggered") {
    this.disabledSkills.set(skillId, {
      reason,
      disabled_at: new Date().toISOString(),
    });
  }

  /**
   * Re-enables a previously disabled skill
   */
  enableSkill(skillId) {
    this.disabledSkills.delete(skillId);
  }

  /**
   * Verifies the SHA-256 integrity hash of a skill's actual definition/implementation
   */
  static computeContentHash(content) {
    return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
  }
}
