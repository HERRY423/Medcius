#!/usr/bin/env node
// Performance Baseline Bench (性能基线).
//
// Deterministic, side-effect-free micro/macro benchmarks over the hot paths:
//   1. read-only bridge snapshot assembly (connector fan-in + provenance)
//   2. full pre-round workflow via HospitalAgentAdapter (bridge -> engine)
//   3. PHI Guard pseudonymization (clinical narrative)
//   4. audit-chain crypto primitives (canonicalJson + sha256 + chainHash)
//   5. public-reference reviewer (six-dimension rule evaluation)
//
// Gate semantics: mean op latency must stay under the fixed budget. The legacy
// budget-factor setting accepts only 1; it cannot relax the 80 ms pre-round gate.
// Budgets are stability ceilings, not SLOs; regressions vs
// the recorded baseline report should be reviewed even inside budget.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { ReadOnlyHospitalDataBridge } from "../../lib/read-only-hospital-data-bridge.mjs";
import { HospitalAgentAdapter } from "../../lib/hospital-agent-adapter.mjs";
import { pseudonymizeText } from "../../servers/phiguard/src/lib.mjs";
import { canonicalJson, sha256Hex } from "../../servers/shared/crypto.mjs";
import { chainHash } from "../../servers/audit/src/db.mjs";
import { loadPack, reviewCase } from "../public-reference-validation/reference-reviewer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const outReport = argOf("--out") || join(__dirname, "reports", "performance-baseline.md");

const budgetFactor = Number(process.env.MEDCIUS_PERF_BUDGET_FACTOR || 1);
if (budgetFactor !== 1) {
  console.error("MEDCIUS_PERF_BUDGET_FACTOR must be exactly 1; fixed performance gates cannot be relaxed.");
  process.exit(1);
}

const context = {
  tenant_id: "perf-sandbox",
  doctor_id: "doctor-perf-1",
  patient_id: "patient-perf-1",
  encounter_id: "encounter-perf-1",
};

function envelope(sourceSystem, records) {
  return {
    source_system: sourceSystem,
    tenant_id: context.tenant_id,
    patient_id: context.patient_id,
    encounter_id: context.encounter_id,
    fetched_at: "2026-08-25T07:00:00Z",
    source_version: "perf-v1",
    records,
  };
}

function buildBridge() {
  const lisRecords = Array.from({ length: 12 }, (_, i) => ({
    id: `lis-k-${i}`,
    order_id: `ord-${i}`,
    code: i % 3 === 0 ? "k" : `lab-${i}`,
    name: i % 3 === 0 ? "血钾测定" : `检验项目${i}`,
    value: 3.9 + i * 0.05,
    unit: "mmol/L",
    status: "final",
    sample_time: new Date(Date.now() - i * 3600_000).toISOString(),
    patient_id: context.patient_id,
    encounter_id: context.encounter_id,
  }));
  const hisOrders = Array.from({ length: 8 }, (_, i) => ({
    id: `ord-med-${i}`,
    drug_name: i === 0 ? "注射用头孢曲松钠" : `药品${i}`,
    dosage: "2.0g",
    route: "ivgtt",
    frequency: "qd",
    authored_on: new Date(Date.now() - i * 86_400_000).toISOString(),
    change_type: "active",
    is_medication: true,
    patient_id: context.patient_id,
    encounter_id: context.encounter_id,
  }));
  return new ReadOnlyHospitalDataBridge({
    requiredKinds: ["patient", "encounter", "lis", "his"],
    connectors: [
      { id: "perf-patient", kind: "patient", capabilities: ["read"], readPatient: async () => envelope("perf-patient", [{ id: context.patient_id, name: "测试患者", age: 60, gender: "男", patient_id: context.patient_id, encounter_id: context.encounter_id }]) },
      { id: "perf-encounter", kind: "encounter", capabilities: ["read"], readPatient: async () => envelope("perf-encounter", [{ id: context.encounter_id, status: "in-progress", patient_id: context.patient_id, encounter_id: context.encounter_id }]) },
      { id: "perf-lis", kind: "lis", capabilities: ["read"], readPatient: async () => envelope("perf-lis", lisRecords) },
      { id: "perf-his", kind: "his", capabilities: ["read"], readPatient: async () => envelope("perf-his", hisOrders) },
    ],
  });
}

const clinicalNarrative =
  "患者张三峰，身份证号110101199003072378，联系电话13900001111，因胸闷气促3天入院。" +
  "既往高血压病史10年，糖尿病史5年。入院诊断：冠心病、心功能不全（合成示例文本，" +
  "用于PHI Guard性能基准，不含任何真实个人信息）。住院号：PERF-000123，床号：12床。";

