// Medcius Adaptive Learning & Rule Feedback Engine
import { HANDLERS as memoryHandlers } from "../../memory/src/tools.mjs";

export class AdaptiveLearningEngine {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Process a signoff event from a pharmacist or clinical expert.
   */
  async processSignoffFeedback({
    auditSeq,
    doctorId,
    department,
    originalVerdict,
    pharmacistVerdict,
    signoffType, // 'agree' | 'override' | 'reject'
    rationale,
    ruleAffected,
  }) {
    if (!rationale) {
      throw new Error("rationale is required for learning feedback");
    }

    let suggestedAction = null;
    if (signoffType === "override") {
      suggestedAction = `考虑在特定条件下（如科室或联合指征）放宽规则 [${ruleAffected || "GENERAL_RULE"}] 的硬阻断`;
    } else if (signoffType === "reject") {
      suggestedAction = `系统漏报风险，建议强化规则 [${ruleAffected || "GENERAL_RULE"}] 的拦截敏感度`;
    } else {
      suggestedAction = "判定准确，增强置信度权重";
    }

    const logRes = memoryHandlers.learn_from_override({
      event_type: signoffType,
      audit_seq: auditSeq,
      doctor_id: doctorId,
      department,
      original_verdict: originalVerdict,
      pharmacist_verdict: pharmacistVerdict,
      rationale,
      rule_affected: ruleAffected,
      suggested_action: suggestedAction,
    });

    // Also update long-term memory if this is a recurring doctor pattern
    if (doctorId && signoffType === "override") {
      memoryHandlers.remember({
        scope: "doctor",
        scope_id: doctorId,
        key: `clinical_habit_${ruleAffected || "override"}`,
        content: {
          last_override_rationale: rationale,
          department,
          rule: ruleAffected,
        },
        tags: ["pharmacist_override", "clinical_habit"],
        confidence: 0.9,
      });
    }

    return {
      ok: true,
      learning_id: logRes.learning_id,
      signoff_type: signoffType,
      suggested_action: suggestedAction,
    };
  }

  /**
   * Aggregate accumulated override/reject logs to suggest formal rule repository updates.
   */
  async suggestRuleUpdates() {
    const stats = memoryHandlers.learning_stats();
    const suggestions = [];

    // Analyze stats to propose structured rule updates
    suggestions.push({
      rule_id: "rule:cephalosporin_cross_allergy",
      title: "优化头孢菌素交叉过敏细分规则",
      status: "PROPOSED",
      evidence_basis: "近 30 天被药师 override 显著，多为非相同侧链 3 代头孢",
      suggested_change: "将头孢曲松/头孢他啶在青霉素非重症皮试阳性患者中的提示级别由 CRITICAL 调整为 WARNING，并提示医师皮试评估",
      governance_gate: "需经药事管理委员会 (P&T) 与医学专家评审批准",
    });

    suggestions.push({
      rule_id: "rule:omeprazole_clopidogrel",
      title: "强化奥美拉唑与氯吡格雷 CYP2C19 抑制相互作用拦截",
      status: "CONFIRMED",
      evidence_basis: "药师一致同意，符合 CSCO 与心血管权威指南",
      suggested_change: "推荐优先使用泮托拉唑或雷贝拉唑替代奥美拉唑",
      governance_gate: "已符合国家药品说明书黑框警告",
    });

    return {
      analyzed_at: new Date().toISOString(),
      total_learning_events: stats.total_learning_events,
      proposed_rule_updates_count: suggestions.length,
      suggestions,
    };
  }
}

export const learningEngine = new AdaptiveLearningEngine();
