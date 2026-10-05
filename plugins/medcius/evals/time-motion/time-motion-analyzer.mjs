// Clinician Time-Motion & Cognitive Workload (NASA-TLX) Statistical Analyzer
// Protocol: Multi-observer paired time-motion data collection, hands-on time, navigation click steps,
// NASA-TLX cognitive load index (0-100), and clinical accuracy non-inferiority statistical margins.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { classifyEvidenceReport } from "../../lib/clinical-landing-policy.mjs";
import { evaluateStopwatchProtocol } from "./stopwatch-protocol.mjs";
import { canonicalJson, sha256Hex } from "../../servers/shared/crypto.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class TimeMotionAnalyzer {
  /**
   * Evaluates a cohort of clinician observational sessions
   * @param {Array<Object>} sessions - array of paired session data
   */
  static analyzeCohort(sessions, { dataClass = "synthetic", irbProtocolId = null } = {}) {
    if (!sessions || sessions.length === 0) {
      throw new Error("No session data provided for time-motion analysis");
    }

    const n = sessions.length;
    const missing = {};
    const measure = (side, field, { integer = false, max = Infinity } = {}) => {
      const values = sessions.map((s) => s?.[side]?.[field]);
      const key = `${side}.${field}`;
      missing[key] = values.filter((value) => value == null).length;
      if (values.some((value) => value != null && (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))))) {
        throw new Error(`TIME_MOTION_MEASUREMENT_INVALID: ${key}`);
      }
      return missing[key] ? null : values.reduce((sum, value) => sum + value, 0);
    };
    const average = (sum) => sum == null ? null : +(sum / n).toFixed(1);
    const reduction = (control, intervention) => control == null || intervention == null || control === 0
      ? null : +((control - intervention) / control * 100).toFixed(1);
    const avgManualSec = average(measure("manual", "duration_seconds"));
    const avgMedciusSec = average(measure("medcius", "duration_seconds"));
    const timeSavedSec = avgManualSec == null || avgMedciusSec == null ? null : +(avgManualSec - avgMedciusSec).toFixed(1);
    const timeSavedPct = reduction(avgManualSec, avgMedciusSec);
    const avgManualClicks = average(measure("manual", "navigation_clicks", { integer: true }));
    const avgMedciusClicks = average(measure("medcius", "navigation_clicks", { integer: true }));
    const clicksSavedPct = reduction(avgManualClicks, avgMedciusClicks);
    const avgManualTlx = average(measure("manual", "nasa_tlx_score", { max: 100 }));
    const avgMedciusTlx = average(measure("medcius", "nasa_tlx_score", { max: 100 }));
    const tlxReductionPct = reduction(avgManualTlx, avgMedciusTlx);
    const manualOmissions = measure("manual", "critical_omissions", { integer: true });
    const medciusOmissions = measure("medcius", "critical_omissions", { integer: true });
    const complete = Object.values(missing).every((count) => count === 0);
    const omissionComparison = manualOmissions == null || medciusOmissions == null ? null : medciusOmissions <= manualOmissions;

    const evidence = classifyEvidenceReport({
      dataClass,
      irbProtocolId,
      observerIds: sessions.map((s) => s.observer_id || s.physician).filter(Boolean),
      stopwatchRecords: sessions,
    });

    return {
      sample_size: n,
      missing_measurements: missing,
      evidence: {
        ...evidence,
        engineering_pass: complete,
        synthetic_validation_pass: dataClass === "synthetic" && complete,
        clinical_evidence_pass: false,
        data_source_verified: false,
        independent_review_pending: true,
      },
      time_metrics: {
        avg_manual_seconds: avgManualSec,
        avg_medcius_seconds: avgMedciusSec,
        time_saved_seconds: timeSavedSec,
        time_saved_percentage: timeSavedPct,
      },
      interaction_metrics: {
        avg_manual_clicks: avgManualClicks,
        avg_medcius_clicks: avgMedciusClicks,
        clicks_saved_percentage: clicksSavedPct,
      },
      cognitive_load_metrics: {
        avg_manual_nasa_tlx: avgManualTlx,
        avg_medcius_nasa_tlx: avgMedciusTlx,
        workload_reduction_percentage: tlxReductionPct,
      },
      safety_non_inferiority: {
        manual_omissions: manualOmissions,
        medcius_omissions: medciusOmissions,
        is_non_inferior: null,
        descriptive_omission_comparison_pass: omissionComparison,
        status: "NOT_EVALUATED",
      },
    };
  }
}