function measure(label, iterations, warmup, fn) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  const startTotal = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const totalMs = Number(process.hrtime.bigint() - startTotal) / 1e6;
  samples.sort((a, b) => a - b);
  const mean = totalMs / iterations;
  const p = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  return { label, iterations, mean, p50: p(0.5), p95: p(0.95), opsPerSec: 1000 / totalMs * iterations };
}

async function measureAsync(label, iterations, warmup, fn) {
  for (let i=0;i<warmup;i++) await fn();
  const samples = [];
  for (let i=0;i<iterations;i++) {
    const start=process.hrtime.bigint(); await fn();
    samples.push(Number(process.hrtime.bigint()-start)/1e6);
  }
  samples.sort((a,b)=>a-b);
  const mean=samples.reduce((a,b)=>a+b,0)/iterations;
  return {label,iterations,mean,p50:samples[Math.floor(0.5*iterations)],p95:samples[Math.floor(0.95*iterations)],opsPerSec:1000/mean};
}

async function main() {
  const results = [];

  // 1. Bridge snapshot assembly
  const bridge = buildBridge();
  results.push(await measureAsync('bridge_snapshot',200,20,()=>bridge.readPatientSnapshot(context)));

  // 2. Full pre-round workflow over the bridge
  {
    results.push(await measureAsync('preround_workflow',100,10,async()=>{
      const result=await HospitalAgentAdapter.executePreRoundFromBridge({context,bridge});
      if (!result?.summary) throw new Error('preround workflow returned no summary — fixture drift');
    }));
  }

  // 3. PHI Guard pseudonymization
  results.push({
    ...measure("phiguard_pseudonymize", 500, 50, () => pseudonymizeText(clinicalNarrative, { salt: "perf-baseline-salt-0123456789" })),
  });

  // 4. Audit-chain crypto primitives
  {
    const payload = canonicalJson({ event: "perf", seq: 1, data: clinicalNarrative.slice(0, 120) });
    const prev = "a".repeat(64);
    results.push({
      ...measure("audit_crypto_chain", 2000, 100, () => chainHash(prev, 31, sha256Hex(payload), new Date().toISOString())),
    });
  }

  // 5. Public-reference reviewer
  const pack = loadPack(join(__dirname, "..", "public-reference-validation", "public-reference-pack.json"));
  const reviewCaseInput = JSON.parse(
    JSON.stringify({ rx: { drugs: [{ generic: "华法林" }, { generic: "复方磺胺甲噁唑" }] }, patient: { age: 71, pregnant: false, allergy: "否认药物过敏", crcl_ml_min: 65 } })
  );
  results.push({
    ...measure("public_ref_reviewer", 500, 50, () => reviewCase(reviewCaseInput, pack)),
  });

  // ---- Budgets & report ----
  const budgets = {
    bridge_snapshot: 20,
    preround_workflow: 80,
    phiguard_pseudonymize: 3,
    audit_crypto_chain: 0.5,
    public_ref_reviewer: 2,
  };

  let failures = 0;
  const lines = [];
  lines.push("# 性能基线报告（Performance Baseline）");
  lines.push("");
  lines.push("> **用途**：记录关键路径在当前机器上的延迟基线并作为 CI 回归门禁。预算值为稳定性上限（约典型值的 ~10 倍），不是 SLO；超出基线报告的显著回退即使在预算内也应人工评审。");
  lines.push("");
  lines.push(`- 环境：Node ${process.version} / ${os.platform()} ${os.arch()} / ${os.cpus().length} vCPU`);
  lines.push(`- 预算系数：MEDCIUS_PERF_BUDGET_FACTOR=${budgetFactor}（固定为 1；查房门槛固定 80 ms）`);
  lines.push("");
  lines.push("| 基准 | 迭代 | 平均 (ms/op) | p50 | p95 | ops/s | 预算 (ms) | 结果 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const budget = (budgets[r.label] || Infinity) * budgetFactor;
    const pass = r.mean <= budget;
    if (!pass) failures++;
    lines.push(`| ${r.label} | ${r.iterations} | ${r.mean.toFixed(3)} | ${r.p50.toFixed(3)} | ${r.p95.toFixed(3)} | ${r.opsPerSec.toFixed(0)} | ${budget.toFixed(2)} | ${pass ? "✅" : "❌"} |`);
  }
  lines.push("");
  lines.push(`- 门禁结果：${failures === 0 ? "✅ ALL WITHIN BUDGET" : `❌ ${failures} benchmark(s) over budget`}`);
  lines.push("");

  mkdirSync(dirname(outReport), { recursive: true });
  writeFileSync(outReport, lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

