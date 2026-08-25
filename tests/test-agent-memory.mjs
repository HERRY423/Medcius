import assert from "node:assert/strict";
import { HANDLERS } from "../plugins/medcius/servers/memory/src/tools.mjs";

console.log("== Testing Agent Memory & Adaptive Learning Server ==");

// Test 1: Remember clinical guideline / institutional knowledge
console.log("\n[Test 1] Storing memory with remember()...");
const mem1 = HANDLERS.remember({
  scope: "hospital",
  scope_id: "HOSP-001",
  key: "preferred_antibiotic_protocol",
  content: {
    first_line_cap: "头孢曲松 + 阿奇霉素",
    allergy_substitute: "莫西沙星",
    notes: "呼吸内科社区获得性肺炎指南推荐方案"
  },
  tags: ["pneumonia", "antibiotics", "guidelines"],
  source_ref: "doc:cma-respiratory-2024",
  confidence: 0.98
});
assert.equal(mem1.ok, true);
assert.ok(mem1.id);
console.log("✓ Stored memory id:", mem1.id);

// Test 2: Remember doctor-specific preference
console.log("\n[Test 2] Storing doctor-level memory...");
const mem2 = HANDLERS.remember({
  scope: "doctor",
  scope_id: "DOC-882",
  key: "ckd_dosage_preference",
  content: "对于 CrCl < 30 的患者倾向于使用低剂量利伐沙班 10mg qd",
  tags: ["nephrology", "anticoagulant"],
  confidence: 0.95
});
assert.equal(mem2.ok, true);
console.log("✓ Stored doctor memory:", mem2.key);

// Test 3: Recall by scope and query
console.log("\n[Test 3] Recalling memories with recall()...");
const recall1 = HANDLERS.recall({
  scope: "hospital",
  query: "antibiotic"
});
assert.ok(recall1.count >= 1);
assert.equal(recall1.memories[0].key, "preferred_antibiotic_protocol");
assert.equal(recall1.memories[0].content.allergy_substitute, "莫西沙星");
console.log("✓ Recalled memory successfully, count =", recall1.count);

// Test 4: Record learning from override
console.log("\n[Test 4] Recording learning from pharmacist override...");
const learn1 = HANDLERS.learn_from_override({
  event_type: "override",
  audit_seq: 42,
  doctor_id: "DOC-882",
  department: "心内科",
  original_verdict: "FLAG",
  pharmacist_verdict: "PASS",
  rationale: "患者为肌酐清除率 45ml/min 的轻中度肾损，阿托伐他汀无需减量，原系统拦截过于严格",
  rule_affected: "rule:statin_renal_adjustment",
  suggested_action: "放宽阿托伐他汀轻中度肾功能不全时的硬阻断提示"
});
assert.equal(learn1.ok, true);
assert.ok(learn1.learning_id);
console.log("✓ Recorded learning log id:", learn1.learning_id);

// Test 5: Check learning statistics
console.log("\n[Test 5] Checking learning stats...");
const stats = HANDLERS.learning_stats();
assert.ok(stats.total_memories >= 2);
assert.ok(stats.total_learning_events >= 1);
console.log("✓ Learning stats:", JSON.stringify(stats, null, 2));

console.log("\nALL AGENT MEMORY TESTS PASSED!");