// Multi-physician multi-specialty observation dataset (Cardiology & Respiratory Physicians)
const sampleObservationSessions = [
  {
    physician: "Dr. L (Attending, Cardiology)",
    ward: "Cardiology Ward 2",
    manual: { duration_seconds: 520, navigation_clicks: 16, nasa_tlx_score: 74, critical_omissions: 1 },
    medcius: { duration_seconds: 110, navigation_clicks: 0, nasa_tlx_score: 18, critical_omissions: 0 },
  },
  {
    physician: "Dr. Z (Resident, Cardiology)",
    ward: "Cardiology Ward 2",
    manual: { duration_seconds: 560, navigation_clicks: 22, nasa_tlx_score: 82, critical_omissions: 2 },
    medcius: { duration_seconds: 125, navigation_clicks: 0, nasa_tlx_score: 22, critical_omissions: 0 },
  },
  {
    physician: "Dr. C (Fellow, Respiratory)",
    ward: "Respiratory Care Ward",
    manual: { duration_seconds: 490, navigation_clicks: 14, nasa_tlx_score: 68, critical_omissions: 0 },
    medcius: { duration_seconds: 95, navigation_clicks: 0, nasa_tlx_score: 16, critical_omissions: 0 },
  },
  {
    physician: "Dr. W (Resident, Nephrology)",
    ward: "Nephrology Inpatient Ward",
    manual: { duration_seconds: 540, navigation_clicks: 18, nasa_tlx_score: 78, critical_omissions: 1 },
    medcius: { duration_seconds: 105, navigation_clicks: 0, nasa_tlx_score: 20, critical_omissions: 0 },
  },
];

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
const reportsDir = join(__dirname, "reports");
mkdirSync(reportsDir, { recursive: true });
const reportFilePath = join(reportsDir, "time-motion-statistical-analysis.md");
const summaryPath = join(reportsDir, "time-motion-statistical-summary.json");
writeFileSync(reportFilePath, "# 分析未完成 / INVALID\n\nstatus: INVALID\nclinical_evidence_pass: false\n\n本次运行尚未完成，旧成功结果已失效。\n", "utf8");
writeFileSync(summaryPath, JSON.stringify({ schema_version: "medcius.eval-summary.v1", execution_status: "INCOMPLETE", clinical_evidence_pass: false }, null, 2) + "\n", "utf8");
console.log("================================================================================");
console.log(" Medcius Clinician Time-Motion & Human Factors Statistical Analyzer");
console.log(" Protocol: Paired Observation Sessions (Hands-on Time, Clicks & NASA-TLX)");
console.log(" Notice: SYNTHETIC PROTOCOL — clinical_evidence_pass remains BLOCKED");
console.log("================================================================================\n");

const results = TimeMotionAnalyzer.analyzeCohort(sampleObservationSessions, { dataClass: "synthetic" });

console.log(`[Analyzed ${results.sample_size} Physician Sessions]`);
console.log(`  • 单病案平均查房准备耗时: 手工翻阅 ${results.time_metrics.avg_manual_seconds}s  →  Medcius 辅助 ${results.time_metrics.avg_medcius_seconds}s (节省 ${results.time_metrics.time_saved_percentage}%)`);
console.log(`  • 跨系统页面翻阅点击次数: 手工翻阅 ${results.interaction_metrics.avg_manual_clicks}次  →  Medcius 辅助 ${results.interaction_metrics.avg_medcius_clicks}次 (减少 ${results.interaction_metrics.clicks_saved_percentage}%)`);
console.log(`  • 认知负荷 NASA-TLX 评分: 手工翻阅 ${results.cognitive_load_metrics.avg_manual_nasa_tlx}/100  →  Medcius 辅助 ${results.cognitive_load_metrics.avg_medcius_nasa_tlx}/100 (负荷降低 ${results.cognitive_load_metrics.workload_reduction_percentage}%)`);
console.log(`  • 临床安全性非劣效性: 未评价（合成遗漏计数的比较不构成非劣效性检验）`);

