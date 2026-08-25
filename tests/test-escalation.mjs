import assert from "node:assert/strict";
import { EscalationProtocol } from "../plugins/medcius/orchestrator/escalation.mjs";
import { ClinicalSupervisor } from "../plugins/medcius/orchestrator/supervisor.mjs";

console.log("== Testing Multi-Agent Cross-Validation & Escalation Protocol ==");

const protocol = new EscalationProtocol();

// Test 1: Cross-validation detects renal failure without diagnosis code
console.log("\n[Test 1] Testing cross-validation: CrCl < 30 without renal diagnosis...");
const crossVal1 = protocol.crossValidateWorkers({
  extraction: {},
  coding: { diagnoses: [{ code: "I10", term: "高血压" }] },
  pharma: { renal_metrics: { crcl: 22.4 } }
});
assert.equal(crossVal1.crossValidationPassed, false);
assert.equal(crossVal1.alertsCount, 1);
assert.equal(crossVal1.alerts[0].type, "CLINICAL_DISCORDANCE");
console.log("✓ Clinical discordance alert triggered:", crossVal1.alerts[0].title);

// Test 2: Cross-validation passes when renal diagnosis is present
console.log("\n[Test 2] Testing cross-validation when renal diagnosis is present...");
const crossVal2 = protocol.crossValidateWorkers({
  extraction: {},
  coding: { diagnoses: [{ code: "N18.4", term: "慢性肾脏病4期" }] },
  pharma: { renal_metrics: { crcl: 22.4 } }
});
assert.equal(crossVal2.crossValidationPassed, true);
assert.equal(crossVal2.alertsCount, 0);
console.log("✓ Cross-validation passed cleanly");

// Test 3: Escalation threshold evaluation
console.log("\n[Test 3] Testing escalation threshold evaluation...");
const esc1 = protocol.evaluateEscalationThreshold({
  pharmaVerdict: { verdict: "REQUIRES_PHARMACIST_REVIEW" },
  crossValidationAlerts: []
});
assert.equal(esc1.shouldEscalate, true);
assert.equal(esc1.escalationTier, "TIER_2_SENIOR_PHARMACIST");
console.log("✓ Tier 2 Senior Pharmacist escalation triggered for unknown drug");

// Test 4: End-to-end Supervisor integration with escalation
console.log("\n[Test 4] Running ClinicalSupervisor with cross-validation...");
const supervisor = new ClinicalSupervisor();
const enc = await supervisor.processEncounter({
  noteText: "患者因心悸入院。诊断：房颤。查肌酐 310 μmol/L。出院予以利伐沙班口服。",
  drugs: [{ name: "利伐沙班片", dosage: "20mg qd" }],
  allergies: ["无"]
});
assert.ok(enc.cross_validation);
assert.ok(enc.escalation);
console.log("✓ Full encounter processed with cross-validation and escalation tiers:", enc.summary.escalation_tier);

console.log("\nALL MULTI-AGENT ESCALATION TESTS PASSED!");
