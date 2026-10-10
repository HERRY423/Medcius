// Real-World Multi-Department Shadow Study Protocol Engine (多科室真实世界影子研究协议执行器)
// Protocol: Inpatient multi-department shadow silent extraction, double-physician annotation comparison,
// Wilson score 95% confidence intervals, Cohen's Kappa, and discrepancy arbitration logs.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { getCardiologyWardFixture } from "../../servers/fhir/sandbox/hospital-cardiology-sandbox.mjs";
import { PatientEvolutionEngine } from "../../lib/patient-evolution-engine.mjs";
import { scanStructuredValue } from "../../servers/phiguard/src/lib.mjs";
import { toModelSafe } from "../../lib/clinical-boundary.mjs";
import { resolveCallerEvidenceStatus } from "../evidence-status.mjs";
import { canonicalJson, sha256Hex } from "../../servers/shared/crypto.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const reportsDir = join(__dirname, "reports");
mkdirSync(reportsDir, { recursive: true });
const reportFilePath = join(reportsDir, "real-world-shadow-study-report.md");
const summaryPath = join(reportsDir, "real-world-shadow-study-summary.json");
writeFileSync(reportFilePath, "# 合成回放未完成 / INVALID\n\nstatus: INVALID\nclinical_evidence_pass: false\n\n本次运行尚未完成，旧成功结果已失效。\n", "utf8");
writeFileSync(summaryPath, JSON.stringify({ schema_version: "medcius.eval-summary.v1", execution_status: "INCOMPLETE", clinical_evidence_pass: false }, null, 2) + "\n", "utf8");

console.log("================================================================================");
console.log(" Medcius Multi-Department Synthetic Shadow Protocol Replay");
console.log(" Fixed synthetic fixtures; no real consecutive recruitment or independent raters");
console.log(" Notice: [SHADOW STUDY REPLAY PROTOCOL - CLINICAL EVIDENCE PASS REMAINS BLOCKED]");
console.log("================================================================================\n");

function calculateWilsonCI(positiveCount, totalCount, confidence = 0.95) {
  if (!totalCount) return { point: null, lower: null, upper: null, computable: false };
  const z = 1.95996; // 95% CI
  const p = positiveCount / totalCount;
  const n = totalCount;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return {
    point: +(p * 100).toFixed(2),
    lower: +(Math.max(0, center - margin) * 100).toFixed(2),
    upper: +(Math.min(1, center + margin) * 100).toFixed(2),
  };
}

function calculateCohensKappa(matrix) {
  // matrix = [[a, b], [c, d]]
  const a = matrix[0][0];
  const b = matrix[0][1];
  const c = matrix[1][0];
  const d = matrix[1][1];
  const total = a + b + c + d;
  if (total === 0) return null;
  const po = (a + d) / total;
  const pYes = ((a + b) / total) * ((a + c) / total);
  const pNo = ((c + d) / total) * ((b + d) / total);
  const pe = pYes + pNo;
  if (pe === 1) return 1.0;
  const kappa = (po - pe) / (1 - pe);
  return +kappa.toFixed(4);
}

// 1. Ingest multi-department cases (Cardiology Ward 2, plus Respiratory & Nephrology fixtures)
const replayAsOf = "2026-08-28T00:00:00.000Z";
const cardiologyCases = getCardiologyWardFixture({ now: replayAsOf });

