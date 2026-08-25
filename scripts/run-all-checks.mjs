#!/usr/bin/env node
// Master CI & Quality Gate Validation Runner
// Orchestrates: Skills validation, Compliance Lint, Security/Negative Leakage,
// RBAC/Auth, Governance State Machine, Production Gates, Build Isolation, and synthetic evaluation protocols.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const steps = [
  { name: "1. Skills Manifest Validation", cmd: "node", args: ["scripts/validate-skills.mjs"] },
  { name: "2. Cross-host MCP, Rules & Skills Adapter Validation", cmd: "node", args: ["scripts/validate-host-adapters.mjs"] },
  { name: "3. Regulatory Boundary & DHF Compliance Lint", cmd: "node", args: ["plugins/medcius/scripts/compliance-lint.mjs"] },
  { name: "4. Build & Packaging Sample Isolation Gate", cmd: "node", args: ["scripts/validate-build-isolation.mjs"] },
  { name: "5. Production Hard Gate H01 Validation", cmd: "node", args: ["scripts/validate-gate.mjs"] },
  { name: "6. Knowledge Base Coverage & SLA Report", cmd: "node", args: ["plugins/medcius/scripts/generate-coverage-report.mjs"] },
  { name: "7. Synthetic Multi-Center Shadow-Study Protocol Engine", cmd: "node", args: ["plugins/medcius/evals/shadow-mode/shadow-study.mjs", "--run-demo"] },
  { name: "8. Security & PHI Guard Negative Leakage Tests", cmd: "node", args: ["tests/test-negative-leakage.mjs"] },
  { name: "9. AES-256-GCM Secure Storage Tests", cmd: "node", args: ["tests/test-security.mjs"] },
  { name: "10. SMART/OIDC Auth, RBAC & Multi-Tenancy Tests", cmd: "node", args: ["tests/test-auth-and-rbac.mjs"] },
  { name: "11. Stepwise Governance State Machine Tests", cmd: "node", args: ["tests/test-governance-mode.mjs"] },
  { name: "12. Reference Workflow: CDS Hooks 2.0 Integration & Fail-Closed Tests", cmd: "node", args: ["tests/test-cds-hooks.mjs"] },
  { name: "13. Reference Workflow: RESTful API Routes & Security Gate Tests", cmd: "node", args: ["tests/test-api-routes.mjs"] },
  { name: "14. Reference Workflow: Inpatient Pre-Round Patient Evolution Tests", cmd: "node", args: ["tests/test-preround-summary.mjs"] },
  { name: "15. Synthetic Evaluation Benchmark & Traps", cmd: "node", args: ["scripts/run-evals.mjs"] },
  { name: "16. Reference Workflow: Synthetic Consecutive-Case Silent Validation", cmd: "node", args: ["plugins/medcius/evals/shadow-mode/ward-consecutive-validation.mjs"] },
  { name: "17. Reference Workflow: Synthetic Physician Time-Motion Protocol", cmd: "node", args: ["plugins/medcius/evals/time-motion/time-motion-study.mjs"] },
  { name: "18. Reference Workflow: Hospital Multi-Source Adapter Tests", cmd: "node", args: ["tests/test-multisource-adapter.mjs"] },
  { name: "19. Reference Workflow: Clinical Safety Contract Tests", cmd: "node", args: ["tests/test-clinical-safety-rules.mjs"] },
];

console.log("================================================================================");
console.log(" Medcius Full CI Quality Gate & Synthetic Validation Pipeline");
console.log("================================================================================\n");

let passedCount = 0;
let failedCount = 0;

for (const step of steps) {
  process.stdout.write(`▶ Running: ${step.name}... `);
  const start = Date.now();
  const res = spawnSync(step.cmd, step.args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const elapsed = Date.now() - start;

  if (res.status === 0) {
    console.log(`[PASS] (${elapsed}ms)`);
    passedCount++;
  } else {
    console.log(`[FAIL] (${elapsed}ms, exit code ${res.status})`);
    if (res.stdout) console.log(res.stdout.slice(0, 800));
    if (res.stderr) console.error(res.stderr.slice(0, 800));
    failedCount++;
  }
}

console.log("\n================================================================================");
console.log(` Quality Gate Summary: ${passedCount} Passed, ${failedCount} Failed / Total ${steps.length} Gates`);
console.log("================================================================================");
console.log(" Three-Tier Pass Status Classification:");
console.log(` - 1. engineering_pass:          ${failedCount === 0 ? "🟢 PASS (All CI Unit Tests & Quality Gates Passed)" : "🔴 FAIL"}`);
console.log(` - 2. synthetic_validation_pass:  ${failedCount === 0 ? "🟢 PASS (Synthetic Benchmarks & Traps Verified)" : "🔴 FAIL"}`);
console.log(` - 3. clinical_evidence_pass:    🔒 BLOCKED (Requires approved real-world study and independent clinician labeling)`);
console.log("================================================================================");

if (failedCount === 0) {
  console.log("🎉 ALL QUALITY GATES, SECURITY TESTS & PRODUCTION HARDENING VALIDATIONS PASSED!");
  process.exit(0);
} else {
  console.error(`❌ CI Quality Gate validation failed (${failedCount} gates failed).`);
  process.exit(1);
}
