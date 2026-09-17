/**
 * NHSA Record Quality Engine (病案首页 / 医保结算清单要素质量核对引擎)
 *
 * Deterministic, fail-closed, evidence-bound data-quality checks over a Chinese
 * clinical record text (出院记录/病案首页文本/结算清单文本). It reports:
 *   - element_gaps        必填要素缺失
 *   - algebra_conflicts   代数不一致（住院天数、费用合计）
 *   - legality_conflicts  合法性冲突（离院方式取值、性别/年龄-诊断章节冲突、死亡一致性）
 *   - advisory_hints      提示级复核建议（待查主诊断、肿瘤病理、损伤外部原因）
 *
 * Hard boundaries:
 *   - 不是 DRG/DIP 分组器，不预测入组、权重或支付金额；
 *   - 不输出编码修改建议（coding suggestions），只输出要素缺口与冲突，供病案/编码人员复核；
 *   - 不判定医保违规，不计算报销金额；
 *   - 每条发现尽量绑定原文 span；无法验证时如实输出 not_mentioned。
 *
 * 依据（检查规则来源，均为公开规范）：
 *   - 《住院病案首页数据填写质量规范（暂行）》（国卫办医发〔2016〕24 号）
 *   - 《医疗保障基金结算清单填写规范》（国家医保局，2021 年发布及后续修订）
 *   - ICD-10 章节确定性前缀规则（O 章节=妊娠/分娩/产褥期，P 章节=围产期）
 */

import {
  parseCnNote,
  parseCnDate,
  splitSections,
  DISCHARGE_METHOD_NAMES,
} from "./parse-cn-note.mjs";

const VALID_DISCHARGE_METHODS = new Set([1, 2, 3, 4, 5, 9]);
const FEE_TOLERANCE = 0.01;

const OBSTETRIC_TERM_RE = /妊娠|分娩|产褥|剖宫产|剖腹产|宫内孕|异位妊娠|宫外孕|流产|羊水|胎盘|胎膜|胎位/;
const NEONATAL_TERM_RE = /新生儿|围产期|早产儿|足月儿/;
const TUMOR_TERM_RE = /恶性肿瘤|癌|淋巴瘤|白血病/;
const TRAUMA_TERM_RE = /骨折|损伤|烧伤|烫伤|冻伤|中毒|电击伤|挤压伤/;

function finding(code, severity, message, evidence = {}) {
  return {
    code,
    severity,
    message,
    evidence: {
      section: evidence.section ?? null,
      span: evidence.span ?? null,
      expected: evidence.expected ?? null,
      actual: evidence.actual ?? null,
    },
  };
}

function dxTerms(parsed) {
  const terms = [];
  for (const f of [
    parsed.admission_diagnosis,
    parsed.discharge_diagnosis_primary,
    parsed.discharge_diagnosis_other,
  ]) {
    if (!f?.value) continue;
    for (const t of String(f.value).split(/[；;]/)) {
      const s = t.trim();
      if (s) terms.push(s);
    }
  }
  return terms;
}

