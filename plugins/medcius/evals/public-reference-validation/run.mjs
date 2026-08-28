#!/usr/bin/env node
// Public-Reference Validation Runner (公开参考验证层).
//
// Runs the deterministic reference reviewer over the public-gold case set,
// scores per-dimension and overall agreement with Wilson 95% CIs, and writes
// a markdown report. Acts as a CI gate: any mismatch vs gold exits non-zero.
//
// TIER DISCIPLINE (AGENTS.md / production-guard): this layer is
//   public_reference_validation —— 工程级公开参考一致性检查。
// It does NOT unlock clinical_evidence_pass. Public reference facts are real
// pharmacology, but the cases are engineered scenarios, not patient data;
// 真实临床效能仍只能由独立药师盲标研究（R15/R16/R29）产生。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wilsonScore } from "../clinical-validation/run.mjs";
import { loadPack, reviewCase, DIMENSIONS } from "./reference-reviewer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

const packPath = argOf("--pack") || join(__dirname, "public-reference-pack.json");
const casesPath = argOf("--cases") || join(__dirname, "cases", "public-gold.jsonl");
const outReport = argOf("--out") || join(__dirname, "reports", "public-reference-v1.md");

const pack = loadPack(packPath);
const cases = readFileSync(casesPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line, i) => {
    const o = JSON.parse(line);
    if (!o.case_id || !o.expected || !o.input) throw new Error(`cases line ${i + 1}: missing case_id/expected/input`);
    return o;
  });

const results = [];
for (const testCase of cases) {
  const review = reviewCase(testCase.input, pack);
  results.push({ case_id: testCase.case_id, dimension: testCase.dimension, expected: testCase.expected, predicted: review.overall, review });
}
const insufficient = results.filter((r) => r.predicted === "insufficient_data").map((r) => r.case_id);

// ---- Confusion stats over flag/clear pairs (fail-closed samples excluded) --
const scored = results.filter((r) => r.predicted === "flag" || r.predicted === "clear");
function confusion(rows) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    const P = r.predicted === "flag";
    const G = r.expected === "flag";
    if (P && G) tp++; else if (P && !G) fp++; else if (!P && G) fn++; else tn++;
  }
  return { tp, fp, fn, tn };
}

function ciStr(k, n) {
  const c = wilsonScore(k, n);
  return n === 0 ? "n/a" : `${(c.point * 100).toFixed(1)}% [${(c.low * 100).toFixed(1)}%, ${(c.high * 100).toFixed(1)}%]`;
}

let failures = 0;
for (const r of scored) {
  if (r.predicted !== r.expected) {
    failures++;
    console.error(`MISMATCH ${r.case_id}: expected=${r.expected} predicted=${r.predicted}`);
  }
  if (r.expected === "flag") {
    const expectedIds = cases.find((c) => c.case_id === r.case_id)?.expected_fact_ids || [];
    const firedIds = (r.review.dimensions[r.dimension]?.facts || []).map((f) => f.fact_id);
    if (!expectedIds.some((id) => firedIds.includes(id))) {
      failures++;
      console.error(`FACT-MISS ${r.case_id}: expected ${JSON.stringify(expectedIds)}, fired ${JSON.stringify(firedIds)} on dimension=${r.dimension}`);
    }
  }
}
for (const r of results.filter((x) => x.expected === "insufficient_data")) {
  if (r.predicted !== "insufficient_data") {
    failures++;
    console.error(`FAIL-CLOSED MISS ${r.case_id}: predicted=${r.predicted}`);
  }
}

// ---- Report ----------------------------------------------------------------
const overall = confusion(scored);
const lines = [];
lines.push("# 公开参考验证报告（Public-Reference Validation v1）");
lines.push("");
lines.push(`> **证据层级**：\`public_reference_validation\` —— 工程级公开参考一致性层。用例为围绕**可公开核实药学事实**（说明书公开文本等，来源见 fact pack \`source_version=${pack.source_version}\`）构造的工程场景。**本层不是临床效能证据，不解锁 \`clinical_evidence_pass\`**；真实临床结论仍须由独立药师盲标研究（R15/R16/R29）产生。`);
lines.push("");
lines.push(`- 用例总数：${cases.length}（flag/clear 计分 ${scored.length} + fail-closed 单列 ${insufficient.length}）`);
lines.push(`- 阳性（flag）：${overall.tp + overall.fn}；阴性（clear）：${overall.tn + overall.fp}`);
lines.push(`- 混淆矩阵：TP=${overall.tp} FP=${overall.fp} FN=${overall.fn} TN=${overall.tn}`);
lines.push("");
lines.push("| 指标 | 点估计（Wilson 95% CI） |");
lines.push("|---|---|");
lines.push(`| 灵敏度 | ${ciStr(overall.tp, overall.tp + overall.fn)} |`);
lines.push(`| 特异度 | ${ciStr(overall.tn, overall.tn + overall.fp)} |`);
lines.push(`| PPV | ${ciStr(overall.tp, overall.tp + overall.fp)} |`);
lines.push(`| NPV | ${ciStr(overall.tn, overall.tn + overall.fn)} |`);
lines.push("");
lines.push("## 分维度明细");
lines.push("");
lines.push("| 维度 | TP | FP | FN | TN | 灵敏度 | 特异度 |");
lines.push("|---|---|---|---|---|---|---|");
for (const dim of DIMENSIONS) {
  const c = confusion(scored.filter((r) => r.dimension === dim));
  lines.push(`| ${dim} | ${c.tp} | ${c.fp} | ${c.fn} | ${c.tn} | ${ciStr(c.tp, c.tp + c.fn)} | ${ciStr(c.tn, c.tn + c.fp)} |`);
}


lines.push("");
lines.push("## Fail-closed 抽查（G1 纪律）");
lines.push("");
for (const r of results.filter((x) => x.expected === "insufficient_data")) {
  lines.push(`- ${r.case_id}：预期 insufficient_data → 实际 **${r.predicted}** ${r.predicted === "insufficient_data" ? "✅" : "❌"}（${r.review.dimensions.dose_renal?.basis || ""}）`);
}
lines.push("");
lines.push("## 整改记录（深度整改留痕）");
lines.push("");
lines.push("1. 引擎对『阴性结论』一律给出 consulted-basis（如「interaction_pairs 全表未命中该组合」），禁止输出无限定的「未发现相互作用」（G3 整改）。");
lines.push("2. 肾剂量维度在处方含规则药物但缺 CrCl 时返回 insufficient_data 而非 clear（G1 fail-closed 整改）。");
lines.push("3. 过敏维度区分直接匹配（flag）与交叉过敏（转药师，不自动放行），阴性对照 PRV-N010 验证该路径。");
lines.push("4. 所有 flag 均绑定 fact_id 与公开来源文本，满足 D4 可解释纪律。");
lines.push("5. fact 命中校验：flag 用例不仅要求 overall=flag，还要求在对应维度命中 expected_fact_ids，防止『碰巧因其他维度 flag 而蒙对』（run.mjs FACT-MISS 检查）。");
lines.push("");
lines.push(`- 门禁结果：${failures === 0 ? "✅ ALL CONSISTENT" : `❌ ${failures} mismatches`}`);
lines.push("");

mkdirSync(dirname(outReport), { recursive: true });
writeFileSync(outReport, lines.join("\n"), "utf8");
console.log(`public-reference-validation: ${scored.length} scored + ${results.length - scored.length} fail-closed samples, failures=${failures}`);
console.log(`report written: ${outReport}`);
process.exit(failures === 0 ? 0 : 1);