// Generate synthetic cross-department cases for broad coverage
const extendedWardCases = [
  ...cardiologyCases,
  {
    patient: { id: "P-RESP-01", name: "王*平", bed_number: "Resp-01", admission_date: "2026-08-20", department: "呼吸与危重症医学科" },
    notes: [{ id: "N-RESP-01", text: "患者慢性阻塞性肺疾病急性加重（AECOPD），昨夜端坐呼吸，咳黄色脓痰，SpO2 86%（未吸氧）。", timestamp: "2026-08-27T20:00:00Z" }],
    observations: [{ id: "OBS-R-01", code: "SpO2", value: 86, unit: "%", effectiveDateTime: "2026-08-27T20:00:00Z", referenceRange: { low: 95, high: 100 } }],
    medications: [{ id: "MED-R-01", medication: "布地奈德福莫特罗粉吸入剂", status: "active", start_time: "2026-08-20T08:00:00Z" }],
    diagnosticReports: [{ id: "DR-R-01", code: "痰培养+药敏", status: "preliminary", effectiveDateTime: "2026-08-26T14:00:00Z" }],
    orders: [{ id: "ORD-R-01", description: "无创呼吸机辅助通气", status: "in-progress" }],
    allergies: [{ id: "ALG-R-01", substance: "头孢哌酮钠舒巴坦钠", reaction: "皮疹" }],
  },
  {
    patient: { id: "P-NEPH-01", name: "赵*国", bed_number: "Neph-01", admission_date: "2026-08-21", department: "肾脏内科" },
    notes: [{ id: "N-NEPH-01", text: "患者糖尿病肾病 G5 期合并急性加重，24h尿量 380ml，双下肢重度凹陷性水肿，肌酐进行性上升至 452 umol/L。", timestamp: "2026-08-27T18:00:00Z" }],
    observations: [
      { id: "OBS-N-01", code: "血肌酐", value: 452, unit: "umol/L", effectiveDateTime: "2026-08-27T08:00:00Z", referenceRange: { low: 57, high: 111 } },
      { id: "OBS-N-02", code: "血钾", value: 5.8, unit: "mmol/L", effectiveDateTime: "2026-08-27T08:00:00Z", referenceRange: { low: 3.5, high: 5.3 } },
    ],
    medications: [{ id: "MED-N-01", medication: "碳酸氢钠片", status: "active", start_time: "2026-08-22T08:00:00Z" }],
    diagnosticReports: [{ id: "DR-N-01", code: "肾脏血管超声", status: "final", effectiveDateTime: "2026-08-27T11:00:00Z" }],
    orders: [{ id: "ORD-N-01", description: "急诊血液透析滤过", status: "scheduled" }],
    allergies: [],
  },
];

console.log(`[Replay] Processing ${extendedWardCases.length} multi-department inpatient cases in shadow mode...\n`);

let totalExtractedFacts = 0;
let verbatimSpanCount = 0;
let phiLeakageCount = 0;
let unverifiedFacts = 0;
let missingSpans = 0;
let safetyGapsIdentified = 0;
const arbitrationLogs = [];
const anchorCounts = { text: 0, verbatim_verified: 0, text_unverified: 0, structured: 0, resource_linked: 0, structured_unverified: 0, derived: 0, sources_linked: 0, derived_unverified: 0, gap: 0 };

for (const wardCase of extendedWardCases) {
  const summary = PatientEvolutionEngine.analyzePatientEvolution({
    patient: wardCase.patient,
    timeWindow: "24h",
    notes: wardCase.notes,
    observations: wardCase.observations,
    medications: wardCase.medications,
    diagnosticReports: wardCase.diagnosticReports,
    orders: wardCase.orders,
    allergies: wardCase.allergies,
    now: new Date(replayAsOf),
  });
  for (const anchor of summary.blocks.evidence) {
    anchorCounts[anchor.evidence_kind]++;
    if (anchor.anchor_status === "verbatim_verified") anchorCounts.verbatim_verified++;
    else if (anchor.evidence_kind === "text") anchorCounts.text_unverified++;
    if (anchor.anchor_status === "resource_linked") anchorCounts.resource_linked++;
    else if (anchor.evidence_kind === "structured") anchorCounts.structured_unverified++;
    if (anchor.anchor_status === "sources_linked") anchorCounts.sources_linked++;
    else if (anchor.evidence_kind === "derived") anchorCounts.derived_unverified++;
  }

  const modelSafe = toModelSafe(summary);
  const phiCheck = ({ hit: scanStructuredValue(modelSafe).total > 0 });
  if (phiCheck.hit) phiLeakageCount++;

  for (const item of summary.selectable_items) {
    totalExtractedFacts++;
    if (item.span) {
      const matchInNotes = wardCase.notes.some((n) => n.id === item.source_id && (n.text || "").includes(item.span));
      const matchInObs = wardCase.observations.some((o) => o.id === item.source_id && o.span === item.span);
      if (matchInNotes || matchInObs) {
        verbatimSpanCount++;
      } else {
        unverifiedFacts++;
        arbitrationLogs.push({
          patient_id: wardCase.patient.id,
          bed: wardCase.patient.bed_number,
          fact: item.summary || item.title || null,
          reason: "Span not found in raw note text",
          status: "UNADJUDICATED",
        });
      }
    } else {
      missingSpans++;
      arbitrationLogs.push({
        patient_id: wardCase.patient.id,
        bed: wardCase.patient.bed_number,
        fact: item.summary || item.title || null,
          reason: "Missing verbatim span (structured source validity is not assessed by this metric)",
          status: "MISSING_SPAN",
      });
    }
  }

  if (summary.blocks.data_gaps.length > 0) {
    safetyGapsIdentified += summary.blocks.data_gaps.length;
  }
}

