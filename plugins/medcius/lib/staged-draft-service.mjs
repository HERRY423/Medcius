// Staged Draft & Progressive View Service (受控草稿箱与三层渐进式工作流服务)
// Supports:
// 1. Level 1 (3s Glance Capsule) -> Level 2 (15s Evolution Digest Card) -> Level 3 (Deep-dive Drilldown)
// 2. Human-in-the-loop Staged Draft Sandbox (Read-only at storage level, CA signature in native EMR)

export class StagedDraftService {
  /**
   * Generates a 3-tier progressive disclosure payload directly from PatientEvolutionEngine summary.
   */
  static generateProgressiveViewsFromSummary(evolutionSummary, { patient = {}, timeWindow = "24h" } = {}) {
    const blocks = evolutionSummary?.blocks || {};
    const whatChanged = blocks.what_changed || {};
    const criticals = evolutionSummary?.critical_values || [];
    const gaps = blocks.data_gaps || [];
    const pending = blocks.whats_pending || {};
    const alignments = blocks.structured_multisource_alignment || [];
    const evidenceList = blocks.evidence || [];

    // --- Tier 1: Level 1 走廊胶囊 (3-second Corridor Glance Capsule) ---
    let glanceStatus = "STABLE";
    let glanceColor = "GREEN";
    let glanceHeadline = "过去 24 小时生命体征与主要指标平稳，常规查房随访。";
    let bedPriority = "常规查房顺序";

    if (criticals.length > 0) {
      glanceStatus = "CRITICAL";
      glanceColor = "RED";
      glanceHeadline = `🚨 触发危急值警报：${criticals.map((c) => `${c.name} ${c.value} ${c.unit}`).join("；")}`;
      bedPriority = `[工作流提示] ${patient.bed_number || patient.bed || "床位"} 优先查房巡视 (危急警报)`;
    } else if (alignments.some((a) => a.requires_attention) || (whatChanged.abnormal_labs && whatChanged.abnormal_labs.length > 0)) {
      glanceStatus = "CHANGED";
      glanceColor = "YELLOW";
      const topAlert = alignments.find((a) => a.requires_attention);
      glanceHeadline = topAlert ? `⚠️ ${topAlert.domain_title}: ${topAlert.clinical_synthesis}` : "⚠️ 监测到体征或生化指标动态波动，重点核对。";
      bedPriority = `[工作流提示] 关注病情动态变化`;
    }

    const level1Glance = {
      tier: "LEVEL_1_GLANCE",
      status: glanceStatus,
      color: glanceColor,
      headline: glanceHeadline,
      recommended_workflow_action: bedPriority,
      time_budget: "~3s",
      disclaimer: "工作流优先级提示仅供查房路线参考，不构成医疗医嘱或分诊结论",
    };

    // --- Tier 2: Level 2 演变卡片 (15-second Evolution Digest Card) ---
    const level2Card = {
      tier: "LEVEL_2_DIGEST",
      patient_info: {
        id: patient.id || evolutionSummary?.patient?.id,
        name_masked: patient.name ? `${patient.name[0]}**` : "患者",
        bed: patient.bed_number || patient.bed || "床位",
        egfr: evolutionSummary?.patient?.egfr ?? null,
      },
      time_window: timeWindow,
      time_budget: "~15s",
      blocks: {
        what_changed: {
          vitals: whatChanged.vitals_and_fluids?.vitals || null,
          fluids: whatChanged.vitals_and_fluids?.fluids || null,
          abnormal_labs_count: whatChanged.abnormal_labs?.length || 0,
          imaging_count: whatChanged.imaging_changes?.length || 0,
          med_changes_count: (whatChanged.medication_diff?.added?.length || 0) + (whatChanged.medication_diff?.discontinued?.length || 0) + (whatChanged.medication_diff?.adjusted?.length || 0),
        },
        whats_pending: {
          pending_reports_count: pending.pending_reports?.length || 0,
          pending_orders_count: pending.pending_orders?.length || 0,
          scheduled_consults_count: pending.scheduled_consults?.length || 0,
        },
        clinical_data_gaps: gaps.map((g) => ({
          type: g.gap_type,
          severity: g.severity,
          title: g.title,
          action_needed: g.clinical_action_needed,
        })),
        structured_alignments: alignments.map((a) => ({
          domain: a.domain_title,
          synthesis: a.clinical_synthesis,
          requires_attention: a.requires_attention,
        })),
      },
    };

    // --- Tier 3: Level 3 床旁深挖 (Deep-dive Drilldown Structure) ---
    const level3Drilldown = {
      tier: "LEVEL_3_DRILLDOWN",
      time_budget: "床旁需要时",
      total_evidence_count: evidenceList.length,
      full_evidence_spans: evidenceList.map((e) => ({
        item_id: e.item_id,
        category: e.category,
        title: e.title,
        span: e.span,
        source_type: e.source_type,
        source_id: e.source_id,
        source_title: e.source_title,
        timestamp: e.timestamp,
      })),
      verbatim_spans_available: evidenceList.filter((e) => e.span != null).length,
    };

    return {
      glance: level1Glance,
      digest: level2Card,
      drilldown: level3Drilldown,
    };
  }

  /**
   * Generates a 3-tier progressive disclosure payload for EHR embedding (Legacy / Attribution wrapper).
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
      `> ⚠️ **合规声明**：本草稿由 Medcius Agent 辅助整理生成，仅保存在受限临时沙盒中。请执业医师核实原文无误后，复制至 EMR 原生病历系统加盖 CA 电子签名入库。`,
    ].join("\n");

    return {
      draft_id: `DRAFT-${Date.now()}`,
      patient_id: patient.id,
      encounter_id: encounterId,
      created_at: now.toISOString(),
      rendered_markdown: renderedContent,
      status: "PENDING_PHYSICIAN_CA_SIGNATURE",
      human_verification_required: true,
      write_back_blocked: true,
    };
  }
}
