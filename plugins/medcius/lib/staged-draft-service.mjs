import { assessCriticalVisibility } from "./critical-visibility.mjs";
// Staged Draft & Progressive View Service (受控草稿箱与三层渐进式工作流服务)
// Supports:
// 1. Level 1 (3s Glance Capsule) -> Level 2 (15s Evolution Digest Card) -> Level 3 (Deep-dive Drilldown)
// 2. Human-in-the-loop Staged Draft Sandbox (Read-only at storage level, CA signature in native EMR)

import { assertEvolutionConsistency, detachedFrozenOutput } from "./output-consistency.mjs";
const copy = (value) => structuredClone(value);
const list = (value) => Array.isArray(value) ? value : [];
const SOURCE_LABELS = { available: "接口已返回记录", available_empty: "接口成功返回空结果", unavailable: "接口不可用", unknown: "接口状态未知" };
const RESULT_LABELS = { final: "最终结果", revised: "修订结果", preliminary: "初步结果", cancelled: "已取消", entered_in_error: "错误录入", unknown: "状态未知" };
const CLOSURE_LABELS = { closed: "已闭环", open: "待核对", requires_reconciliation: "需核对撤销或错误记录", unknown: "闭环状态未知" };
function sourceReference(item) {
  return [item.source_type, item.source_id, item.version_id == null ? null : `版本 ${item.version_id}`].filter(Boolean).join(" / ");
}
function renderItem(item) {
  const text = item.display_text || item.summary || item.clinical_synthesis || item.title || "记录内容待核对";
  const reference = sourceReference(item);
  return `${text}${reference ? ` [来源: ${reference}]` : ""}`;
}
function renderItems(items) { return list(items).map((item) => `- ${renderItem(item)}`).join("\n"); }
function fluidText(fluid) {
  if (!fluid) return "未提供可用出入量记录，不能判断平衡。";
  return `已记录入量 ${fluid.intake_total_ml ?? fluid.intake_total ?? "未知"} mL / 出量 ${fluid.output_total_ml ?? fluid.output_total ?? "未知"} mL；净平衡 ${fluid.net_balance_label ?? fluid.net_balance ?? "未知"}；记录状态 ${fluid.status ?? "未知"}。`;
}
function vitalsText(vitals) {
  if (!vitals) return "未提供可用生命体征记录，不能判断是否平稳。";
  if (typeof vitals === "string") return vitals;
  return `已记录最高体温 ${vitals.t_max ?? "未知"} ℃；血压 ${vitals.bp_max ?? "未知"}；平均心率 ${vitals.hr_avg ?? "未知"} bpm。`;
}