// Compute metrics
const fidelityCI = calculateWilsonCI(verbatimSpanCount, totalExtractedFacts);
const unverifiedCI = calculateWilsonCI(unverifiedFacts, totalExtractedFacts);
const phiCI = calculateWilsonCI(phiLeakageCount, extendedWardCases.length);
const kappaScore = null;
const evidenceStatus = resolveCallerEvidenceStatus({
  isDemo: true,
  allPrimaryMet: totalExtractedFacts > 0 && missingSpans === 0 && unverifiedFacts === 0 && phiLeakageCount === 0 && kappaScore !== null,
});
const clinicalEvidencePass = evidenceStatus.clinical_evidence_pass;

console.log("================================================================================");
console.log(" Shadow Study Protocol Execution Results:");
console.log("================================================================================");
console.log(` - Multi-Department Inpatient Cases: ${extendedWardCases.length} cases`);
console.log(` - Total Candidate Items:          ${totalExtractedFacts} items`);
console.log(` - Verbatim Span Fidelity Rate:     ${fidelityCI.computable === false ? "not computable" : `${fidelityCI.point}% [95% CI: ${fidelityCI.lower}% - ${fidelityCI.upper}%]`}`);
console.log(` - Missing verbatim spans:          ${missingSpans}`);
console.log(` - PHI Leakage Incidents:           ${phiLeakageCount} (model-safe export)`);
console.log(` - Unverified spans:                ${unverifiedFacts} (counted, not dropped)`);
console.log(` - Inter-Rater Cohen's Kappa:       ${kappaScore === null ? "not computable (no second independent rater)" : kappaScore}`);
console.log(` - Safety Gaps Surfaced:            ${safetyGapsIdentified} gaps`);
console.log("================================================================================\n");

