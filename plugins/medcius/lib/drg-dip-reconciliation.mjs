/**
 * DRG/DIP Reconciliation Builder (分组对账契约 · 缺口四).
 *
 * Medcius 不做 DRG/DIP 分组器（D 边界，settlement/record-quality 均已声明）。
 * 医院真实结算使用"医院当期分组器与费率表"。本模块定义并构建**对账输出契约**：
 * 把 Medcius 病案要素质量核对（record-quality report）与医院分组器的入组结果
 * 做确定性联接，产出结构化对账报告，用于回答：
 *   1. 本次入组依赖的要素（主诊断/手术操作/天数/费用）是否齐备且一致；
 *   2. 数据质量缺口哪些会直接威胁入组与支付对账（如主诊断缺失=无法入组主因）；
 *   3. 医院分组器给出的分组与费率信息按原样带出处回显，不做再解释、不预测。
 *
 * Fail-closed: 缺 recordQualityReport 或 hospitalGrouping → 拒绝构建。
 * 本报告不是分组结果、不是支付金额预测、不是违规判定。
 */

import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";

export const RECONCILIATION_SCHEMA = "medcius.drg-dip-reconciliation.v1";

/** finding code → 支付对账风险类别（确定性映射，供病案/医保办复核排序）。 */
const PAYMENT_RISK_BY_FINDING = {
  PRIMARY_DISCHARGE_DIAGNOSIS_MISSING: { risk: "grouping_blocked", note: "主要诊断缺失将直接导致分组器无法入组" },
  UNCERTAIN_PRIMARY_DIAGNOSIS: { risk: "grouping_instability", note: "疑似/待查主诊断不得编码，入组结果不稳定" },
  STAY_DAYS_MISMATCH: { risk: "days_billing_mismatch", note: "住院天数与日期代数不一致，按天计费/权重核算将出现对账差异" },
  FEE_TOTAL_UNBALANCED: { risk: "fee_billing_mismatch", note: "费用总额与分类代数和不平，结算清单收费栏会被退回" },
  DISCHARGE_METHOD_ILLEGAL: { risk: "settlement_field_invalid", note: "离院方式取值非法，清单机检将拒绝" },
  DEATH_METHOD_WITHOUT_DEATH_RECORD: { risk: "documentation_review", note: "死亡离院缺死亡记录，DRG 伴随结局变量不可信" },
  OBSTETRIC_DIAGNOSIS_SEX_CONFLICT: { risk: "coding_review", note: "人群-章节冲突须病案复核后才能入组" },
  NEONATAL_DIAGNOSIS_AGE_CONFLICT: { risk: "coding_review", note: "人群-章节冲突须病案复核后才能入组" },
  DISCHARGE_BEFORE_ADMISSION: { risk: "days_billing_mismatch", note: "出入院日期倒置" },
  ENCOUNTER_DATE_MISSING: { risk: "grouping_instability", note: "出入院日期缺失，住院天数要素缺失" },
  RECORDED_STAY_DAYS_MISSING: { risk: "grouping_instability", note: "住院天数未记载" },
  PROCEDURE_WITHOUT_SUPPORTING_DIAGNOSIS: { risk: "grouping_instability", note: "手术操作缺诊断支持，外科组入组存疑" },
  TUMOR_PATHOLOGY_HINT: { risk: "documentation_review", note: "肿瘤诊断缺病理支持，MCC/CC 判定可能受影响" },
  EXTERNAL_CAUSE_HINT: { risk: "documentation_review", note: "损伤中毒缺外部原因记载" },
  DISCHARGE_METHOD_MISSING: { risk: "settlement_field_invalid", note: "离院方式未记载" },
};

export function buildDrgDipReconciliation({ recordQualityReport, hospitalGrouping, encounter = {}, now = new Date().toISOString() }) {
  if (!recordQualityReport || recordQualityReport.schema_version !== "medcius.nhsa-record-quality-report.v1") {
    throw new Error("RECONCILIATION_RECORD_QUALITY_REPORT_REQUIRED (v1)");
  }
  if (!hospitalGrouping || typeof hospitalGrouping !== "object") {
    throw new Error("RECONCILIATION_HOSPITAL_GROUPING_REQUIRED");
  }
  const groupingCode = hospitalGrouping.code ?? null;
  const groupingScheme = hospitalGrouping.scheme ?? null;
  if (!groupingCode || !["drg", "dip"].includes(groupingScheme)) {
    throw new Error("RECONCILIATION_GROUPING_RESULT_REQUIRED: hospitalGrouping.code + scheme(drg|dip) 必填（医院当期分组器输出，按原样回显）");
  }

  const findings = [
    ...(recordQualityReport.element_gaps ?? []).map((f) => ({ pool: "element_gaps", ...f })),
    ...(recordQualityReport.algebra_conflicts ?? []).map((f) => ({ pool: "algebra_conflicts", ...f })),
    ...(recordQualityReport.legality_conflicts ?? []).map((f) => ({ pool: "legality_conflicts", ...f })),
  ];
  const dataQualityRisks = findings
    .map((f) => ({
      finding_code: f.code,
      pool: f.pool,
      severity: f.severity,
      payment_risk: PAYMENT_RISK_BY_FINDING[f.code]?.risk ?? "general_data_quality",
      note: PAYMENT_RISK_BY_FINDING[f.code]?.note ?? "病案数据质量复核项",
      evidence: f.evidence,
    }))
    .sort((a, b) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[a.severity] - { HIGH: 0, MEDIUM: 1, LOW: 2 }[b.severity]));

  const elementsComplete = findings.length === 0;
  const status = elementsComplete ? "clean" : dataQualityRisks.some((r) => r.payment_risk === "grouping_blocked") ? "grouping_blocked" : "elements_incomplete";

  return {
    schema_version: RECONCILIATION_SCHEMA,
    status,
    encounter: {
      patient_id: encounter.patient_id ?? null,
      encounter_id: encounter.encounter_id ?? null,
      admission_date: recordQualityReport.parsed_context?.admission_date ?? null,
      discharge_date: recordQualityReport.parsed_context?.discharge_date ?? null,
    },
    elements: {
      complete: elementsComplete,
      finding_count: findings.length,
      high_severity_count: dataQualityRisks.filter((r) => r.severity === "HIGH").length,
    },
    hospital_grouping_echo: {
      scheme: groupingScheme,
      code: groupingCode,
      code_system: hospitalGrouping.code_system ?? null,
      version: hospitalGrouping.version ?? null,
      weight_or_score: hospitalGrouping.weight_or_score ?? null,
      source: hospitalGrouping.source ?? "医院当期分组器",
      note: "分组结果按原样回显带出处；Medcius 不复算、不预测、不解释分组合理性。",
    },
    data_quality_risks: dataQualityRisks,
    reconciliation: {
      quality_gate: elementsComplete ? "pass" : "action_needed",
      recommended_owner: elementsComplete ? null : "病案/医保办复核（排序见 data_quality_risks）",
      grouping_affected: !elementsComplete,
    },
    boundary: {
      is_drg_dip_grouper: false,
      predicts_payment: false,
      adjudicates_violation: false,
      note: "本报告是要素质量与医院分组结果的确定性对账视图；分组与费率以医院当期分组器、费率表与经办规则为准。",
    },
    digest: null,
  };
}

/** Canonical digest for audit-chain binding (payload excludes the digest itself). */
export function reconciliationDigest(reconciliation) {
  const { digest: _ignored, ...rest } = reconciliation;
  return sha256Hex(canonicalJson(rest));
}
