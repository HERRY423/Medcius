// Unit & Integration Tests for Independent Physician Annotation & Adjudication Protocol
// Validates: Double-blind agreement (Cohen's Kappa), 3rd adjudicator resolution,
// sensitivity & Wilson CI calculation, zero critical escape gate, and three-tier classification.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeClinicianCohensKappa,
  evaluatePhysicianAnnotation,
} from "../plugins/medcius/evals/physician-annotation/physician-annotation-engine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

console.log("== Testing Independent Physician Annotation & Adjudication Engine ==");

// ----------------------------------------------------
// Test 1: Cohen's Kappa Pure Function
// ----------------------------------------------------
console.log("\n[Test 1] Testing Cohen's Kappa agreement computation...");

const perfectA = ["present", "abnormal", "clear", "present"];
const perfectB = ["present", "abnormal", "clear", "present"];
const kappaPerfect = computeClinicianCohensKappa(perfectA, perfectB);
assert.equal(kappaPerfect, 1.0, "Perfect agreement must yield Kappa = 1.0");

const discordantA = ["present", "present", "clear", "clear"];
const discordantB = ["clear", "clear", "present", "present"];
const kappaDiscordant = computeClinicianCohensKappa(discordantA, discordantB);
assert.ok(kappaDiscordant < 0, "Complete discordance must yield negative Kappa");

console.log("✓ Cohen's Kappa calculation verified");

// ----------------------------------------------------
// Test 2: Evaluation on Inpatient Ward Benchmark Dataset
// ----------------------------------------------------
console.log("\n[Test 2] Testing evaluation engine on 16-bed cardiology annotation dataset...");

const casesPath = join(repoRoot, "plugins", "medcius", "evals", "physician-annotation", "ward-annotation-cases.json");
const cases = JSON.parse(readFileSync(casesPath, "utf8"));

const evalResult = evaluatePhysicianAnnotation(cases, { isDemo: true });

assert.ok(evalResult.total_cases >= 50, "Must evaluate at least 50 continuous ward cases/items");
assert.ok(Number(evalResult.cohens_kappa) >= 0.80, `Kappa must be >= 0.80 (got ${evalResult.cohens_kappa})`);
assert.equal(evalResult.overall.critical_escapes, 0, "Critical escapes must be exactly 0 (FN=0)");
assert.equal(evalResult.overall.fake_spans, 0, "Fake spans must be exactly 0");
assert.equal(evalResult.allPrimaryMet, true, "All primary endpoints must be met");

console.log(`✓ 16-bed evaluation passed (Cases: ${evalResult.total_cases}, Kappa: ${evalResult.cohens_kappa}, Sensitivity: ${evalResult.overall.sensitivity.str})`);

// ----------------------------------------------------
// Test 3: Three-Tier Pass Classification Boundary Check
// ----------------------------------------------------
console.log("\n[Test 3] Testing three-tier pass classification boundary...");

assert.equal(evalResult.passClassification.engineering_pass, true, "Engineering pass must be true");
assert.equal(evalResult.passClassification.synthetic_validation_pass, true, "Synthetic pass must be true in demo");
assert.equal(
  evalResult.passClassification.clinical_evidence_pass,
  false,
  "Clinical evidence pass must be strictly false for demo/sandbox data without IRB"
);

console.log("✓ Three-tier pass classification verified (clinical_evidence_pass strictly guarded)");

// ----------------------------------------------------
// Test 5: Unadjudicated Disagreement Gate Rejection
// ----------------------------------------------------
console.log("\n[Test 5] Testing unadjudicated disagreement blocks passing...");

const unadjudicatedCases = [
  {
    id: "case-disagree-1",
    dimension: "clinical_symptoms",
    physician_a: "present",
    physician_b: "clear",
    adjudicator: null, // Unadjudicated!
    ai_extracted: "present",
    is_critical_point: false,
    is_verbatim_span: true,
  },
];

const unadjudicatedRes = evaluatePhysicianAnnotation(unadjudicatedCases, { isDemo: true });
assert.equal(unadjudicatedRes.unadjudicated_cases_count, 1);
assert.equal(unadjudicatedRes.endpoints.all_disagreements_adjudicated, false);
assert.equal(unadjudicatedRes.allPrimaryMet, false, "Unadjudicated disagreements must block allPrimaryMet");

console.log("✓ Unadjudicated disagreement correctly blocked overall pass");

console.log("\nALL PHYSICIAN ANNOTATION ENGINE TESTS PASSED!");