function procTerms(parsed) {
  if (!parsed.procedures?.value) return [];
  return String(parsed.procedures.value)
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function allDxText(parsed) {
  return dxTerms(parsed).join("；");
}

/**
 * @param {string} text 病历/结算清单文本（合成或脱敏；真实患者文本须在医院授权边界内）
 * @param {{ diagnosis_codes?: Array<{code: string, kind?: string}> }} [opts]
 *        结算流程已解析出的诊断编码（用于确定性的章节前缀规则；无编码时退回关键词规则）
 */
export function buildRecordQualityReport(text, opts = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("RECORD_TEXT_REQUIRED");
  }
  const parsed = parseCnNote(text);
  const diagnosisCodes = Array.isArray(opts.diagnosis_codes)
    ? opts.diagnosis_codes.filter((c) => c && typeof c.code === "string" && c.code.trim())
    : [];

  const elementGaps = [];
  const algebraConflicts = [];
  const legalityConflicts = [];
  const advisoryHints = [];

  // ---- 1. 必填要素（结算清单/病案首页住院诊疗信息栏）----
  if (!parsed.discharge_diagnosis_primary?.value) {
    elementGaps.push(
      finding("PRIMARY_DISCHARGE_DIAGNOSIS_MISSING", "HIGH", "出院主诊断缺失或仅为疑似/待查表述，结算清单主要诊断栏不得为空", {
        section: "诊断",
        expected: "明确的出院主诊断",
        actual: null,
      }),
    );
  }
  if (parsed.discharge_method?.value == null && !parsed.discharge_method?.name_cn) {
    elementGaps.push(
      finding("DISCHARGE_METHOD_MISSING", "MEDIUM", "离院方式未记载，结算清单/病案首页离院方式栏必填", {
        section: "离院方式",
        expected: "1 医嘱离院 / 2 医嘱转院 / 3 医嘱转基层 / 4 非医嘱离院 / 5 死亡 / 9 其他",
        actual: null,
      }),
    );
  }
  const dates = parsed.encounter_dates;
  if (!dates.admission_date || !dates.discharge_date) {
    elementGaps.push(
      finding("ENCOUNTER_DATE_MISSING", "MEDIUM", "入院日期或出院日期未记载，住院诊疗信息要素不完整", {
        section: "入院/出院日期",
        expected: "入院日期与出院日期",
        actual: { admission_date: dates.admission_date?.value ?? null, discharge_date: dates.discharge_date?.value ?? null },
      }),
    );
  }

  // ---- 2. 代数一致性（确定性校验，非分组、非估算）----
  if (
    dates.admission_date
    && dates.discharge_date
    && dates.recorded_stay_days
    && dates.computed_stay_days != null
    && dates.recorded_stay_days.value !== dates.computed_stay_days
  ) {
    algebraConflicts.push(
      finding("STAY_DAYS_MISMATCH", "HIGH", `住院天数与出入院日期代数不一致：按日期计算应为 ${dates.computed_stay_days} 天（出院-入院+1），记录值为 ${dates.recorded_stay_days.value} 天`, {
        section: "住院天数",
        span: dates.recorded_stay_days.span,
        expected: dates.computed_stay_days,
        actual: dates.recorded_stay_days.value,
      }),
    );
  } else if (dates.admission_date && dates.discharge_date && !dates.recorded_stay_days) {
    elementGaps.push(
      finding("RECORDED_STAY_DAYS_MISSING", "LOW", "出入院日期齐备但住院天数未记载，须病案复核补齐", {
        section: "住院天数",
        expected: dates.computed_stay_days,
        actual: null,
      }),
    );
  }
  if (
    dates.admission_date
    && dates.discharge_date
    && new Date(dates.discharge_date.value) < new Date(dates.admission_date.value)
  ) {
    legalityConflicts.push(
      finding("DISCHARGE_BEFORE_ADMISSION", "HIGH", "出院日期早于入院日期，日期逻辑冲突", {
        section: "入院/出院日期",
        expected: "出院日期 >= 入院日期",
        actual: `${dates.admission_date.value} → ${dates.discharge_date.value}`,
      }),
    );
  }
  const fees = parsed.fees;
  if (fees.total && fees.items.length > 0 && fees.sum != null && Math.abs(fees.total.value - fees.sum) > FEE_TOLERANCE) {
    algebraConflicts.push(
      finding("FEE_TOTAL_UNBALANCED", "HIGH", `费用总额与分类费用代数和不一致：总额 ${fees.total.value} 元，分类合计 ${fees.sum} 元`, {
        section: "费用",
        span: fees.total.span,
        expected: fees.sum,
        actual: fees.total.value,
      }),
    );
  }

  // ---- 3. 合法性冲突（取值域与人群-章节确定性规则）----
  const method = parsed.discharge_method;
  if (method.name_cn != null && method.value == null) {
    legalityConflicts.push(
      finding("DISCHARGE_METHOD_ILLEGAL", "HIGH", `离院方式取值无法映射到合法值域（1/2/3/4/5/9）：原文「${method.name_cn}」`, {
        section: "离院方式",
        span: method.span,
        expected: [...VALID_DISCHARGE_METHODS].join("/"),
        actual: method.name_cn,
      }),
    );
  } else if (method.value != null && !VALID_DISCHARGE_METHODS.has(method.value)) {
    legalityConflicts.push(
      finding("DISCHARGE_METHOD_ILLEGAL", "HIGH", `离院方式取值 ${method.value} 不在合法值域（1/2/3/4/5/9）`, {
        section: "离院方式",
        span: method.span,
        expected: [...VALID_DISCHARGE_METHODS].join("/"),
        actual: method.value,
      }),
    );
  }
  if (method.value === 5 && !/死亡记录|死亡讨论|抢救记录|临床死亡|宣布死亡|死亡时间|死亡原因/.test(text)) {
    legalityConflicts.push(
      finding("DEATH_METHOD_WITHOUT_DEATH_RECORD", "HIGH", "离院方式为死亡（5），但病历文本未见死亡记录/死亡讨论等实质性死亡文书记载，须病案复核", {
        section: "离院方式",
        span: method.span,
        expected: "死亡记录/死亡讨论/抢救记录等实质性记载",
        actual: null,
      }),
    );
  }

  const sex = parsed.demographics?.sex;
  const age = parsed.demographics?.age;
  const terms = dxTerms(parsed);
  const termsText = allDxText(parsed);
  const dxCodes = diagnosisCodes.filter((c) => (c.kind ?? "diagnosis") === "diagnosis").map((c) => c.code);
  const hasObstetric = /O/.test(dxCodes.map((c) => c.charAt(0).toUpperCase()).join("")) || OBSTETRIC_TERM_RE.test(termsText);
  const hasNeonatal = /P/.test(dxCodes.map((c) => c.charAt(0).toUpperCase()).join("")) || NEONATAL_TERM_RE.test(termsText);

  if (sex === "male" && hasObstetric) {
    legalityConflicts.push(
      finding("OBSTETRIC_DIAGNOSIS_SEX_CONFLICT", "HIGH", "男性患者出现妊娠/分娩/产褥期（O 章节）相关诊断，人群-章节冲突，须病案复核主诊断选择", {
        section: "诊断",
        span: termsText.slice(0, 60),
        expected: "O 章节诊断仅适用于女性患者",
        actual: `sex=male, dx=${termsText.slice(0, 40)}`,
      }),
    );
  }
  if (age != null && age >= 1 && hasNeonatal) {
    legalityConflicts.push(
      finding("NEONATAL_DIAGNOSIS_AGE_CONFLICT", "HIGH", `患者年龄 ${age} 岁与围产期/新生儿（P 章节）诊断冲突，须病案复核年龄或诊断归属`, {
        section: "诊断",
        span: termsText.slice(0, 60),
        expected: "P 章节诊断仅适用于围产儿/新生儿（<28 天）",
        actual: `age=${age}岁, dx=${termsText.slice(0, 40)}`,
      }),
    );
  }

  // ---- 4. 提示级复核建议（不构成判定）----
  const primary = parsed.discharge_diagnosis_primary?.value ?? "";
  if (primary && /待查|疑似|待排/.test(primary)) {
    advisoryHints.push(
      finding("UNCERTAIN_PRIMARY_DIAGNOSIS", "LOW", "出院主诊断仍为疑似/待查表述，按结算规范不得按疑似编码，须明确最终主诊断或按确定症状编码", {
        section: "诊断",
        span: primary,
      }),
    );
  } else if (!primary) {
    // 解析器会把疑似/待查条目从诊断中过滤掉；从原始诊断章节回查，区分“未书写”与“书写了疑似/待查”
    const sec = splitSections(text);
    const rawDx = sec["出院诊断"] || sec["出院主诊断"] || sec["术后诊断"] || sec["门诊诊断"] || sec["初步诊断"] || sec["诊断"] || "";
    if (rawDx && /待查|疑似|待排/.test(rawDx)) {
      advisoryHints.push(
        finding("UNCERTAIN_PRIMARY_DIAGNOSIS", "LOW", "诊断章节为疑似/待查表述，按结算规范不得按疑似编码，须明确最终主诊断或按确定症状编码", {
          section: "诊断",
          span: rawDx.replace(/\s+/g, " ").slice(0, 60),
        }),
      );
    }
  }
  if (TUMOR_TERM_RE.test(termsText) && !parsed.pathology?.value) {
    advisoryHints.push(
      finding("TUMOR_PATHOLOGY_HINT", "LOW", "诊断含肿瘤性病变但未见病理诊断记载，肿瘤类诊断须病理形态学支持，须病案复核", {
        section: "病理",
        expected: "病理诊断/形态学记录",
        actual: null,
      }),
    );
  }
  if (TRAUMA_TERM_RE.test(termsText) && !/外部原因|致伤原因|损伤外部原因/.test(text)) {
    advisoryHints.push(
      finding("EXTERNAL_CAUSE_HINT", "LOW", "诊断含损伤/中毒但未见损伤外部原因记载，病案首页与结算清单要求补充外部原因（V/W/X/Y 编码对应记载）", {
        section: "诊断",
        expected: "损伤外部原因记载",
        actual: null,
      }),
    );
  }
  if (parsed.procedures?.value && dxTerms(parsed).length === 0 && procTerms(parsed).length > 0) {
    elementGaps.push(
      finding("PROCEDURE_WITHOUT_SUPPORTING_DIAGNOSIS", "MEDIUM", "有手术操作记载但无任何诊断记载，手术操作缺乏诊断支持", {
        section: "手术",
        span: parsed.procedures.span,
      }),
    );
  }

  const conflictCount = legalityConflicts.length + algebraConflicts.length;
  const highGapCount = elementGaps.filter((g) => g.severity === "HIGH").length;
  let checkStatus;
  if (conflictCount > 0 || highGapCount > 0) checkStatus = "action_needed";
  else if (elementGaps.length > 0 || advisoryHints.length > 0) checkStatus = "incomplete";
  else checkStatus = "pass";

  return {
    schema_version: "medcius.nhsa-record-quality-report.v1",
    check_status: checkStatus,
    summary: {
      element_gap_count: elementGaps.length,
      algebra_conflict_count: algebraConflicts.length,
      legality_conflict_count: legalityConflicts.length,
      advisory_hint_count: advisoryHints.length,
      rule_pack: "nhsa-record-quality v1（国卫办医发〔2016〕24 号 + 医保结算清单填写规范确定性子集）",
    },
    element_gaps: elementGaps,
    algebra_conflicts: algebraConflicts,
    legality_conflicts: legalityConflicts,
    advisory_hints: advisoryHints,
    parsed_context: {
      note_type: parsed.note_type,
      sex: sex ?? null,
      age: age ?? null,
      admission_date: dates.admission_date?.value ?? null,
      discharge_date: dates.discharge_date?.value ?? null,
      recorded_stay_days: dates.recorded_stay_days?.value ?? null,
      computed_stay_days: dates.computed_stay_days,
      discharge_method: method.value ?? null,
      fee_total: fees.total?.value ?? null,
      fee_sum: fees.sum,
      diagnosis_code_count: dxCodes.length,
    },
    boundary: {
      is_drg_dip_grouper: false,
      outputs_coding_suggestions: false,
      adjudicates_reimbursement: false,
      affects_clinical_care: false,
      note: "本引擎只输出要素缺口、代数不一致与确定性合法性冲突，供病案/编码/医保办人员复核；不修改编码、不做 DRG/DIP 入组、不判定医保违规、不计算报销金额。编码与结算以医院当期分组器、经办规则与官方编码库为准。",
    },
    disclaimer: "数据质量核对 ≠ 病案终审；“pass”仅表示当前输入范围内未发现确定性缺口，不代表清单整体合格。",
  };
}

/** 供宿主/测试直接引用合法值域与名称表。 */
export { VALID_DISCHARGE_METHODS, DISCHARGE_METHOD_NAMES };
export default buildRecordQualityReport;
