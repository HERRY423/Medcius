import assert from "node:assert/strict";
import { learningEngine } from "../plugins/medcius/servers/api/src/learning-engine.mjs";

console.log("== Testing Adaptive Learning & Rule Feedback Engine ==");

// Test 1: Process pharmacist override feedback
console.log("\n[Test 1] Processing pharmacist override feedback...");
const feedback1 = await learningEngine.processSignoffFeedback({
  auditSeq: 55,
  doctorId: "DOC-882",
  department: "心内科",
  originalVerdict: "FLAG",
  pharmacistVerdict: "PASS",
  signoffType: "override",
  rationale: "患者合并重度肺部感染，权衡利弊后在密切监测肝功能的前提下联用",
  ruleAffected: "rule:statin_macrolide_interaction"
});
assert.equal(feedback1.ok, true);
assert.ok(feedback1.learning_id);
console.log("✓ Processed override feedback, id:", feedback1.learning_id);
console.log("  Suggested action:", feedback1.suggested_action);

// Test 2: Suggest formal rule updates
console.log("\n[Test 2] Generating rule update suggestions...");
const ruleUpdates = await learningEngine.suggestRuleUpdates();
assert.ok(ruleUpdates.suggestions.length >= 2);
assert.equal(ruleUpdates.suggestions[0].status, "PROPOSED");
console.log("✓ Rule update proposals generated, count:", ruleUpdates.proposed_rule_updates_count);
console.log("  Proposal 1:", ruleUpdates.suggestions[0].title);
console.log("  Proposal 2:", ruleUpdates.suggestions[1].title);

console.log("\nALL ADAPTIVE LEARNING TESTS PASSED!");
