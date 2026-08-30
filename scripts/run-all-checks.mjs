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
  { name: "20. Host-Agnostic Hospital Agent Adapter & Fail-Closed Tests", cmd: "node", args: ["tests/test-hospital-agent-adapter.mjs"] },
  { name: "21. Reference Workflow: Independent Physician Annotation & Kappa Tests", cmd: "node", args: ["tests/test-physician-annotation.mjs"] },
  { name: "22. Reference Workflow: Independent Physician Annotation Report", cmd: "node", args: ["plugins/medcius/evals/physician-annotation/physician-annotation-report.mjs"] },
  { name: "23. Workflow Skill Pack: Shift Handover Tests", cmd: "node", args: ["tests/test-shift-handover.mjs"] },
  { name: "24. Workflow Skill Pack: Consultation Preparation Tests", cmd: "node", args: ["tests/test-consult-preparation.mjs"] },
  { name: "25. Workflow Skill Pack: Discharge Readiness & Completeness Tests", cmd: "node", args: ["tests/test-discharge-readiness.mjs"] },
  { name: "26. Clinical Closure: High-Risk Follow-up, Rule Packs & Read-Only Bridge", cmd: "node", args: ["tests/test-clinical-closure.mjs"] },
  { name: "27. Real-System Integration: FHIR R4 / CDA Connector PoC & PHI Exit Guard", cmd: "node", args: ["tests/test-real-connectors.mjs"] },
  { name: "28. Public-Reference Validation: Deterministic Reviewer vs Public Pharmacology Facts", cmd: "node", args: ["plugins/medcius/evals/public-reference-validation/run.mjs"] },
  { name: "29. Performance Baseline: Hot-Path Benchmarks vs Budget Gates", cmd: "node", args: ["plugins/medcius/evals/performance-baseline/bench.mjs"] },
  { name: "30. API Security Hardening: Rate Limit / Brute-Force Lockout / Security Headers", cmd: "node", args: ["tests/test-security-hardening.mjs"] },
  { name: "31. Clinical Landing: Dual-Timestamp, Causal Attribution & Progressive Views", cmd: "node", args: ["tests/test-clinical-landing-advancement.mjs"] },
  { name: "32. Privacy, Air-Gap, SaMD Traceability & Ward Complexity Benchmark", cmd: "node", args: ["tests/test-security-compliance-and-benchmarks.mjs"] },
  { name: "33. Repository Architecture Convergence & Quarantine Linter", cmd: "node", args: ["scripts/lint-repository-convergence.mjs"] },
  { name: "34. Clinical Skill Catalog Governance & Integrity Gate", cmd: "node", args: ["scripts/validate-skill-catalog.mjs"] },
  { name: "35. Enterprise Deployment: IdP JWKS & mTLS Gateway Tests", cmd: "node", args: ["tests/test-enterprise-deployment.mjs"] },
  { name: "36. Cross-Hospital Migration & Heterogeneous Dialect Tests", cmd: "node", args: ["tests/test-cross-hospital-migration.mjs"] },
  { name: "37. Multi-Department Real-World Shadow Study & Time-Motion Analyzer", cmd: "node", args: ["plugins/medcius/evals/shadow-mode/real-world-study-protocol.mjs"] },
  { name: "38. Workflow Pack: NHSA Record Quality & Settlement-List Element Checks", cmd: "node", args: ["tests/test-nhsa-record-quality.mjs"] },
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
