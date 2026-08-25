// Medcius Multi-Agent Cross-Validation & Escalation Protocol
import { randomUUID } from "node:crypto";

export class EscalationProtocol {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Cross-validate clinical consistency between CodingWorker and PharmaWorker.
   * e.g., if PharmaWorker detects severe renal impairment (CrCl < 30) but CodingWorker has no renal diagnosis.
   */
  crossValidateWorkers({ extraction, coding, pharma }) {
    const alerts = [];

    // Check 1: Renal impairment lab vs missing diagnosis code
    if (pharma?.renal_metrics?.crcl && pharma.renal_metrics.crcl < 30) {
      const hasKidneyDiagnosis = coding?.diagnoses?.some(
        (d) => d.code?.startsWith("N18") || d.term?.includes("肾") || d.term?.includes("尿毒")
      );
      if (!hasKidneyDiagnosis) {
        alerts.push({
          type: "CLINICAL_DISCORDANCE",
          urgency: "HIGH",
          title: "肾功能重度不全但缺失对应肾病诊断编码",
          description: `药理筛查检测到患者 CrCl = ${pharma.renal_metrics.crcl.toFixed(1)} ml/min，但医保编码列表中未包含慢性肾脏病 (N18) 或急性肾损伤诊断，可能导致医保限定支付受阻或漏诊`,
          fromWorker: "PharmaWorker",
          toWorker: "CodingWorker",
          suggestedAction: "建议主管医师复核并补充开立肾功能衰竭/慢性肾功能不全诊断",
        });
      }
    }

    // Check 2: High bleeding risk combination without antiplatelet indication
    if (pharma?.flags?.some((f) => f.category === "interaction" && f.issue?.includes("出血"))) {
      const hasCardioDiagnosis = coding?.diagnoses?.some(
        (d) => d.code?.startsWith("I25") || d.code?.startsWith("I48") || d.term?.includes("冠心病") || d.term?.includes("房颤")
      );
      if (!hasCardioDiagnosis) {
        alerts.push({
          type: "INDICATION_GAP",
          urgency: "MEDIUM",
          title: "强效抗栓治疗但缺乏明确心脑血管适应症",
          description: "处方包含高出血风险抗凝/抗血小板药物，但诊断中未匹配明确冠心病或房颤诊断",
          fromWorker: "PharmaWorker",
          toWorker: "CodingWorker",
          suggestedAction: "核实抗栓药物开立适应症",
        });
      }
    }

    return {
      crossValidationPassed: alerts.length === 0,
      alertsCount: alerts.length,
      alerts,
    };
  }

  /**
   * Evaluate if a case warrants human pharmacist emergency escalation.
   */
  evaluateEscalationThreshold({ pharmaVerdict, crossValidationAlerts }) {
    if (pharmaVerdict?.verdict === "REQUIRES_PHARMACIST_REVIEW") {
      return {
        shouldEscalate: true,
        escalationTier: "TIER_2_SENIOR_PHARMACIST",
        reason: "包含未收录药品或复杂多学科联合用药，系统无法自主闭环",
      };
    }

    if (crossValidationAlerts?.some((a) => a.urgency === "HIGH")) {
      return {
        shouldEscalate: true,
        escalationTier: "TIER_1_WARD_PHARMACIST",
        reason: "跨专科 Worker 检出严重临床矛盾（如器官衰竭与诊断脱节）",
      };
    }

    return {
      shouldEscalate: false,
      escalationTier: "ROUTINE",
      reason: "常规流程自动闭环",
    };
  }
}

export const escalationProtocol = new EscalationProtocol();