// Write statistical report
const reportMarkdown = `# 临床医生查房前工作流 Time-Motion 与人因认知负荷统计分析报告

> [!IMPORTANT]
> **证据级别与分层纪律声明**：
> 本报告由 \`time-motion-analyzer.mjs\` 自动化分析引擎生成。
> 1. 数据来源：源码中固定的四组人工合成会话参数，没有现场医生观察记录；
> 2. 状态分类：\`engineering_pass: ${results.evidence.engineering_pass}\`，\`synthetic_validation_pass: ${results.evidence.synthetic_validation_pass}\`；仅检查这些输入可用于描述性计算；
> 3. 正式临床监管报告需在完成 IRB 伦理批件后由第三方观察员现场秒表测定，当前 **\`clinical_evidence_pass: 🔒 BLOCKED\`**。
> 4. 下表百分比是合成管线输出，**禁止**作为一线提效宣称；预注册临床终点是秒表均节省 ≥ 90 秒且安全非劣。

---

## 1. 核心效能对比分析

| 观测维度 | 传统手工翻阅模式 (Control) | Medcius 辅助模式 (Intervention) | 改善幅度 | 目标标准 |
|---|---|---|---|---|
| **单患者平均查房准备耗时** | **${results.time_metrics.avg_manual_seconds} 秒** (8.8 分钟) | **${results.time_metrics.avg_medcius_seconds} 秒** (1.8 分钟) | **缩短 ${results.time_metrics.time_saved_percentage}%** | ≥ 60.0% |
| **跨系统界面切换点击次数** | **${results.interaction_metrics.avg_manual_clicks} 次** / 人 | **${results.interaction_metrics.avg_medcius_clicks} 次** / 人 | **减少 ${results.interaction_metrics.clicks_saved_percentage}%** | ≥ 90.0% |
| **NASA-TLX 认知负荷综合得分** | **${results.cognitive_load_metrics.avg_manual_nasa_tlx} / 100** | **${results.cognitive_load_metrics.avg_medcius_nasa_tlx} / 100** | **降低 ${results.cognitive_load_metrics.workload_reduction_percentage}%** | 降低 ≥ 50% |
| **合成关键遗漏计数** | ${results.safety_non_inferiority.manual_omissions} 项 | **${results.safety_non_inferiority.medcius_omissions} 项** | 描述性比较；非劣效性未评价 | 真实安全终点待研究 |

---

## 2. 可支持的结论与后续验证

- 固定合成参数验证了描述性计算路径，不能估计真实节时、认知负荷或安全收益。
- 未开展含误差核对和失败处理时间的配对实测，未实施预先批准的非劣效性统计检验；临床安全性保持未评价。
- 静默研究可评价事实质量；医生可见的人因研究需要单独批准，并包含查看来源、纠错和失败处理时间。
`;

assert.equal(results.evidence.clinical_evidence_pass, false, "synthetic time-motion must not claim clinical evidence");
const stopwatch = evaluateStopwatchProtocol({
  data_class: "synthetic",
  records: sampleObservationSessions.map((session) => ({
    observer_id: session.physician,
    control_seconds: session.manual.duration_seconds,
    intervention_seconds: session.medcius.duration_seconds,
    control_omissions: session.manual.critical_omissions,
    intervention_omissions: session.medcius.critical_omissions,
  })),
});
assert.equal(stopwatch.evidence.clinical_evidence_pass, false, "in-silico 79%-class deltas cannot pass clinical evidence");
writeFileSync(reportFilePath, reportMarkdown, "utf8");
writeFileSync(summaryPath, JSON.stringify({
  schema_version: "medcius.eval-summary.v1", execution_status: "COMPLETED",
  input_sha256: sha256Hex(canonicalJson(sampleObservationSessions)), data_source_verified: false,
  sample_size: results.sample_size, time_metrics: results.time_metrics,
  safety_non_inferiority: results.safety_non_inferiority,
  endpoints_met: stopwatch.endpoints_met, descriptive_endpoints_met: stopwatch.descriptive_endpoints_met,
  pass_classification: results.evidence,
}, null, 2) + "\n", "utf8");
console.log(`\n✓ Time-Motion Statistical Report generated at: ${reportFilePath}`);
console.log("🎉 TIME-MOTION STATISTICAL ANALYZER COMPLETED SUCCESSFULLY (synthetic, clinical evidence blocked)!\n");
}
