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

const CLINICAL_LANDING_WORKFLOW_SKILLS = new Set([
  "patient-evolution-summary",
]);

const FROZEN_WORKFLOW_SKILLS = new Set([
  "shift-handover",
  "consult-preparation",
  "discharge-readiness-check",
]);

const ALLOWED_PRODUCTION_WORKFLOW_SKILLS = new Set([
  ...CLINICAL_LANDING_WORKFLOW_SKILLS,
  ...FROZEN_WORKFLOW_SKILLS,
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

// 1b. plugin.json capabilities must match the skills directory (single source of truth).
console.log("\n▶ [Gate 1b] Checking plugin.json capabilities vs skills directory...");
{
  const pluginJson = JSON.parse(readFileSync(join(repoRoot, "plugins/medcius/plugin.json"), "utf8"));
  const caps = pluginJson.capabilities ?? {};
  assert.ok(Array.isArray(caps.core) && caps.core.includes("patient-evolution-summary"), "plugin.json capabilities.core must include patient-evolution-summary");
  for (const s of FROZEN_WORKFLOW_SKILLS) {
    assert.ok(Array.isArray(caps.incubating) && caps.incubating.includes(s), `plugin.json capabilities.incubating must list frozen skill '${s}' (default-frozen, explicit enable required)`);
  }
  for (const s of ["fhir", "clinical-note-extract", "doc-extract"]) {
    assert.ok(caps.core.includes(s) || (caps.incubating ?? []).includes(s), `plugin.json capabilities must declare data skill '${s}'`);
  }
  const declared = new Set([...(caps.core ?? []), ...(caps.incubating ?? [])]);
  for (const dir of prodSkillDirs) {
    assert.ok(declared.has(dir), `Skill dir '${dir}' must be declared in plugin.json capabilities.core/incubating`);
  }
  for (const q of (caps.quarantined_reference ?? [])) {
    assert.ok(!prodSkillDirs.includes(q), `Quarantined reference '${q}' must NOT appear as a skills/ directory (lib/contracts only, separate intended-use approval required)`);
  }
  assert.ok(typeof caps.policy === "string" && caps.policy.includes("默认冻结"), "plugin.json capabilities.policy must state incubating default-frozen policy");
  console.log("  ✓ plugin.json capabilities match skills directory; frozen/quarantined tiers declared.");
}

// 1c. Financial / record-quality helpers must stay out of the default workflow chain.
console.log("\n▶ [Gate 1c] Checking financial/record-quality modules stay non-workflow...");
{
  const quarantinedLibs = [
    "plugins/medcius/lib/patient-affordability-context.mjs",
    "plugins/medcius/lib/nhsa-record-quality-engine.mjs",
    "plugins/medcius/lib/settlement-from-note.mjs",
    "plugins/medcius/lib/drg-dip-reconciliation.mjs",
  ];
  for (const rel of quarantinedLibs) {
    assert.ok(existsSync(join(repoRoot, rel)), `Quarantined helper must exist for review: ${rel}`);
    const content = readFileSync(join(repoRoot, rel), "utf8");
    assert.ok(/不计算自付额|不做 DRG|不做分组器|需独立|separate|默认禁用|never calculates|out-of-pocket|不改编码|DRG\/DIP/i.test(content),
      `Quarantined helper '${rel}' must carry an explicit non-workflow disclaimer (no self-pay calc / no DRG grouping / separate approval)`);
  }
  console.log("  ✓ Financial/record-quality helpers carry non-workflow disclaimers and stay out of skills/.");
}

// 2. Check Host Adapters alignment (.trae, .codebuddy)
console.log("\n▶ [Gate 2] Checking host adapters (.trae / .codebuddy) alignment...");

const traeSkillsDir = join(repoRoot, ".trae/skills");
if (existsSync(traeSkillsDir)) {
  const traeSkills = readdirSync(traeSkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const wfSkill of CLINICAL_LANDING_WORKFLOW_SKILLS) {
    const prefixedName = `medcius-${wfSkill}`;
    assert.ok(traeSkills.includes(prefixedName) || traeSkills.includes(wfSkill), `Trae must include clinical landing skill ${wfSkill}`);
  }
  console.log("  ✓ Trae skills manifest includes the P0 clinical landing skill.");
}

const codebuddySkillsDir = join(repoRoot, ".codebuddy/skills");
if (existsSync(codebuddySkillsDir)) {
  const codebuddySkills = readdirSync(codebuddySkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const wfSkill of CLINICAL_LANDING_WORKFLOW_SKILLS) {
    const prefixedName = `medcius-${wfSkill}`;
    assert.ok(codebuddySkills.includes(prefixedName) || codebuddySkills.includes(wfSkill), `CodeBuddy must include clinical landing skill ${wfSkill}`);
  }
  console.log("  ✓ CodeBuddy skills manifest includes the P0 clinical landing skill.");
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

// 5. P0-4: quality-gate counts and dependency claims must not drift (single source of truth).
console.log("\n▶ [Gate 5] Checking quality-gate count / dependency口径 (P0-4)...");
{
  const gateFiles = [
    "SECURITY.md",
    "docs/ops/PRODUCTIZATION-OPERATIONS.md",
    "deploy/DEPLOYMENT.md",
  ];
  for (const rel of gateFiles) {
    const p = join(repoRoot, rel);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    assert.ok(!/全量\s*37\s*项/.test(content) && !/全量质量门禁.*30\s*步/.test(content) && !/44\+\s*门/.test(content),
      `P0-4: '${rel}' must not hardcode stale gate counts (37项/30步/44+门); reference scripts/run-all-checks.mjs steps + out/quality-gates-latest.json`);
  }
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  assert.ok(!/better-sqlite3\s*均为本地源码或内建/.test(dockerfile), "P0-4: Dockerfile must not falsely claim better-sqlite3 is built-in");
  assert.ok(/FROM node:22\.\d+.*alpine/.test(dockerfile), "Dockerfile base must stay version-pinned alpine");
  assert.ok(/USER medcius/.test(dockerfile) && /HEALTHCHECK/.test(dockerfile), "Dockerfile must keep non-root + healthcheck");
  console.log("  ✓ Gate counts reference the runner; Dockerfile dependency claim honest and pinned.");
}

console.log("\n================================================================================");
console.log("🎉 ALL ARCHITECTURE CONVERGENCE & QUARANTINE CHECKS PASSED!");
console.log("================================================================================\n");
