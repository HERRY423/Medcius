#!/usr/bin/env node
// Master CI & Quality Gate Validation Runner
// Orchestrates: Skills validation, Compliance Lint, Security/Negative Leakage,
// RBAC/Auth, Governance State Machine, Production Gates, Build Isolation, and synthetic evaluation protocols.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { assessGateResult } from "./lib/gate-result.mjs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
// A validation run must never open an operator's production audit store.
const testDataRoot = mkdtempSync(join(tmpdir(), "medcius-quality-gates-"));

const steps = [
  { name: "Bound Text Anchors & Critical Visibility Negative Controls", cmd: "node", args: ["tests/test-evidence-visibility.mjs"], successPattern: /(?:ℹ|#) tests [1-9]\d*[\s\S]*(?:ℹ|#) fail 0(?:\r?\n|$)/ },
  { name: "Rule Pack Review Handoff & Unverified Approval Rejection", cmd: "node", args: ["tests/test-rule-pack-review.mjs"] },
  { name: "Cross-Evaluation Negative Controls: Six Scorers", cmd: "node", args: ["tests/test-evaluation-negative-controls.mjs"], successPattern: /ALL CROSS-EVALUATION NEGATIVE CONTROLS PASSED/ },
  { name: "Gate Semantics & Configuration Drift Negative Controls", cmd: "node", args: ["tests/test-governance-gates.mjs"] },
  { name: "Controlled Document Baselines & Content Integrity", cmd: "node", args: ["scripts/validate-controlled-documents.mjs"], successPattern: /CONTROLLED DOCUMENTS VALID/ },
  { name: "QMS Listed Machine Checks (human review pending)", cmd: "node", args: ["scripts/qms-internal-audit.mjs", "--no-write"], successPattern: /QMS_MACHINE_SUMMARY: 11\/11; scope=ALL_LISTED_MACHINE_CHECKS; review=PENDING/ },
  { name: "MCP PHI Egress & Public-Key HTTP Authentication", cmd: "node", args: ["tests/test-mcp-egress-and-idp.mjs"] },
  { name: "PHI Integrity Metadata: Deterministic Collisions, Signatures, Audit & Stdio", cmd: "node", args: ["tests/test-phi-integrity-metadata.mjs"], successPattern: /(?:ℹ|#) tests [1-9]\d*[\s\S]*(?:ℹ|#) fail 0(?:\r?\n|$)/ },
  { name: "Rule Policy, Numeric Boundaries & Exact Evidence Anchors", cmd: "node", args: ["tests/test-rule-policy-and-anchors.mjs"] },
  { name: "Actual Engine Challenge & Defective Output Controls", cmd: "node", args: ["plugins/medcius/evals/shadow-mode/engine-challenge.mjs"] },
  { name: "Benefit Measurement Negative Control", cmd: "node", args: ["plugins/medcius/evals/clinical-benefit/run-synthetic.mjs"] },
  { name: "Doctor UI: Context Invalidation, Late Responses, Source Disclosure & Error Recovery", cmd: "node", args: ["tests/test-doctor-ui.mjs"] },
  { name: "Clinician Reading Drafts: Scope, PHI, Ownership, Revision & Governance", cmd: "node", args: ["tests/test-clinician-review-session.mjs"], successPattern: /(?:ℹ|#) tests [1-9]\d*[\s\S]*(?:ℹ|#) fail 0(?:\r?\n|$)/ },
  { name: "MCP Review App: Capability Negotiation, Context, Delivery & Stdio", cmd: "node", args: ["tests/test-review-app.mjs"], successPattern: /(?:ℹ|#) tests [1-9]\d*[\s\S]*(?:ℹ|#) fail 0(?:\r?\n|$)/ },
  { name: "Output Consistency: Shared State, Projection Coverage, Provenance & Mutation Guards", cmd: "node", args: ["tests/test-output-consistency.mjs"] },
  { name: "Research Review: Frozen Evidence, Physician Signature & Benefit Observation Boundaries", cmd: "node", args: ["tests/test-research-review-workflow.mjs"] },
  { name: "Record Changes: Publication, Revision, Cancellation, Arrival & Unknown", cmd: "node", args: ["tests/test-record-change-semantics.mjs"] },
  { name: "Record Versions: Time Boundaries, Replacement Chains & Conflicts", cmd: "node", args: ["tests/test-record-version-edge-cases.mjs"] },
  { name: "Lifecycle Normalizers: Current Imaging & Medication Source States", cmd: "node", args: ["tests/test-lifecycle-normalizers.mjs"] },
  { name: "Lifecycle Draft: Unknown, Open Follow-up & Source Outage", cmd: "node", args: ["tests/test-lifecycle-draft-boundary.mjs"] },
  { name: "Follow-up: Version-Bound Review & Source Availability", cmd: "node", args: ["tests/test-followup-lifecycle.mjs"] },
  { name: "Connectors: Source Lifecycle & Empty / Unavailable Separation", cmd: "node", args: ["tests/test-source-lifecycle.mjs"] },
  { name: "Lifecycle Surface: Summary, Silent Archive & Replay", cmd: "node", args: ["tests/test-lifecycle-surface.mjs"] },
  { name: "JSON Mapped Contracts & Explicit Syntax-Only Checks", cmd: "node", args: ["scripts/validate-json.mjs"], successPattern: /ALL JSON CONTRACTS VALID/ },
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
  { name: "Distinct Evaluation Identities & Evidence Index", cmd: "node", args: ["scripts/build-evidence-index.mjs"] },
];
// These programs produce measurements; their exit status is not endpoint attainment.
const specialSuccess = {
  "tests/test-research-review-workflow.mjs": /Research review:.*checks passed \(synthetic only\)/,
  "tests/test-lifecycle-draft-boundary.mjs": /Lifecycle progressive-view and staged-draft boundary regressions passed/,
  "tests/test-lifecycle-surface.mjs": /PASS: lifecycle surface and frozen replay retain source availability/,
  "tests/test-p0-phi-audit-hardening.mjs": /P0 PHI \/ AUDIT HARDENING PASSED/,
  "tests/test-p0-evidence-integrity.mjs": /P0 evidence integrity: [1-9]\d* adversarial groups passed/,
  "tests/test-p0-authorized-silent-path.mjs": /PASS: authorized silent path, tenant-bound immutable replay archive/,
  "scripts/validate-host-adapters.mjs": /HOST ADAPTERS VALID/,
  "plugins/medcius/scripts/compliance-lint.mjs": /COMPLIANCE LINT PASSED/,
  "scripts/validate-build-isolation.mjs": /BUILD & PACKAGING ISOLATION VALIDATION PASSED/,
  "scripts/validate-gate.mjs": /GATE VALIDATION PASSED/,
  "scripts/run-evals.mjs": /results\/: [1-9]\d* pass \/ 0 fail/,
  "tests/test-shift-handover.mjs": /Handover:.*independent clinical follow-up passed/,
  "tests/test-consult-preparation.mjs": /Reference consultation UI renders source evidence and safely escapes input/,
  "tests/test-discharge-readiness.mjs": /Discharge documentation:.*no clinical discharge verdict passed/,
  "tests/test-clinical-closure.mjs": /Clinical closure tracker, rule-pack fail-closed policy, and heterogeneous read-only bridge passed/,
};
const nodeTestFiles = new Set(["test-mcp-egress-and-idp", "test-rule-policy-and-anchors", "test-doctor-ui", "test-output-consistency", "test-record-change-semantics", "test-record-version-edge-cases", "test-lifecycle-normalizers", "test-followup-lifecycle", "test-source-lifecycle", "test-p0-fact-semantics"].map(name=>`tests/${name}.mjs`));
for (const step of steps) {
  step.kind = step.args[0].includes("/evals/") || ["scripts/corpus-freshness.mjs", "plugins/medcius/scripts/generate-coverage-report.mjs", "scripts/build-evidence-index.mjs"].includes(step.args[0]) ? "report" : "check";
  if (step.kind === "check") step.successPattern ??= specialSuccess[step.args[0]] ?? (nodeTestFiles.has(step.args[0]) ? /(?:ℹ|#) tests [1-9]\d*[\s\S]*(?:ℹ|#) fail 0(?:\r?\n|$)/ : /ALL [^\r\n]+ PASSED/);
}
const receipt = { schema_version: "medcius.quality-gate-execution.v1", run_id: randomUUID(), started_at: new Date().toISOString(), steps: [] };

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
    timeout: 120000,
  });
  const elapsed = Date.now() - start;
  const assessed = assessGateResult(step, res);
  receipt.steps.push({name:step.name,command:[step.cmd,...step.args],kind:step.kind,duration_ms:elapsed,
    expected_evidence:step.successPattern?.source ?? null, output_sha256:createHash("sha256").update(`${res.stdout??""}\n${res.stderr??""}`).digest("hex"),...assessed});

  if (assessed.ok) {
    console.log(`[${step.kind === "report" ? "EXECUTED; ENDPOINT NOT ASSERTED" : "CHECK PASSED"}] (${elapsed}ms)`);
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
receipt.completed_at = new Date().toISOString();
receipt.summary = { completed: passedCount, failed: failedCount, engineering_pass: engineeringFailures === 0,
  synthetic_execution_pass: syntheticFailures === 0, synthetic_validation_pass: "NOT_ESTABLISHED", clinical_evidence_pass: "BLOCKED" };
mkdirSync(join(repoRoot,"out"),{recursive:true});
writeFileSync(join(repoRoot,"out",`quality-gates-${receipt.run_id}.json`),JSON.stringify(receipt,null,2));
writeFileSync(join(repoRoot,"out","quality-gates-latest.json"),JSON.stringify(receipt,null,2));

console.log("\n================================================================================");
console.log(` Quality Gate Summary: ${passedCount} Completed, ${failedCount} Failed / Total ${steps.length} Steps`);
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
