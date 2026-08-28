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

const requiredSkills = [
  "patient-evolution-summary",
  "shift-handover",
  "consult-preparation",
  "discharge-readiness-check",
];

for (const skillId of requiredSkills) {
  const check = catalogEngine.isSkillApproved(skillId, "production");
  assert.ok(check.isEligible, `Skill ${skillId} must be approved for production: ${check.reason}`);
  assert.ok(check.skill.approval_metadata.approved_by, `Skill ${skillId} must have named physician approval`);
  console.log(`  ✓ Skill '${skillId}' [v${check.skill.version}]: Approved by ${check.skill.approval_metadata.approved_by} (${check.skill.approval_metadata.committee})`);
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
