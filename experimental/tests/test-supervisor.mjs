// Test suite for Supervisor-Worker Multi-Agent Orchestration

import assert from "node:assert/strict";
import { ClinicalSupervisor } from "../plugins/medcius/orchestrator/supervisor.mjs";

console.log("== Testing Supervisor-Worker Multi-Agent System ==");

const supervisor = new ClinicalSupervisor();

// Sample Chinese discharge summary note
const sampleDischargeNote = `
出院记录
姓名：张建国  性别：男  年龄：58岁  住院号：ZY-2026-8899
入院诊断：
1. 冠状动脉粥样硬化性心脏病 不稳定性心绞痛
2. 2型糖尿病
出院诊断：
1. 冠状动脉粥样硬化性心脏病 不稳定性心绞痛
2. 2型糖尿病
3. 原发性高血压3级 极高危
手术操作：
经皮冠状动脉支架植入术
过敏史：
青霉素过敏
检验结果：
血肌酐：95 μmol/L，ALT：28 U/L，AST：22 U/L
`;

// Test 1: Isolated Note Extraction
console.log("\n[Test 1] Note Extraction Worker...");
const extRes = await supervisor.extractNote({ text: sampleDischargeNote, id: "test-note-1" });
assert.equal(extRes.status, "completed");
assert.equal(extRes.record.demographics.age, 58);
assert.equal(extRes.record.demographics.sex, "male");
assert.ok(extRes.record.discharge_diagnosis_primary.value.includes("心绞痛"));
assert.ok(extRes.record.procedures.value.includes("支架植入术"));
console.log("✓ Extraction worker verified");

// Test 2: Coding Worker
console.log("\n[Test 2] Coding Specialist Worker...");
const codeRes = await supervisor.resolveCoding({
  diagnoses: ["冠状动脉粥样硬化性心脏病", "2型糖尿病"],
  procedures: ["经皮冠状动脉支架植入术"],
  patient_gender: "男",
  include_samples: true,
});
assert.ok(codeRes.items.length >= 2);
const diagItem = codeRes.items.find((i) => i.kind === "diagnosis");
assert.ok(diagItem.code, "Must have an ICD code");
assert.ok(diagItem.code_system, "Must have code_system");
assert.ok(diagItem.retrieved_at, "Must have retrieved_at timestamp");
console.log(`✓ Coding worker resolved ${codeRes.items.length} items`);

// Test 3: Pharmacology Review Worker
console.log("\n[Test 3] Pharmacology & Prescription Review Worker...");
const rxRes = await supervisor.reviewPrescription({
  patient: { age: 58, sex_cn: "男", scrUmolL: 95, weightKg: 70 },
  diagnoses: ["冠状动脉粥样硬化性心脏病", "2型糖尿病"],
  drugs: ["阿托伐他汀钙片", "二甲双胍片", "阿司匹林肠溶片"],
  allergies: ["青霉素"],
  include_samples: true,
  signoff: { decision: "agree", signer: "pharmacist_zhang", reason: "All indications match" },
});
assert.ok(["PASS", "FLAG", "INSUFFICIENT_DATA", "REQUIRES_PHARMACIST_REVIEW"].includes(rxRes.verdict));
assert.ok(rxRes.g_gates.g1_patient_info_ok);
assert.ok(rxRes.audit.sequence > 0, "Must record audit event");
console.log(`✓ Prescription review verdict: ${rxRes.verdict}, Audit Seq: ${rxRes.audit.sequence}`);

// Test 4: End-to-End Orchestrated Clinical Encounter
console.log("\n[Test 4] Clinical Supervisor End-to-End Encounter Pipeline...");
const fullEncRes = await supervisor.processEncounter({
  noteText: sampleDischargeNote,
  drugs: ["阿托伐他汀钙片", "阿司匹林肠溶片"],
  allergies: ["青霉素"],
  actor: "dr_wang",
  includeSamples: true,
});
assert.equal(fullEncRes.status, "completed");
assert.ok(fullEncRes.total_duration_ms >= 0);
assert.ok(fullEncRes.timeline.length >= 3);
assert.ok(fullEncRes.coding.items.length > 0);
assert.ok(fullEncRes.pharmacology.verdict);
assert.ok(fullEncRes.audit.sequence > 0);
console.log(`✓ Full encounter pipeline completed in ${fullEncRes.total_duration_ms}ms`);

// Test 5: Audit Chain Integrity
console.log("\n[Test 5] Audit Chain Integrity Verification...");
const chainStatus = supervisor.auditWorker.verifyChain();
assert.equal(chainStatus.verified, true, "Audit hash chain must be verified");
console.log(`✓ Audit chain verified. Verified count: ${chainStatus.records_verified}`);

console.log("\nALL MULTI-AGENT SUPERVISOR TESTS PASSED!");
