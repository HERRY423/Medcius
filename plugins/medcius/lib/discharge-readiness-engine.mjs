// Discharge Readiness & Data Completeness Engine (出院资料核对与完整性检查引擎)
// Evaluates diagnostic closure (pathology/cultures/imaging), home medication reconciliation,
// post-discharge follow-up plans, patient affordability/access context, and critical safety gaps before discharge sign-off.

import { buildPatientAffordabilityContext } from "./patient-affordability-context.mjs";

export class DischargeReadinessEngine {
  /**
   * Evaluate inpatient record for discharge readiness and completeness.
   * 
   * @param {Object} params
   * @param {Object} params.patient - Patient profile
   * @param {Object} params.encounter - Encounter & admission info
   * @param {Array} params.diagnosticReports - All ordered diagnostic & lab reports
   * @param {Array} params.inpatientMedications - Active inpatient medications
   * @param {Array} params.dischargeMedications - Proposed discharge take-home medications
   * @param {Array} params.notes - Progress notes & discharge summaries
   * @param {Array} params.allergies - Documented allergies
   * @param {Array} params.financialAccessRecords - Source-bound affordability/access records
   */
  static evaluateDischargeReadiness({
    patient = {},
    encounter = {},
    diagnosticReports = [],
    inpatientMedications = [],
    dischargeMedications = [],
    notes = [],
    allergies = null,
    financialAccessRecords = [],
  }) {
    if (!patient.id) {
      throw new Error("FAIL_CLOSED: Patient identifier is required for discharge completeness check");
    }

    // 1. Diagnostic Report Loop Closure (关键检查检验闭环核对)
    const pendingDiagnosticReports = [];
    const criticalClosedReports = [];

    for (const rep of diagnosticReports) {
      const repName = rep.name || rep.study_name || "检查项目";
      const isPending = rep.status === "preliminary" || rep.status === "registered" || rep.status === "pending";
      const isHighImpact = /病理|培养|药敏|活检|骨髓|基因|ct|mri|造影|超声|心电/i.test(repName);

      if (isPending) {
        pendingDiagnosticReports.push({
          id: rep.id,
          report_name: repName,
          status: rep.status,
          ordered_at: rep.ordered_at,
          is_high_impact: isHighImpact,
          safety_warning: isHighImpact ? `⚠️【高风险未闭环】${repName}尚未出具最终报告，出院前需确认追踪途径或交代患者随访机制` : `检查检验尚未回报正式报告`,
        });
      } else {
        criticalClosedReports.push({
          id: rep.id,
          report_name: repName,
          ordered_at: rep.ordered_at,
          status: "final",
          impression: rep.impression || "正常回报",
        });
      }
    }

    // 2. Medication Reconciliation (出院带药与在院用药一致性核对)
    const reconciliationIssues = [];
    const ivMeds = inpatientMedications.filter((m) => m.route === "iv" || m.route === "ivgtt" || m.route === "静滴");

    // Check if IV medications were left without oral transition or discontinuation
    for (const ivMed of ivMeds) {
      if (/抗生素|头孢|美罗培南|万古霉素|莫西沙星/i.test(ivMed.drug_name || "")) {
        const hasOralAnti = dischargeMedications.some((dm) => /口服|po/i.test(dm.route || "") && /头孢|沙星|阿莫西林/i.test(dm.drug_name || ""));
        if (!hasOralAnti) {
          reconciliationIssues.push({
            type: "IV_ANTIBIOTIC_TRANSITION",
            drug_name: ivMed.drug_name,
            severity: "MEDIUM",
            message: `在院使用静脉抗菌药物 [${ivMed.drug_name}]，出院带药未见口服降阶梯衔接方案，需核实是否已达疗程或停药。`,
          });
        }
      }
    }

    // Check antiplatelet / anticoagulant continuity for cardiac patients
    const isCardiacPatient = /冠心病|心肌梗死|PCI|支架|房颤/i.test(patient.primary_diagnosis || "");
    if (isCardiacPatient) {
      const hasDapt = dischargeMedications.some((m) => /阿司匹林|氯吡格雷|替格瑞洛/i.test(m.drug_name || ""));
      const hasOac = dischargeMedications.some((m) => /利伐沙班|华法林|达比加群|艾多沙班/i.test(m.drug_name || ""));
      if (!hasDapt && !hasOac) {
        reconciliationIssues.push({
          type: "ANTIPLATELET_DISCONTINUITY",
          severity: "HIGH",
          message: `心血管/支架术后患者出院带药中未检出抗血小板或抗凝药物（如阿司匹林/替格瑞洛/利伐沙班），需重点复核。`,
        });
      }
    }

    // 3. Discharge Safety Gaps & Documentation Completeness (出院资料缺口)
    const dischargeGaps = [];

    // Allergy check
    if (allergies == null || (Array.isArray(allergies) && allergies.length === 0)) {
      dischargeGaps.push({
        gap_type: "ALLERGY_UNRECORDED",
        severity: "HIGH",
        description: "出院记录与系统中药物过敏史未明确录入",
        action: "出院小结中必须补录明确过敏史或标明'无已知药物过敏'",
      });
    }

    // Primary diagnosis check
    if (!patient.primary_diagnosis || patient.primary_diagnosis.includes("待查")) {
      dischargeGaps.push({
        gap_type: "DIAGNOSIS_UNCERTAIN",
        severity: "HIGH",
        description: "主要出院诊断仍为待查或未明确",
        action: "出院前需结合住院期间检查检验出具确诊主要诊断",
      });
    }

    // Follow-up appointment check
    let hasFollowUpMention = false;
    for (const note of notes) {
      if (/随访|复诊|拆线|复查/i.test(note.text || "")) {
        hasFollowUpMention = true;
        break;
      }
    }
    if (!hasFollowUpMention) {
      dischargeGaps.push({
        gap_type: "FOLLOW_UP_MISSING",
        severity: "MEDIUM",
        description: "出院记录中未见明确门诊复诊与随访时间节点安排",
        action: "明确出院后 1~2 周专科门诊复诊时点及复查项目",
      });
    }

    // 4. Patient affordability and access context. This is deliberately separate
    // from the clinical discharge verdict and cannot trigger medication changes.
    const patientAffordability = buildPatientAffordabilityContext({
      records: financialAccessRecords,
      dischargeMedicationCount: dischargeMedications.length,
    });

    // 5. Overall clinical-document readiness verdict
    const highRiskPendingCount = pendingDiagnosticReports.filter((p) => p.is_high_impact).length;
    const highSeverityGapsCount = dischargeGaps.filter((g) => g.severity === "HIGH").length;
    const hasHighSeverityRecon = reconciliationIssues.some((m) => m.severity === "HIGH");
    const isReadyForDischarge = highRiskPendingCount === 0 && highSeverityGapsCount === 0 && !hasHighSeverityRecon;

    return {
      patient: {
        id: patient.id,
        name: patient.name || "脱敏患者",
        bed_number: patient.bed_number,
        primary_diagnosis: patient.primary_diagnosis,
        admission_date: patient.admission_date,
      },
      readiness_verdict: {
        is_ready: isReadyForDischarge,
        status_label: isReadyForDischarge ? "🟢 出院资料齐备 (准备度良好)" : "⚠️ 存在待闭环检查或安全缺口 (需医生复核)",
        high_risk_pending_count: highRiskPendingCount,
        critical_gaps_count: highSeverityGapsCount,
        financial_access_status: patientAffordability.assessment_status,
        financial_access_follow_up_required: patientAffordability.follow_up_required,
      },
      pending_diagnostic_reports: pendingDiagnosticReports,
      closed_reports_count: criticalClosedReports.length,
      medication_reconciliation_issues: reconciliationIssues,
      discharge_safety_gaps: dischargeGaps,
      patient_affordability: patientAffordability,
      discharge_red_flags: [
        "胸痛再次加重或呈压榨样放射痛",
        "突发呼吸困难、端坐呼吸或夜间憋醒",
        "活动性黑便、呕血或穿刺点持续出血",
        "体温再次升高 ≥ 38.5℃ 或寒战",
        "双下肢不对称水肿伴小腿压痛 (警惕 DVT)",
      ],
    };
  }

