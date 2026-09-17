#!/usr/bin/env node
// Clinical Skill Catalog Schema & Integrity Validator

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { ClinicalSkillCatalog } from "../plugins/medcius/lib/clinical-skill-catalog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

console.log("=== Medcius Clinical Skill Catalog Governance Validation ===");

const schemaPath = join(repoRoot, "plugins/medcius/contracts/clinical-skill-catalog.v1.schema.json");
const catalogPath = join(repoRoot, "plugins/medcius/rule-packs/catalogs/hospital-inpatient-skill-catalog.json");

assert.ok(existsSync(schemaPath), "Schema file must exist");
assert.ok(existsSync(catalogPath), "Catalog file must exist");

const catalogEngine = new ClinicalSkillCatalog();
catalogEngine.loadCatalog(catalogPath);

const landingCheck = catalogEngine.isSkillApproved("patient-evolution-summary", "production");
assert.ok(landingCheck.isEligible, `patient-evolution-summary must be approved for production: ${landingCheck.reason}`);
assert.ok(landingCheck.skill.approval_metadata.approved_by, "Landing skill must have named physician approval");
console.log(`  ✓ Skill 'patient-evolution-summary' [v${landingCheck.skill.version}]: Approved by ${landingCheck.skill.approval_metadata.approved_by}`);

const frozenSkills = [
  "shift-handover",
  "consult-preparation",
  "discharge-readiness-check",
];
for (const skillId of frozenSkills) {
  const skill = catalogEngine.getSkill(skillId);
  assert.ok(skill, `Frozen skill ${skillId} must remain in the catalog`);
  assert.equal(skill.status, "frozen", `Skill ${skillId} must be P0-frozen`);
  const prodCheck = catalogEngine.isSkillApproved(skillId, "production");
  assert.equal(prodCheck.isEligible, false, `Frozen skill ${skillId} must not be production-eligible`);
  const landingMode = catalogEngine.isSkillApproved(skillId, "clinical_landing");
  assert.equal(landingMode.isEligible, false, `Frozen skill ${skillId} must not run in clinical_landing mode`);
  console.log(`  ✓ Skill '${skillId}' is P0-frozen and ineligible for clinical landing`);
}

// Test Fail-Closed behavior for unapproved/quarantined skill
const mockUnapprovedCatalog = {
  catalog_id: "test-catalog",
  hospital_scope: "Test Hospital",
  version: "1.0.0",
  skills: [
    {
      skill_id: "unapproved-skill",
      version: "0.1.0",
      intended_use: "Test",
      risk_classification: "Class II - Informational Clinical Support",
      prohibited_actions: [],
      required_permissions: [],
      approval_metadata: { approved_by: "", approval_role: "", committee: "", approval_date: "", content_hash: "" },
      status: "candidate",
    },
  ],
};

const unapprovedEngine = new ClinicalSkillCatalog(mockUnapprovedCatalog);
const unapprovedCheck = unapprovedEngine.isSkillApproved("unapproved-skill", "production");
assert.equal(unapprovedCheck.isEligible, false, "Candidate skill must fail-closed in production");

console.log("  ✓ Fail-Closed Gate: Candidate skills correctly rejected in production mode.");
console.log("🎉 ALL CLINICAL SKILL CATALOG VALIDATIONS PASSED!\n");
