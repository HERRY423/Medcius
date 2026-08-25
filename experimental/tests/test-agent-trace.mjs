import assert from "node:assert/strict";
import { AgentTracer, saveTrace, getTrace, listRecentTraces } from "../plugins/medcius/servers/api/src/agent-trace.mjs";

console.log("== Testing Agent Observability & Reasoning Trace Engine ==");

const tracer = new AgentTracer("test-session-001", "prescription-review");

// Span 1: PHI Guard
console.log("\n[Test 1] Recording Span 1: PHI Sanitation...");
const s1 = tracer.startSpan("Step 1: PHI Sanitation", { actor: "phiguard" });
tracer.recordToolCall(s1, {
  server: "phiguard",
  tool: "scan",
  args: { text: "患者 张三，身份证 110101199003072345" },
  result: { findings: [{ type: "id_card" }, { type: "name_label" }] },
  durationMs: 3
});
tracer.recordDecision(s1, {
  question: "输入文本中是否包含未脱敏 PHI？",
  options: ["含敏感信息，需假名化", "无敏感信息，直接放行"],
  chosen: "含敏感信息，需假名化",
  rationale: "检测到二代居民身份证与患者姓名，强制执行 HMAC-SHA256 脱敏"
});
tracer.endSpan(s1, { outcome: "COMPLETED", confidence: 1.0 });
console.log("✓ Span 1 recorded successfully");

// Span 2: Drug Safety Gating
console.log("\n[Test 2] Recording Span 2: Drug Safety Gating...");
const s2 = tracer.startSpan("Step 2: Gate 3 Drug Safety Matrix", { actor: "drug-labels" });
tracer.recordToolCall(s2, {
  server: "drug-labels",
  tool: "check_interactions",
  args: { drug1: "阿托伐他汀钙片", drug2: "克拉霉素缓释片" },
  result: { verdict: "FLAG", interaction_level: "CONTRAINDICATED", mechanism: "CYP3A4强效抑制" },
  durationMs: 5
});
tracer.recordDecision(s2, {
  question: "是否放行阿托伐他汀与克拉霉素合用？",
  options: ["放行 (PASS)", "拦截 (FLAG)"],
  chosen: "拦截 (FLAG)",
  rationale: "克拉霉素为强效 CYP3A4 抑制剂，使阿托伐他汀血药浓度上升 4-5 倍，显著增加横纹肌溶解风险",
  evidenceCitation: "《他汀类药物临床应用中国专家共识 (2023)》§4.2"
});
tracer.endSpan(s2, { outcome: "FLAGGED", confidence: 0.99 });
console.log("✓ Span 2 recorded successfully");

// Test 3: Export Trace and Cache
console.log("\n[Test 3] Exporting and caching trace...");
const fullTrace = tracer.exportTrace();
assert.equal(fullTrace.traceId, "test-session-001");
assert.equal(fullTrace.totalSpans, 2);
assert.equal(fullTrace.totalToolCalls, 2);
assert.equal(fullTrace.totalDecisions, 2);

saveTrace(fullTrace);
const retrieved = getTrace("test-session-001");
assert.ok(retrieved);
assert.equal(retrieved.workflowName, "prescription-review");

const list = listRecentTraces(5);
assert.ok(list.length >= 1);
console.log("✓ Trace exported and retrieved. Total tool calls:", fullTrace.totalToolCalls, "Decisions:", fullTrace.totalDecisions);

console.log("\nALL AGENT TRACE TESTS PASSED!");