  /**
   * Generate formatted Discharge Checklist Report text.
   */
  static generateDischargeChecklistText({ readinessResult, attendingDoctor = "主管医师" }) {
    const { patient, readiness_verdict, pending_diagnostic_reports, medication_reconciliation_issues, discharge_safety_gaps, patient_affordability, discharge_red_flags } = readinessResult;

    const lines = [];
    lines.push(`【出院资料完整性与安全准备度核对清单 (Discharge Checklist)】`);
    lines.push(`患者姓名：${patient.name}  |  床号：${patient.bed_number}  |  入院日期：${patient.admission_date || "近期"}`);
    lines.push(`主要出院诊断：${patient.primary_diagnosis || "未明确"}`);
    lines.push(`核对结论：${readiness_verdict.status_label}`);
    lines.push(`审核医师：${attendingDoctor}  |  生成时间：${new Date().toISOString().replace("T", " ").slice(0, 16)}`);
    lines.push("");

    lines.push(`一、关键检查检验闭环核查`);
    if (pending_diagnostic_reports.length > 0) {
      pending_diagnostic_reports.forEach((r) => lines.push(`  • ${r.safety_warning} (开立时间: ${r.ordered_at ? r.ordered_at.slice(0, 10) : '未知'})`));
    } else {
      lines.push(`  • 当前输入范围内未识别到待回报项目；不代表未提供的数据源中不存在未闭环检查`);
    }
    lines.push("");

    lines.push(`二、出院带药与在院医嘱一致性核对`);
    if (medication_reconciliation_issues.length > 0) {
      medication_reconciliation_issues.forEach((m) => lines.push(`  • [用药提示] ${m.message}`));
    } else {
      lines.push(`  • 当前规则覆盖范围内未识别到用药衔接问题；不替代药师或主管医师完整用药核对`);
    }
    lines.push("");

    lines.push(`三、出院前资料缺口与质控提示`);
    if (discharge_safety_gaps.length > 0) {
      discharge_safety_gaps.forEach((g) => lines.push(`  • [${g.severity}] ${g.description} ➔ 【对策】${g.action}`));
    } else {
      lines.push(`  • 当前输入范围内未识别到上述资料缺口；不代表未提供资料已完成核对`);
    }
    lines.push("");

    lines.push(`四、患者可负担性与医疗可获得性核对`);
    if (patient_affordability.assessment_status === "unknown") {
      lines.push(`  • [UNKNOWN] 未获得可验证的患者费用负担/医疗可获得性筛查，不能推断“无经济障碍”`);
    } else {
      lines.push(`  • 状态：${patient_affordability.assessment_status}`);
    }
    patient_affordability.verified_facts
      .filter((fact) => fact.kind === "patient_cost_estimate" && fact.status === "available")
      .forEach((fact) => lines.push(`  • [来源估算] ${fact.category}: ${fact.amount} ${fact.currency}，有效至 ${fact.valid_until.slice(0, 10)}；非账单或待遇裁定`));
    patient_affordability.action_items.forEach((item) => lines.push(`  • [人工核实] ${item.code} / ${item.category} / 来源 ${item.source_reference.resource_id}`));
    patient_affordability.data_gaps.forEach((gap) => lines.push(`  • [资料缺口] ${gap.code}${gap.reason ? ` (${gap.reason})` : ""}`));
    lines.push(`  • 本节不计算患者自付额、不推荐替代治疗，也不自动改变出院医学判断`);
    lines.push("");

    lines.push(`五、出院健康宣教与红旗预警体征 (交代患者)`);
    discharge_red_flags.forEach((f) => lines.push(`  • 🚩 ${f}`));
    lines.push("");

    lines.push(`临床医师确认签名：${attendingDoctor} (电子核签)`);

    return lines.join("\n");
  }
}
