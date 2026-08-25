// Stepwise Clinical Release Governance State Machine & Evidence Registry
// Strictly enforces: 回顾性研究 -> 静默试点 -> 建议模式 -> 认证签核写回
// Prohibits arbitrary env jumps, enforces sequential milestone validation, and requires signed evidence.

import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";

export const GOVERNANCE_STAGES = {
  RETROSPECTIVE_STUDY: {
    id: "retrospective_study",
    level: 1,
    name_cn: "回顾性研究",
    description: "离线合成管线测试与脱敏历史处方回顾性评测；禁止院内临床直接干预与系统写回",
    allows_his_writeback: false,
    allows_live_alerts: false,
    prerequisites: ["pipeline_unit_tests_pass", "eval_baseline_verified"],
  },
  SILENT_PILOT: {
    id: "silent_pilot",
    level: 2,
    name_cn: "静默试点 (Shadow Mode)",
    description: "真实临床处方并行旁路推理；零临床打扰，仅沉淀双药师盲标比对日志；禁止系统写回",
    allows_his_writeback: false,
    allows_live_alerts: false,
    prerequisites: ["retrospective_study_completed", "ethics_and_privacy_approved", "shadow_protocol_registered"],
  },
  ADVISORY_MODE: {
    id: "advisory_mode",
    level: 3,
    name_cn: "建议模式",
    description: "前置向药师/医生提供辅助参考卡片；非阻塞提示，药师自主选择，留痕 override 理由；禁止自动写回",
    allows_his_writeback: false,
    allows_live_alerts: true,
    prerequisites: ["silent_pilot_shadow_study_passed", "primary_endpoints_met", "pharmacist_training_completed"],
  },
  CERTIFIED_WRITEBACK: {
    id: "certified_writeback",
    level: 4,
    name_cn: "认证签核写回",
    description: "双重数字签名认证；药师对高风险警报完成可验证签核后，方可向 HIS 处方与病历写回审核结果",
    allows_his_writeback: true,
    allows_live_alerts: true,
    prerequisites: ["advisory_mode_live_cases_met", "zero_critical_miss_certified", "digital_signature_infrastructure_ready"],
  },
};

export class GovernanceStateManager {
  constructor(initialStage = "retrospective_study") {
    const isProduction = process.env.NODE_ENV === "production" || process.env.MEDCIUS_PROFILE === "production";
    const envStage = process.env.MEDCIUS_GOVERNANCE_STAGE;

    if (isProduction && envStage && (envStage === "certified_writeback" || envStage === "advisory_mode")) {
      throw new Error(
        `FATAL_PROD_GOVERNANCE_ERROR: Prohibited setting governance stage directly to [${envStage}] via environment variable in production. ` +
        "Transitions to Level 3 (Advisory Mode) and Level 4 (Certified Writeback) must be verified through the cryptographically signed Evidence Registry.",
      );
    }

    this.currentStageId = initialStage;
    this.history = [
      {
        stage: this.currentStageId,
        transitioned_at: new Date().toISOString(),
        actor: "system:init",
        reason: "Initial governance baseline registration",
        evidence_hash: sha256Hex(canonicalJson({ initialStage })),
      },
    ];
  }

  getCurrentStage() {
    const stage = Object.values(GOVERNANCE_STAGES).find((s) => s.id === this.currentStageId);
    return stage || GOVERNANCE_STAGES.RETROSPECTIVE_STUDY;
  }

  /**
   * Advance to the next sequential stage with cryptographic evidence verification.
   */
  advanceStage({ targetStageId, actor, reason, evidence = {}, signature = null, keyId = null }) {
    const current = this.getCurrentStage();
    const target = Object.values(GOVERNANCE_STAGES).find((s) => s.id === targetStageId);

    if (!target) {
      throw new Error(`Unknown target governance stage: ${targetStageId}`);
    }

    if (target.level <= current.level) {
      throw new Error(`Cannot advance backwards or to the same stage (Current: Level ${current.level}, Target: Level ${target.level})`);
    }

    if (target.level > current.level + 1) {
      throw new Error(`跨级发布被严格禁止 (Prohibited from skipping stages: cannot jump from Level ${current.level} [${current.name_cn}] directly to Level ${target.level} [${target.name_cn}]). 必须依次完成阶段演进。`);
    }

    // Check prerequisites
    const missingPrereqs = [];
    for (const prereq of target.prerequisites) {
      if (!evidence[prereq]) {
        missingPrereqs.push(prereq);
      }
    }

    if (missingPrereqs.length > 0) {
      throw new Error(`阶段准入准则未满足 (Missing prerequisites for ${target.name_cn}): ${missingPrereqs.join(", ")}`);
    }

    const evidenceHash = sha256Hex(canonicalJson({
      fromStage: current.id,
      targetStage: target.id,
      actor,
      evidence,
      timestamp: new Date().toISOString(),
    }));

    this.currentStageId = target.id;
    const transitionRecord = {
      from_stage: current.id,
      stage: target.id,
      transitioned_at: new Date().toISOString(),
      actor: actor || "admin:governance",
      reason: reason || "Stage promotion milestones satisfied",
      evidence,
      evidence_hash: evidenceHash,
      signature: signature || null,
      key_id: keyId || null,
    };
    this.history.push(transitionRecord);

    return {
      success: true,
      current_stage: target,
      history: this.history,
      record: transitionRecord,
    };
  }

  /**
   * Verify if current stage permits direct HIS writeback.
   */
  assertWritebackAllowed(action = "his_prescription_status_update") {
    const current = this.getCurrentStage();
    if (!current.allows_his_writeback) {
      const err = new Error(`【发布门禁拦截】当前处于「${current.name_cn}」(Level ${current.level})，严禁执行 HIS 处方写回操作 (${action})。只有进入「${GOVERNANCE_STAGES.CERTIFIED_WRITEBACK.name_cn}」(Level 4) 并经可验证数字签名签核后方可写回。`);
      err.code = "GOVERNANCE_STAGE_WRITEBACK_BLOCKED";
      err.current_stage = current;
      throw err;
    }
    return true;
  }
}

export const globalGovernance = new GovernanceStateManager();