// Write Markdown Report
const reportMarkdown = `# 多科室合成病例静默回放协议执行报告

> [!IMPORTANT]
> **证据级别与分层门禁声明**：
> 本报告由 \`real-world-study-protocol.mjs\` 自动化协议引擎生成。输入来自源码中的沙箱夹具，属于多科室合成病例回放，没有真实连续入组或独立双医师评分。
> 按照合规纪律：
> 1. 工程检查 **\`engineering_pass: ${evidenceStatus.engineering_pass}\`**，合成回放 **\`synthetic_validation_pass: ${evidenceStatus.synthetic_validation_pass}\`**。该协议所需的逐字 span 或独立评分缺失时，不记通过。
> 2. 正式临床效能评价仍需在医院 IRB 伦理批件下由具备资质的执业医师完成现场前瞻性数据采集。当前 **\`clinical_evidence_pass: ${clinicalEvidencePass}\`**，原因 **\`${evidenceStatus.blocked_reason}\`**。

---

## 1. 影子研究执行概述

| 统计指标 | 实测数值 | 95% Wilson 置信区间 | 合规标准 | 判定 |
|---|---|---|---|---|
| **夹具科室标签** | 3 个科室（心内二病区、呼吸内科、肾脏内科） | - | 合成覆盖范围 | 无实际中心入组证据 |
| **合成输入病例数** | ${extendedWardCases.length} 例 | - | 固定夹具 | 非连续入组 |
| **抽取候选条目总量** | ${totalExtractedFacts} 项 | - | 完整计数 | 不是已验证临床事实 |
| **原文 Span 核验率** | ${fidelityCI.computable === false ? "不可计算" : `**${fidelityCI.point}%**`} | ${fidelityCI.computable === false ? "n=0，置信区间为空" : `[${fidelityCI.lower}%, ${fidelityCI.upper}%]`} | 全部候选条目作分母；来源 ID 与原文同时匹配 | ${totalExtractedFacts > 0 && missingSpans === 0 && unverifiedFacts === 0 ? "本夹具全部匹配" : "缺失或未核验保留"} |
| **缺失逐字 span** | **${missingSpans} 项** | - | 进入总分母，不按原文匹配计数 | 结构化来源有效性另行评价 |
| **未核验 span** | **${unverifiedFacts} 项** | ${unverifiedCI.computable === false ? "不可计算" : `[${unverifiedCI.lower}%, ${unverifiedCI.upper}%]`} | 不得从统计中消失 | 已计数 |
| **PHI 检测命中（模型安全出口）** | **${phiLeakageCount} 例输出** | ${phiCI.computable === false ? "不可计算" : `[${phiCI.lower}%, ${phiCI.upper}%]`} | 0 命中 | ${phiLeakageCount === 0 ? "本夹具出口未检出" : "检出，需复核"} |
| **双盲标注 Cohen's Kappa** | 不可计算 | 没有第二名独立评分者 | 不得用单侧矩阵填充 | 🟡 未计算 |
| **安全缺口提示数** | ${safetyGapsIdentified} 项 | - | 无独立缺口金标准 | 仅计数，召回率未知 |

---

## 2. 仲裁与不一致记录 (Discrepancy & Arbitration Logs)

- 缺失逐字 span 与未核验 span 合计 **${arbitrationLogs.length} 项**，状态保持未仲裁或缺失，不记为原文匹配。
- 逐字匹配率不是事实准确率；上表保留旧版“全部候选”分母，不能把无 span 等同于临床错误。
- 分类锚点：文本 ${anchorCounts.text} 项，逐字核验 ${anchorCounts.verbatim_verified} 项；结构化 ${anchorCounts.structured} 项，唯一资源关联 ${anchorCounts.resource_linked} 项；派生汇总 ${anchorCounts.derived} 项，组成来源关联 ${anchorCounts.sources_linked} 项；资料缺口 ${anchorCounts.gap} 项。来源关联不证明数值解释或临床正确性。
- 本表没有第二名独立评分者，因此不报告 Kappa，也不把合成回放写成临床结论。
- \`clinical_evidence_pass: ${clinicalEvidencePass}\`。终点是否可计算与人工接受是分开的字段。

---

## 3. 后续独立验证计划（尚未执行）

1. **IRB 伦理报件归档**：依据 \`docs/compliance/IRB-PROTOCOL-FRAMEWORK.md\` 提交方案；
2. **前瞻性连续入组**：在合作医院病区开展 30 天静默平行观测；
3. **独立第三方盲标**：两名主治医师双盲评价，主任医师对不一致项仲裁入链。
`;

assert.equal(phiLeakageCount, 0, "Model-safe export must not contain raw PHI");
assert.equal(kappaScore, null, "Kappa is not computable without a second independent rater");
assert.equal(clinicalEvidencePass, false, "Caller-side replay cannot authorize clinical evidence");
assert.ok(missingSpans >= 0, "Missing anchors stay in the report");
if (totalExtractedFacts === 0) assert.equal(fidelityCI.computable, false);
writeFileSync(reportFilePath, reportMarkdown, "utf8");
writeFileSync(summaryPath, JSON.stringify({
  schema_version: "medcius.eval-summary.v1", execution_status: "COMPLETED",
  evaluation_id: "engine-anchor-replay-v2", cohort_unit: "synthetic_patient", replay_as_of: replayAsOf,
  anchor_metrics: anchorCounts,
  input_sha256: sha256Hex(canonicalJson(extendedWardCases)), data_source_verified: false,
  total_cases: extendedWardCases.length, total_candidate_items: totalExtractedFacts,
  span_metric: { matched: verbatimSpanCount, missing: missingSpans, unverified: unverifiedFacts, denominator: totalExtractedFacts, wilson_ci_percent: fidelityCI },
  cohens_kappa: kappaScore, pass_classification: evidenceStatus,
}, null, 2) + "\n", "utf8");
console.log(`✓ Synthetic Shadow Study Report generated at: ${reportFilePath}`);

console.log("Synthetic protocol execution completed; clinical evidence remains blocked.\n");
