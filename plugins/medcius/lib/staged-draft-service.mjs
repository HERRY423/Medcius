// Staged Draft & Progressive View Service (受控草稿箱与三层渐进式工作流服务)
// Supports:
// 1. Level 1 (3s Glance Capsule) -> Level 2 (15s Evolution Digest Card) -> Level 3 (Deep-dive Drilldown)
// 2. Human-in-the-loop Staged Draft Sandbox (Read-only at storage level, CA signature in native EMR)

export class StagedDraftService {
  /**
   * Generates a 3-tier progressive disclosure payload for EHR embedding.
   */
  static generateProgressiveViews({
    patient = {},
    timeWindow = "24h",
    evolutionSummary = "",
    attributions = [],
    missingEvaluations = [],
    vitalsSummary = null,
    fluidBalance = null,
    gatingResult = null,
  }) {
    // 1. Level 1: 3-second Glance Capsule
    let glanceStatus = "STABLE";
    let glanceColor = "GREEN";
    let glanceHeadline = "过去 24 小时病情相对平稳，常规查房随访。";

    if (gatingResult && !gatingResult.passed) {
      glanceStatus = "CRITICAL";
      glanceColor = "RED";
      glanceHeadline = gatingResult.forcedAlerts?.[0] || "存在危急值或严重病情恶化，需优先处理！";
    } else if (attributions.length > 0) {
      glanceStatus = "DETERIORATING";
      glanceColor = "YELLOW";
      glanceHeadline = `病情存在动态变化，重点关注：${attributions[0].hypothesis}`;
    }

    const level1Glance = {
      tier: "LEVEL_1_GLANCE",
      status: glanceStatus,
      color: glanceColor,
      headline: glanceHeadline,
      recommended_action: glanceStatus === "CRITICAL" ? "走廊巡视优先床位" : "常规查房顺序",
    };

    // 2. Level 2: 15-second Evolution Digest Card
    const level2Card = {
      tier: "LEVEL_2_DIGEST",
      patient_info: {
        id: patient.id,
        name_masked: patient.name ? `${patient.name[0]}**` : "患者",
        bed: patient.bed || "床位",
      },
      time_window: timeWindow,
      core_changes: evolutionSummary,
      vitals_digest: vitalsSummary || "生命体征平稳",
      fluid_digest: fluidBalance ? `出入量: 入 ${fluidBalance.intake_total}mL / 出 ${fluidBalance.output_total}mL (净 ${fluidBalance.net_balance}mL)` : "未见出入量告警",
      differential_hypotheses: attributions,
      clinical_gaps: missingEvaluations,
    };

    // 3. Level 3: Deep-dive Drilldown Structure
    const level3Drilldown = {
      tier: "LEVEL_3_DRILLDOWN",
      full_evidence_spans: attributions.flatMap((a) => [
        ...(a.supporting_evidence || []).map((e) => ({ ...e, relation: "SUPPORTING", for_hypothesis: a.hypothesis })),
        ...(a.refuting_evidence || []).map((e) => ({ ...e, relation: "REFUTING", for_hypothesis: a.hypothesis })),
      ]),
    };

    return {
      glance: level1Glance,
      digest: level2Card,
      drilldown: level3Drilldown,
    };
  }

  /**
   * Generates a physician staged draft in memory/sandbox for EMR copy or CA signing.
   * Strictly adheres to read-only FHIR boundary — no automated write-back to production DB.
   */
  static createStagedDraft({
    patient = {},
    encounterId = "ENC-DEFAULT",
    author = "Medcius-Assistant",
    progressiveViews = {},
    assessmentAndPlan = "遵前医嘱，今日复查相关生化与心电。",
  }) {
    const now = new Date();
    const digest = progressiveViews.digest || {};

    const renderedContent = [
      `# 【查房前病情演变与交班记录草稿】`,
      `**患者 ID**: ${patient.id || "未知"} | **就诊编号**: ${encounterId}`,
      `**生成时间**: ${now.toLocaleString("zh-CN")}`,
      `---`,
      `### 一、 24小时病情演变要点`,
      digest.core_changes || "病情平稳无特殊演变。",
      ``,
      `### 二、 生命体征与出入量动态`,
      typeof digest.vitals_digest === "string" ? digest.vitals_digest : JSON.stringify(digest.vitals_digest),
      digest.fluid_digest || "出入量平衡。",
      ``,
      `### 三、 拟定查房评估与处置方案 (A/P)`,
      assessmentAndPlan,
      ``,
      `---`,
      `> ⚠️ **合规声明**：本草稿由 Medcius Agent 辅助整理生成，仅保存在临时沙盒中。请执业医师核实原文无误后，复制至 EMR 原生病历系统加盖 CA 电子签名入库。`,
    ].join("\n");

    return {
      draft_id: `DRAFT-${Date.now()}`,
      patient_id: patient.id,
      encounter_id: encounterId,
      created_at: now.toISOString(),
      rendered_markdown: renderedContent,
      status: "PENDING_PHYSICIAN_CA_SIGNATURE",
      human_verification_required: true,
    };
  }
}
