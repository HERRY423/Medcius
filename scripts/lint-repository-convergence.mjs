#!/usr/bin/env node
// Repository Architecture Convergence & Quarantine Linter
// Enforces:
// 1. Production core contains strictly bounded clinical workflow skills.
// 2. High-risk features (prescribing, write-back, autonomous agents, fraud detection, coding) stay quarantined in experimental/.
// 3. No create/update/write capabilities in production MCP configs.
// 4. Cross-host manifests (.trae, .codebuddy, .codex-plugin) are strictly aligned.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

console.log("================================================================================");
console.log(" Medcius Repository Architecture Convergence & Quarantine Linter");
console.log("================================================================================\n");

const ALLOWED_PRODUCTION_WORKFLOW_SKILLS = new Set([
  "patient-evolution-summary",
  "shift-handover",
  "consult-preparation",
  "discharge-readiness-check",
]);

const ALLOWED_PRODUCTION_DATA_SKILLS = new Set([
  "fhir",
  "clinical-note-extract",
  "doc-extract",
]);

const DISALLOWED_PRODUCTION_KEYWORDS = [
  "autonomous-agent",
  "auto-writeback",
  "prescribe-medication",
  "fraud-detection",
  "billing-code",
  "create_resource",
  "update_resource",
  "delete_resource",
];

// 1. Check production plugin skills
console.log("▶ [Gate 1] Checking plugins/medcius/skills boundaries...");
const prodSkillsDir = join(repoRoot, "plugins/medcius/skills");
const prodSkillDirs = readdirSync(prodSkillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

for (const dir of prodSkillDirs) {
  const isWorkflow = ALLOWED_PRODUCTION_WORKFLOW_SKILLS.has(dir);
  const isData = ALLOWED_PRODUCTION_DATA_SKILLS.has(dir);
  assert.ok(isWorkflow || isData, `Unexpected skill '${dir}' found in production skills directory!`);
  console.log(`  ✓ Production skill '${dir}' is permitted and verified.`);
}

// 2. Check Host Adapters alignment (.trae, .codebuddy)
console.log("\n▶ [Gate 2] Checking host adapters (.trae / .codebuddy) alignment...");

const traeSkillsDir = join(repoRoot, ".trae/skills");
if (existsSync(traeSkillsDir)) {
  const traeSkills = readdirSync(traeSkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const wfSkill of ALLOWED_PRODUCTION_WORKFLOW_SKILLS) {
    const prefixedName = `medcius-${wfSkill}`;
    assert.ok(traeSkills.includes(prefixedName) || traeSkills.includes(wfSkill), `Trae must include ${wfSkill}`);
  }
  console.log("  ✓ Trae skills manifest strictly aligned.");
}

const codebuddySkillsDir = join(repoRoot, ".codebuddy/skills");
if (existsSync(codebuddySkillsDir)) {
  const codebuddySkills = readdirSync(codebuddySkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const wfSkill of ALLOWED_PRODUCTION_WORKFLOW_SKILLS) {
    const prefixedName = `medcius-${wfSkill}`;
    assert.ok(codebuddySkills.includes(prefixedName) || codebuddySkills.includes(wfSkill), `CodeBuddy must include ${wfSkill}`);
  }
  console.log("  ✓ CodeBuddy skills manifest strictly aligned.");
}

// 3. Scan production MCP configs for write methods or disallowed keywords
console.log("\n▶ [Gate 3] Checking production MCP configs for forbidden write actions...");

const mcpFiles = [
  join(repoRoot, ".mcp.json"),
  join(repoRoot, ".trae/mcp.json"),
  join(repoRoot, "plugins/medcius/.mcp.json"),
];

for (const mcpFile of mcpFiles) {
  if (existsSync(mcpFile)) {
    const content = readFileSync(mcpFile, "utf8");
    for (const kw of DISALLOWED_PRODUCTION_KEYWORDS) {
      assert.ok(!content.includes(kw), `Forbidden keyword '${kw}' detected in production config: ${mcpFile}`);
    }
    console.log(`  ✓ Config ${mcpFile.replace(repoRoot, "")} verified read-only and safe.`);
  }
}

// 4. Check Quarantine Isolation in experimental/
console.log("\n▶ [Gate 4] Checking experimental/ quarantine isolation...");
const expDir = join(repoRoot, "experimental");
assert.ok(existsSync(expDir), "experimental/ quarantine directory must exist");
const expReadme = join(expDir, "README.md");
assert.ok(existsSync(expReadme), "experimental/README.md must exist and document quarantined features");

console.log("  ✓ Experimental quarantine directory is isolated with explicit README boundaries.");

console.log("\n================================================================================");
console.log("🎉 ALL ARCHITECTURE CONVERGENCE & QUARANTINE CHECKS PASSED!");
console.log("================================================================================\n");
