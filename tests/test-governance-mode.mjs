// Test Suite for Stepwise Clinical Release Governance State Machine

import assert from "node:assert/strict";
import { GovernanceStateManager, GOVERNANCE_STAGES } from "../plugins/medcius/lib/governance-mode.mjs";

console.log("== Testing Stepwise Release Governance State Machine ==");

// Test 1: Initial state is Level 1 (Retrospective Study)
console.log("\n[Test 1] Initial Stage Verification...");
const gov = new GovernanceStateManager("retrospective_study");
const stage1 = gov.getCurrentStage();
assert.equal(stage1.id, "retrospective_study");
assert.equal(stage1.level, 1);
assert.equal(stage1.allows_his_writeback, false);
console.log(`✓ Initial stage is Level 1: ${stage1.name_cn}`);

// Test 2: Writeback blocked in Level 1
console.log("\n[Test 2] Testing writeback blockage in Level 1...");
assert.throws(
  () => gov.assertWritebackAllowed("his_prescription_update"),
  /【发布门禁拦截】/,
  "Must block HIS writeback in retrospective_study stage",
);
console.log("✓ Writeback correctly blocked in Level 1");

// Test 3: Attempting to skip stages (Level 1 -> Level 3) MUST fail
console.log("\n[Test 3] Testing prohibited stage skipping (Level 1 -> Level 3)...");
assert.throws(
  () => {
    gov.advanceStage({
      targetStageId: "advisory_mode",
      actor: "admin:overreach",
      reason: "Attempting to skip pilot directly to advisory",
      evidence: {
        pipeline_unit_tests_pass: true,
        eval_baseline_verified: true,
      },
    });
  },
  /跨级发布被严格禁止/,
  "Must prohibit skipping governance stages",
);
console.log("✓ Stage skipping strictly blocked");

// Test 4: Missing prerequisites when advancing (Level 1 -> Level 2) MUST fail
console.log("\n[Test 4] Testing missing prerequisites check...");
assert.throws(
  () => {
    gov.advanceStage({
      targetStageId: "silent_pilot",
      actor: "admin:qa",
      reason: "Advance to silent pilot",
      evidence: {
        retrospective_study_completed: true,
        // missing ethics_and_privacy_approved & shadow_protocol_registered
      },
    });
  },
  /阶段准入准则未满足/,
  "Must reject transition if prerequisites are missing",
);
console.log("✓ Prerequisite validation strictly enforced");

// Test 5: Sequential Progression (Level 1 -> 2 -> 3 -> 4)
console.log("\n[Test 5] Sequential Stage Evolution...");

// 5a. Advance to Level 2: Silent Pilot
const adv2 = gov.advanceStage({
  targetStageId: "silent_pilot",
  actor: "admin:clinical_lead",
  reason: "Retrospective study baseline verified, ethics board approved",
  evidence: {
    retrospective_study_completed: true,
    ethics_and_privacy_approved: true,
    shadow_protocol_registered: true,
  },
});
assert.equal(adv2.current_stage.level, 2);
assert.equal(gov.getCurrentStage().id, "silent_pilot");
assert.throws(() => gov.assertWritebackAllowed(), /【发布门禁拦截】/);
console.log(`✓ Advanced to Level 2: ${adv2.current_stage.name_cn}`);

// 5b. Advance to Level 3: Advisory Mode
const adv3 = gov.advanceStage({
  targetStageId: "advisory_mode",
  actor: "admin:clinical_lead",
  reason: "Silent pilot multi-center shadow study achieved primary endpoints",
  evidence: {
    silent_pilot_shadow_study_passed: true,
    primary_endpoints_met: true,
    pharmacist_training_completed: true,
  },
});
assert.equal(adv3.current_stage.level, 3);
assert.equal(gov.getCurrentStage().id, "advisory_mode");
assert.throws(() => gov.assertWritebackAllowed(), /【发布门禁拦截】/);
console.log(`✓ Advanced to Level 3: ${adv3.current_stage.name_cn}`);

// 5c. Advance to Level 4: Certified Writeback
const adv4 = gov.advanceStage({
  targetStageId: "certified_writeback",
  actor: "admin:chief_officer",
  reason: "1000 live advisory cases audited, zero safety escapes, digital signature live",
  evidence: {
    advisory_mode_live_cases_met: true,
    zero_critical_miss_certified: true,
    digital_signature_infrastructure_ready: true,
  },
});
assert.equal(adv4.current_stage.level, 4);
assert.equal(gov.getCurrentStage().id, "certified_writeback");

// Now writeback is permitted!
assert.equal(gov.assertWritebackAllowed("his_prescription_update"), true);
console.log(`✓ Advanced to Level 4: ${adv4.current_stage.name_cn} — HIS Writeback Unlocked`);

// Test 6: Production environment blocks setting certified stage via environment variable
console.log("\n[Test 6] Testing prohibited environment variable jump in production...");
const prevEnv = process.env.NODE_ENV;
const prevStage = process.env.MEDCIUS_GOVERNANCE_STAGE;
try {
  process.env.NODE_ENV = "production";
  process.env.MEDCIUS_GOVERNANCE_STAGE = "certified_writeback";
  assert.throws(
    () => new GovernanceStateManager(),
    /FATAL_PROD_GOVERNANCE_ERROR/,
    "Must prohibit setting certified_writeback via environment variable in production",
  );
  console.log("✓ Arbitrary environment variable promotion to certified_writeback strictly prohibited in production");
} finally {
  if (prevEnv) process.env.NODE_ENV = prevEnv; else delete process.env.NODE_ENV;
  if (prevStage) process.env.MEDCIUS_GOVERNANCE_STAGE = prevStage; else delete process.env.MEDCIUS_GOVERNANCE_STAGE;
}

console.log("\nALL GOVERNANCE STATE MACHINE & EVIDENCE REGISTRY TESTS PASSED!");
