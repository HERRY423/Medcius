#!/usr/bin/env node
// Inpatient Pre-Round Evolution Summary — Independent Physician Annotation Report Generator

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluatePhysicianAnnotation } from "./physician-annotation-engine.mjs";
import { canonicalJson, sha256Hex } from "../../servers/shared/crypto.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..", "..");

export function buildPhysicianAnnotationReport(evalRes) {
  const lines = [];
  lines.push(`# Medcius 查房前患者变化摘要 — 标注评测统计报告`);
  lines.push("");

  {
    lines.push("> [!CAUTION]");
    lines.push("> **【NOT CLINICAL EVIDENCE】调用者参数不能核验数据来源、独立评分身份或授予临床通过。**");
    lines.push("> **默认数据为心内科沙箱合成条目，标签模拟不等于实际独立医生双盲研究；严禁作为临床有效性或准入依据。**");
    lines.push("> **真实临床效能通行证必须基于三甲医院伦理委员会 (IRB) 批件、执业医师实名双盲标注及数字签名审计链产生。**");
    lines.push("");
  }

  lines.push(`- **评测时间**: ${new Date().toISOString()}`);
  lines.push(`- **工作流模块**: 查房前患者变化摘要 (Inpatient Pre-Round Evolution Summary)`);
  lines.push(`- **输入评测条目**: ${evalRes.total_cases} 项（条目数不代表患者数或连续入组人数）`);
  lines.push(`- **完整性**: 已解析金标准 ${evalRes.overall.scored_n}，未仲裁/缺失评分 ${evalRes.overall.unadjudicated}，弃答 ${evalRes.overall.abstentions}，缺失锚点 ${evalRes.overall.missing_evidence_anchors}，缺失记录键 ${evalRes.key_integrity.missing_keys}。`);
  lines.push(`- **分母**: 金标准阳性 ${evalRes.overall.gold_positive_n}、阴性 ${evalRes.overall.gold_negative_n}；预测阳性 ${evalRes.overall.predicted_positive_n}、阴性 ${evalRes.overall.predicted_negative_n}。阳性类别错分 ${evalRes.overall.misclassifications} 项分别计入 FP 与 FN，但只计一个已评分条目；弃答不计正确。`);
  lines.push(`- **双医生标注一致性 (Cohen's Kappa)**: $\\kappa = ${evalRes.cohens_kappa}$ (${evalRes.endpoints.inter_annotator_kappa_met ? "达成预注册指标 ≥0.80" : "🔴 未达标"})`);
  lines.push(`- **主要终点总体达成**: ${evalRes.allPrimaryMet ? "🟢 全部达标 (Passed)" : "🔴 未达标 (Deficient)"}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 0. 三级合规通行证分类认定 (Three-Tier Pass Classification)");
  lines.push("");
  lines.push(`| 通行证评级 | 评级状态 | 评定说明 |`);
  lines.push(`|---|---|---|`);
  lines.push(`| **1. 工程验证评级 (engineering_pass)** | ${evalRes.passClassification.engineering_pass ? "🟢 通过 (PASS)" : "🔴 未通过"} | 算法公式、分层统计引擎与置信区间运算无误 |`);
  lines.push(`| **2. 合成管线评级 (synthetic_validation_pass)** | ${evalRes.passClassification.synthetic_validation_pass ? "🟢 通过 (PASS)" : "🔴 未通过"} | 心内科连续沙箱模拟数据满足预设测试终点 |`);
  lines.push(`| **3. 临床证据评级 (clinical_evidence_pass)** | ${evalRes.passClassification.clinical_evidence_pass ? "🟢 准入通过 (CLINICAL PASS)" : "🔒 严格阻断 (BLOCKED: 沙箱演示严禁作为正式临床证据)"} | 需三甲医院伦理审批、执业医生数字签名与真实连续病例数据 |`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 1. 预注册主要终点核验表 (Pre-registered Endpoints)");
  lines.push("");
  lines.push("| 临床效能终点 | 预注册合格门槛 | 实际观测值 (95% CI) | 达标判定 |");
  lines.push("|---|---|---|---|");
  lines.push(`| **总体灵敏度 (Sensitivity)** | $\\ge 95.0\\%$ (CI下限 $\\ge 90.0\\%$) | ${evalRes.overall.sensitivity.str} | ${evalRes.endpoints.sensitivity_target_met && evalRes.endpoints.sensitivity_ci_lower_met ? "✓ 达标" : "✗ 不达标"} |`);
  lines.push(`| **总体特异度 (Specificity)** | $\\ge 90.0\\%$ | ${evalRes.overall.specificity.str} | ${evalRes.endpoints.specificity_target_met ? "✓ 达标" : "✗ 不达标"} |`);
  lines.push(`| **关键演变漏报数 (FN)** | $= 0$ 例 (零漏报) | ${evalRes.overall.critical_escapes} 例 | ${evalRes.endpoints.zero_critical_escape_met ? "✓ 达标 (0漏报)" : "✗ 存在漏报"} |`);
  lines.push(`| **虚构证据 Span 数 (Fake Spans)** | $= 0$ 条 (零虚构) | ${evalRes.overall.fake_spans} 条 | ${evalRes.endpoints.zero_fabricated_spans_met ? "✓ 达标 (0虚构)" : "✗ 存在虚构"} |`);
  lines.push(`| **双医生标注一致性 (Kappa)** | $\\ge 0.80$ | $\\kappa = ${evalRes.cohens_kappa}$ | ${evalRes.endpoints.inter_annotator_kappa_met ? "✓ 达标" : "✗ 偏低"} |`);
  lines.push(`| **阳性预测值 (PPV)** | $\\ge 90.0\\%$ | ${evalRes.overall.ppv.str} | ${(evalRes.overall.ppv.point ?? -1) >= 0.90 ? "✓ 达标" : "✗ 未达标或不可计算"} |`);
  lines.push(`| **阴性预测值 (NPV)** | $\\ge 95.0\\%$ | ${evalRes.overall.npv.str} | ${(evalRes.overall.npv.point ?? -1) >= 0.95 ? "✓ 达标" : "✗ 未达标或不可计算"} |`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 2. 临床维度分层效能表 (Dimension Stratification)");
  lines.push("");
  lines.push("| 临床关注维度 | 样本条目数 (N) | AI 准确提取数 | 提取准确率 | 临床质控关注重点 |");
  lines.push("|---|---|---|---|---|");
  for (const [dim, stats] of Object.entries(evalRes.dimensionStats)) {
    const dimDesc = {
      symptoms_evolution: "1. 症状与病情演变",
      lab_trends: "2. 异常检验与动态趋势",
      critical_value: "3. 检验危急值识别",
      medication_diff: "4. 用药医嘱变更与抗菌药",
      pending_items: "5. 待办检查与会诊排期",
      data_gaps: "6. 临床安全资料缺口",
    }[dim] || dim;
    lines.push(`| ${dimDesc} | ${stats.total} | ${stats.matched} | ${stats.accuracy} | 原文保真与动态区间遵从 |`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 3. 连续病例评测明细 (Case Details)");
  lines.push("");
  lines.push("| 案例编号 | 床位 | 维度 | 医生A | 医生B | 仲裁Gold | AI提取 | 判定 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of evalRes.resolved) {
    lines.push(`| ${r.case_id} | ${r.bed_number} | ${r.dimension} | ${r.physician_a} | ${r.physician_b} | ${r.gold} | ${r.ai_extracted} | ${r.ai_matched ? "✓ 匹配" : "✗ 偏差"} |`);
  }
  lines.push("");

  return lines.join("\n");
}

// CLI Execution
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const outDir = join(repoRoot, "out");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "physician-annotation-report.md");
const summaryPath = join(outDir, "physician-annotation-summary.json");
writeFileSync(summaryPath, JSON.stringify({ schema_version: "medcius.eval-summary.v1", execution_status: "INCOMPLETE", clinical_evidence_pass: false }, null, 2) + "\n", "utf8");
try {
const casesPath = join(__dirname, "ward-annotation-cases.json");
const rawCases = JSON.parse(readFileSync(casesPath, "utf8"));
const evalRes = evaluatePhysicianAnnotation(rawCases, { isDemo: true });
const reportMd = buildPhysicianAnnotationReport(evalRes);

writeFileSync(outPath, reportMd, "utf8");
writeFileSync(summaryPath, JSON.stringify({
  schema_version: "medcius.eval-summary.v1", execution_status: "COMPLETED",
  input_sha256: sha256Hex(canonicalJson(rawCases)), data_source_verified: false,
  total_cases: evalRes.total_cases, overall: evalRes.overall, endpoints: evalRes.endpoints,
  pass_classification: evalRes.passClassification,
}, null, 2) + "\n", "utf8");

console.log(`✓ Physician annotation benchmark report generated: ${outPath}`);
console.log(`Cases: ${evalRes.total_cases} | Kappa: ${evalRes.cohens_kappa} | All Met: ${evalRes.allPrimaryMet}`);
} catch (error) {
  writeFileSync(outPath, "# 评测失败 / INVALID\n\nclinical_evidence_pass: false\n\n本次输入未通过检查；此前报告已失效。\n", "utf8");
  writeFileSync(summaryPath, JSON.stringify({ schema_version: "medcius.eval-summary.v1", execution_status: "INVALID", clinical_evidence_pass: false }, null, 2) + "\n", "utf8");
  throw error;
}
}