export class StagedDraftService {
  /**
   * Generates a 3-tier progressive disclosure payload directly from PatientEvolutionEngine summary.
   */
  static generateProgressiveViewsFromSummary(evolutionSummary, { patient = {}, timeWindow = null } = {}) {
    if (patient.id && evolutionSummary?.patient?.id && patient.id !== evolutionSummary.patient.id) throw new Error("OUTPUT_CONSISTENCY_FAILED: VIEW_PATIENT_MISMATCH");
    if (timeWindow && evolutionSummary?.time_window && timeWindow !== evolutionSummary.time_window) throw new Error("OUTPUT_CONSISTENCY_FAILED: VIEW_TIME_WINDOW_MISMATCH");
    if (evolutionSummary?.total_items_count != null) assertEvolutionConsistency(evolutionSummary);
    const blocks = evolutionSummary?.blocks || {};
    const whatChanged = blocks.what_changed || {};
    const criticals = evolutionSummary?.critical_values || [];
    const gaps = blocks.data_gaps || [];
    const pending = blocks.whats_pending || {};
    const alignments = blocks.structured_multisource_alignment || [];
    const evidenceList = blocks.evidence || [];
    const sourceAvailability = list(blocks.source_availability);
    const visibility = evolutionSummary?.critical_visibility || assessCriticalVisibility({ sources: sourceAvailability, asOf: evolutionSummary?.generated_at, flaggedCount: criticals.length });
    const recordChanges = blocks.record_changes || { items: [], counts: {} };
    const followup = blocks.high_risk_followup || { items: [], counts: {} };
    const uncertainSources = sourceAvailability.length === 0 || sourceAvailability.some((source) => !["available", "available_empty"].includes(source.status));
    const unresolved = list(followup.items).some((item) => item.closure_status !== "closed");
    const stateReview = list(recordChanges.items).some((item) => ["unknown", "cancellation", "entered_in_error", "revision"].includes(item.change_type) || item.arrival_status === "late_record");

    // --- Tier 1: Level 1 走廊胶囊 (3-second Corridor Glance Capsule) ---
    let glanceStatus = "UNKNOWN";
    let glanceColor = "GRAY";
    let glanceHeadline = "现有记录不足以判断病情是否平稳，请核对来源与资料完整性。";
    let bedPriority = "核对来源记录与未完成事项";

    if (criticals.length > 0) {
      glanceStatus = "CRITICAL";
      glanceColor = "RED";
      glanceHeadline = `🚨 来源危急标记待核对：${criticals.map((c) => `${c.name || c.code || "检验"} ${c.value ?? "未知"} ${c.unit || ""}（${RESULT_LABELS[c.result_status] || "状态未知"}）`).join("；")}`;
      bedPriority = `[工作流提示] ${patient.bed_number || patient.bed || "床位"} 优先查房巡视 (危急警报)`;
    } else if (stateReview || unresolved || alignments.some((a) => a.requires_attention) || (whatChanged.abnormal_labs && whatChanged.abnormal_labs.length > 0)) {
      glanceStatus = "CHANGED";
      glanceColor = "YELLOW";
      const topAlert = alignments.find((a) => a.requires_attention);
      glanceHeadline = stateReview || unresolved ? "⚠️ 存在记录变更、状态未知或未闭环事项，请核对原始记录。" : topAlert ? `⚠️ ${topAlert.domain_title}: ${topAlert.clinical_synthesis}` : "⚠️ 存在需核对的检验记录。";
      bedPriority = `[工作流提示] 关注病情动态变化`;
    }
    if (uncertainSources || gaps.length > 0) glanceHeadline += " 资料或接口状态不完整，不据此判断病情平稳。";

    glanceHeadline += ` ${visibility.message}`;
    const level1Glance = {
      critical_visibility: copy(visibility),
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
      time_window: timeWindow || evolutionSummary?.time_window || "24h",
      time_budget: "~15s",
      blocks: {
        what_changed: {
          ...copy(whatChanged),
          vitals: copy(whatChanged.vitals_and_fluids?.vitals ?? whatChanged.nursing_vitals_summary ?? null),
          fluids: copy(whatChanged.vitals_and_fluids?.fluids ?? whatChanged.fluid_balance_24h ?? null),
          abnormal_labs_count: whatChanged.abnormal_labs?.length || 0,
          imaging_count: whatChanged.imaging_changes?.length || 0,
          med_changes_count: (whatChanged.medication_diff?.added?.length || 0) + (whatChanged.medication_diff?.discontinued?.length || 0) + (whatChanged.medication_diff?.adjusted?.length || 0),
        },
        whats_pending: {
          ...copy(pending),
          pending_reports_count: pending.pending_reports?.length || 0,
          pending_orders_count: pending.pending_orders?.length || 0,
          scheduled_consults_count: pending.scheduled_consults?.length || 0,
        },
        clinical_data_gaps: gaps.map((g) => ({
          ...copy(g),
          type: g.gap_type,
          severity: g.severity,
          title: g.title,
          action_needed: g.clinical_action_needed,
        })),
        structured_alignments: alignments.map((a) => ({
          ...copy(a),
          domain: a.domain_title,
          synthesis: a.clinical_synthesis,
          requires_attention: a.requires_attention,
        })),
        record_changes: copy(recordChanges),
        source_availability: copy(sourceAvailability),
        critical_visibility: copy(visibility),
        high_risk_followup: copy(followup),
      },
    };

    // --- Tier 3: Level 3 床旁深挖 (Deep-dive Drilldown Structure) ---
    const level3Drilldown = {
      tier: "LEVEL_3_DRILLDOWN",
      time_budget: "床旁需要时",
      total_evidence_count: evidenceList.length,
      selectable_items: copy(list(evolutionSummary?.selectable_items)),
      full_evidence_spans: evidenceList.map((e) => ({
        ...copy(e),
        item_id: e.item_id,
        category: e.category,
        title: e.title,
        span: e.span,
        source_type: e.source_type,
        source_id: e.source_id,
        source_title: e.source_title,
        timestamp: e.timestamp,
      })),
      verbatim_spans_available: evidenceList.filter((e) => e.anchor_status === "verbatim_verified").length,
      unverified_evidence_count: evidenceList.filter((e) => ["unverified", "ambiguous"].includes(e.anchor_status)).length,
    };

    return detachedFrozenOutput({
      glance: level1Glance,
      digest: level2Card,
      drilldown: level3Drilldown,
    });
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
    let glanceStatus = "UNKNOWN";
    let glanceColor = "GRAY";
    let glanceHeadline = "现有资料不足以判断病情是否平稳，请核对原始记录。";

    if (gatingResult && !gatingResult.passed) {
      const sourceAlert = list(gatingResult.forcedAlerts)[0];
      glanceStatus = sourceAlert ? "CRITICAL" : "UNKNOWN";
      glanceColor = sourceAlert ? "RED" : "GRAY";
      glanceHeadline = sourceAlert || "检查门禁未通过，原因需核对；不能据此推断病情恶化。";
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
      recommended_action: glanceStatus === "CRITICAL" ? "核对来源警报与原始记录" : "核对来源记录与未完成事项",
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
      vitals_digest: vitalsSummary || "未提供可用生命体征记录，不能判断是否平稳。",
      fluid_digest: fluidText(fluidBalance),
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
    assessmentAndPlan = "",
    selectedItemIds = null,
  }) {
    const now = new Date();
    const digest = progressiveViews.digest || {};
    const blocks = digest.blocks || null;
    const selectableItems = list(progressiveViews.drilldown?.selectable_items);
    const selection = Array.isArray(selectedItemIds) ? new Set(selectedItemIds) : null;
    const chosen = selection ? selectableItems.filter((item) => selection.has(item.id)) : [];
    const changes = blocks?.what_changed || {};
    const currentItems = [
      ...list(changes.clinical_symptoms), ...list(changes.abnormal_labs), ...list(changes.imaging_changes),
      ...list(changes.medication_diff?.added), ...list(changes.medication_diff?.discontinued), ...list(changes.medication_diff?.adjusted),
    ];
    const coreChanges = selection ? renderItems(chosen) || "未选择事实条目。"
      : blocks ? renderItems(currentItems) || "当前摘要未提供可陈述的变化条目，不能据此判断病情平稳。"
        : digest.core_changes || "未提供病情演变记录，不能据此判断病情平稳。";
    const selectedVitals = selection ? chosen.find((item) => item.vitals || item.fluids) : null;
    const vitals = selection ? selectedVitals?.vitals : blocks ? changes.vitals_and_fluids?.vitals ?? changes.nursing_vitals_summary : digest.vitals_digest;
    const fluid = selection ? selectedVitals?.fluids : blocks ? changes.vitals_and_fluids?.fluids ?? changes.fluid_balance_24h : null;
    const states = blocks ? [
      "### 记录状态与来源可用性",
      blocks.critical_visibility?.message || "危急值覆盖未确认；不能排除遗漏。",
      blocks.critical_visibility?.action || "请核对院内原始系统与危急值通知通道。",
      renderItems(blocks.record_changes?.items) || "未提供记录变更状态。",
      list(blocks.source_availability).map((source) => `- ${source.kind || source.connector_id || "来源"}: ${SOURCE_LABELS[source.status] || "接口状态未知"}`).join("\n") || "来源接口状态未提供。",
      ...list(blocks.high_risk_followup?.items).map((item) => `- ${item.label || item.title || item.test_name || item.source_id || item.id || "随访事项"}: ${CLOSURE_LABELS[item.closure_status] || "闭环状态未知"} [来源: ${sourceReference(item) || list(item.evidence).map(sourceReference).filter(Boolean).join("；") || "待核对"}]`),
      renderItems(blocks.clinical_data_gaps),
    ] : [];

    const renderedContent = [
      `# 【查房前病情演变与交班记录草稿】`,
      `**患者 ID**: ${patient.id || "未知"} | **就诊编号**: ${encounterId}`,
      `**生成时间**: ${now.toLocaleString("zh-CN")}`,
      `---`,
      `### 一、 ${digest.time_window || "时间窗口未提供"}病情演变要点`,
      coreChanges,
      "",
      ...states,
      ``,
      `### 二、 生命体征与出入量动态`,
      selection && !vitals ? "未选择生命体征条目。" : vitalsText(vitals),
      selection && !fluid ? "未选择出入量条目。" : blocks || selection ? fluidText(fluid) : digest.fluid_digest || fluidText(null),
      ``,
      `### 三、 拟定查房评估与处置方案 (A/P)`,
      assessmentAndPlan || "未提供医师评估与处置内容。",
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
      selected_item_ids: chosen.map((item) => item.id),
      evidence_references: copy(list(progressiveViews.drilldown?.full_evidence_spans).filter((item) => !selection || selection.has(item.item_id))),
    };
  }
}
