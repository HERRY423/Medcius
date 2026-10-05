#!/usr/bin/env node
// Master CI & Quality Gate Validation Runner
// Orchestrates: Skills validation, Compliance Lint, Security/Negative Leakage,
// RBAC/Auth, Governance State Machine, Production Gates, Build Isolation, and synthetic evaluation protocols.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
// A validation run must never open an operator's production audit store.
const testDataRoot = mkdtempSync(join(tmpdir(), "medcius-quality-gates-"));

const steps = [
  { name: "Record Changes: Publication, Revision, Cancellation, Arrival & Unknown", cmd: "node", args: ["tests/test-record-change-semantics.mjs"] },
  { name: "Record Versions: Time Boundaries, Replacement Chains & Conflicts", cmd: "node", args: ["tests/test-record-version-edge-cases.mjs"] },
  { name: "Lifecycle Normalizers: Current Imaging & Medication Source States", cmd: "node", args: ["tests/test-lifecycle-normalizers.mjs"] },
  { name: "Lifecycle Draft: Unknown, Open Follow-up & Source Outage", cmd: "node", args: ["tests/test-lifecycle-draft-boundary.mjs"] },
  { name: "Follow-up: Version-Bound Review & Source Availability", cmd: "node", args: ["tests/test-followup-lifecycle.mjs"] },
  { name: "Connectors: Source Lifecycle & Empty / Unavailable Separation", cmd: "node", args: ["tests/test-source-lifecycle.mjs"] },
  { name: "Lifecycle Surface: Summary, Silent Archive & Replay", cmd: "node", args: ["tests/test-lifecycle-surface.mjs"] },
  { name: "JSON Contract Syntax Validation", cmd: "node", args: ["scripts/validate-json.mjs"] },
  { name: "P0: Boundary, Evidence Status & Frozen Silent Path", cmd: "node", args: ["tests/test-boundary-evidence-silent-path.mjs"] },
  { name: "P0: Exact Evidence Text, Missing Data & Measurement Semantics", cmd: "node", args: ["tests/test-p0-fact-semantics.mjs"] },
  { name: "P0: Field-Aware PHI, Signed Decisions & Audit Integrity", cmd: "node", args: ["tests/test-p0-phi-audit-hardening.mjs"] },
  { name: "P0: Evaluation Integrity & Missing Observations", cmd: "node", args: ["tests/test-p0-evidence-integrity.mjs"] },
  { name: "P0: Authorized Source, Tenant Archive & Silent HTTP Boundary", cmd: "node", args: ["tests/test-p0-authorized-silent-path.mjs"] },
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
  { name: "38. P0 Clinical Landing: HIS Embed, Frozen Skills, View Library, Silent Pilot, Stopwatch", cmd: "node", args: ["tests/test-p0-clinical-landing.mjs"] },
  { name: "39. Evaluation Findings Rectification: Claim Verifier, Lab NLP, LIS/NIS & PHI (F-01 to F-14)", cmd: "node", args: ["tests/test-core-findings-rectification.mjs"] },
  { name: "40. Workflow Pack: NHSA Record Quality & Settlement-List Element Checks", cmd: "node", args: ["tests/test-nhsa-record-quality.mjs"] },
  { name: "41. Real-Data Channels: P3 View-DB / P4 HL7 v2 Read-Only Connectors & PHI Exit Guard", cmd: "node", args: ["tests/test-real-data-channels.mjs"] },
  { name: "42. Real-World Noise Robustness Benchmark & Desensitized-Data Ingest Gate", cmd: "node", args: ["plugins/medcius/evals/real-world-noise/run-noise-benchmark.mjs"] },
  { name: "43. Noise Benchmark & Real-Data Ingest Channel Unit Tests", cmd: "node", args: ["tests/test-noise-benchmark.mjs"] },
  { name: "44. Doctor Workstation: Directory Auth, Governance-Gated Reports & CA Signoff", cmd: "node", args: ["tests/test-doctor-workstation.mjs"] },
  { name: "45. Corpus Supply Chain: Official-Source Registry & Freshness SLA (informational)", cmd: "node", args: ["scripts/corpus-freshness.mjs"] },
  { name: "46. Corpus Supply Chain & Regulatory Readiness: Fetch Pipeline, Reconciliation, Classification Gate, Executable Audit", cmd: "node", args: ["tests/test-corpus-supply-chain.mjs"] },
  { name: "47. Runtime Product Form: Container Discipline, Deployer, Resident Probe, LLM Config Management", cmd: "node", args: ["tests/test-deployment-runtime.mjs"] },
];

console.log("================================================================================");
console.log(" Medcius Full CI Quality Gate & Synthetic Validation Pipeline");
console.log("================================================================================\n");

let passedCount = 0;
let failedCount = 0;
let engineeringFailures = 0;
let syntheticFailures = 0;

for (const step of steps) {
  process.stdout.write(`▶ Running: ${step.name}... `);
  const start = Date.now();
  const res = spawnSync(step.cmd, step.args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_MEDCIUS_DATA: testDataRoot, MEDCIUS_DATA: testDataRoot, NODE_NO_WARNINGS: "1" },
    maxBuffer: 16 * 1024 * 1024,
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
    if (step.args.some((arg) => arg.includes("/evals/") || arg === "scripts/run-evals.mjs")) syntheticFailures++;
    else engineeringFailures++;
  }
}

console.log("\n================================================================================");
console.log(` Quality Gate Summary: ${passedCount} Passed, ${failedCount} Failed / Total ${steps.length} Gates`);
console.log("================================================================================");
console.log(" Three-Tier Pass Status Classification:");
console.log(` - 1. engineering_pass:          ${engineeringFailures === 0 ? "🟢 PASS (Listed engineering checks passed)" : "🔴 FAIL"}`);
console.log(` - 2. synthetic_execution_pass:   ${syntheticFailures === 0 ? "🟢 PASS (Listed synthetic scripts completed)" : "🔴 FAIL"}`);
console.log("      synthetic_validation_pass: NOT_ESTABLISHED (Protocol endpoints are reported separately; execution success is not endpoint success)");
console.log(` - 3. clinical_evidence_pass:    🔒 BLOCKED (Requires approved real-world study and independent clinician labeling)`);
console.log("================================================================================");

if (failedCount === 0) {
  console.log("All listed engineering checks and synthetic script executions completed successfully; clinical and deployment acceptance remain separate.");
  process.exit(0);
} else {
  console.error(`❌ CI Quality Gate validation failed (${failedCount} gates failed).`);
  process.exit(1);
}
