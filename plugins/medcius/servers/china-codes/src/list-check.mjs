import { db } from "./db.mjs";

const SEX_CN = { male: "男", female: "女" };

export function checkSettlementList({ sex, age, items }) {
  const rows = Array.isArray(items) ? items : [];
  const checks = [];
  const sexNorm = sex === "男" ? "male" : sex === "女" ? "female" : sex;

  for (const it of rows) {
    const reasons = [];
    const code = it.code;
    if (it.role === "discharge_primary" && it.is_main_diag_allowed === false) {
      reasons.push("不可作为主要诊断");
    }
    if (code) {
      let g = null;
      try {
        g = db.prepare("SELECT sex_required FROM gender_code_rules WHERE code=?").get(code);
      } catch {
        g = null;
      }
      if (g?.sex_required && sexNorm && g.sex_required !== sexNorm) {
        reasons.push(`性别限制：编码要求${g.sex_required === "male" ? "男" : "女"}，病历为${SEX_CN[sexNorm] ?? sexNorm}`);
      }
    }
    checks.push({
      term: it.term,
      role: it.role,
      code: code ?? null,
      ok: reasons.length === 0,
      reasons,
    });
  }

  const procs = rows.filter((r) => r.kind === "procedure" && r.term);
  const dx = rows.filter((r) => r.kind === "diagnosis" && r.term);
  const matchNotes = [];
  let hints = [];
  try {
    hints = db.prepare("SELECT procedure_substr, dx_substr FROM procedure_dx_hints").all();
  } catch {
    hints = [];
  }
  for (const p of procs) {
    const rules = hints.filter((h) => String(p.term).includes(h.procedure_substr));
    if (!rules.length) {
      matchNotes.push({ procedure: p.term, status: "no_rule", note: "无手术-诊断匹配规则，不判定失败" });
      continue;
    }
    const ok = rules.some((h) => dx.some((d) => String(d.term).includes(h.dx_substr)));
    matchNotes.push({
      procedure: p.term,
      status: ok ? "matched" : "unmatched",
      expected_dx_substrings: rules.map((r) => r.dx_substr),
      note: ok ? "手术与诊断关键词匹配" : "手术与列出诊断未匹配，须病案复核（不一定错）",
    });
  }

  return {
    sex: sexNorm ?? null,
    age: typeof age === "number" ? age : null,
    checks,
    procedure_dx_match: matchNotes,
    fail_count: checks.filter((c) => !c.ok).length,
    disclaimer: "清单机检（主诊断资格、性别限制、手术-诊断关键词）。不是 DRG 分组器。",
  };
}

export function searchProvincialBenefit({ province, insurance_type, encounter, include_samples }) {
  const allow = Boolean(include_samples);
  const sc = allow ? "" : "AND data_class!='sample'";
  const p = `%${province ?? ""}%`;
  const ins = insurance_type ? "AND insurance_type=?" : "";
  const enc = encounter ? "AND encounter=?" : "";
  const params = [p];
  if (insurance_type) params.push(insurance_type);
  if (encounter) params.push(encounter);
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT * FROM provincial_benefits WHERE province LIKE ? ${sc} ${ins} ${enc} ORDER BY id ASC LIMIT 20`,
    ).all(...params);
  } catch (e) {
    return { error: "provincial_benefits table missing", hint: String(e.message) };
  }
  return {
    query: { province, insurance_type, encounter },
    hits: rows.map((r) => ({
      province: r.province,
      insurance_type: r.insurance_type,
      encounter: r.encounter,
      deductible: r.deductible,
      reimburse_pct: r.reimburse_pct,
      chronic_outpatient: r.chronic_outpatient,
      data_class: r.data_class,
      source_version: r.source_version,
      effective_date: r.effective_date,
      disclaimer: r.disclaimer,
      layer: "L3",
      note: r.data_class === "sample" ? "样例待遇，禁止用于真实报销计算" : "省级待遇摘录；L4 个体资格仍须经办核实、不得给个人金额",
    })),
    coverage_note: "无命中则 L3 标待核，不得编造起付线/比例。L4 永不给个体数字。",
  };
}

const RESTRICTION_SPLIT_RE = /[、，,;；/／]|与|或|及|限|含|适用于/;

function restrictionKeywords(restrictionText) {
  return String(restrictionText ?? "")
    .split(RESTRICTION_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * 医保药品目录限定支付范围关键词提示（确定性包含关系，非结算判定）。
 * 状态口径（对齐 ARCH-08 覆盖诚实性）：
 *   - not_in_catalog_corpus  本地目录无此通用名，未命中不代表不在国家目录
 *   - no_restriction_recorded 目录收录但未记载限定支付范围
 *   - restriction_keyword_match   诊断表述与限定支付原文存在关键词包含关系
 *   - restriction_review_needed   未见包含关系，须经办/药师复核（不等于不能报销）
 */
export function checkCatalogRestriction({ drug_name, diagnosis_terms, include_samples }) {
  const terms = Array.isArray(diagnosis_terms)
    ? diagnosis_terms.map((t) => String(t ?? "").trim()).filter(Boolean)
    : [];
  if (!drug_name || !String(drug_name).trim()) {
    return { error: "drug_name required" };
  }
  if (!terms.length) {
    return { error: "diagnosis_terms required (non-empty array)" };
  }
  let rows = [];
  try {
    rows = db
      .prepare("SELECT * FROM nhsa_drug_catalog WHERE generic_name=? ORDER BY id ASC")
      .all(String(drug_name).trim());
    if (!rows.length) {
      rows = db
        .prepare("SELECT * FROM nhsa_drug_catalog WHERE generic_name LIKE ? ORDER BY length(generic_name) ASC LIMIT 1")
        .all(`%${String(drug_name).trim()}%`);
    }
  } catch (e) {
    return { error: "nhsa_drug_catalog table missing", hint: String(e.message) };
  }
  const allow = Boolean(include_samples);
  const eligible = rows.filter((r) => allow || r.data_class !== "sample");
  if (!eligible.length) {
    return {
      drug_name,
      diagnosis_terms: terms,
      status: "not_in_catalog_corpus",
      matched_terms: [],
      unmatched_terms: terms,
      coverage_note: "本地目录库覆盖有限；未命中不代表不在国家目录，以国家医保局发布为准。",
      disclaimer: "关键词提示 ≠ 医保结算判定；是否报销以经办机构核定为准。",
    };
  }
  const r = eligible[0];
  const restriction = r.payment_restriction ?? null;
  const src = db.prepare("SELECT name, url FROM sources WHERE id=?").get(r.source_id);
  const base = {
    drug_name: r.generic_name,
    category: r.category,
    code_system: "医保药品目录",
    code_version: r.source_version ?? "unknown",
    effective_date: r.effective_date ?? "unknown",
    retrieved_at: r.ingested_at,
    source: src?.name ?? "local china-codes",
    data_class: r.data_class,
    diagnosis_terms: terms,
  };
  if (!restriction) {
    return {
      ...base,
      status: "no_restriction_recorded",
      restriction_text: null,
      matched_terms: [],
      unmatched_terms: terms,
      coverage_note: "本地目录未记载限定支付范围原文，须对照官方目录原文复核；缺失不等于无限定。",
      disclaimer: "关键词提示 ≠ 医保结算判定；是否报销以经办机构核定为准。",
    };
  }
  const keywords = restrictionKeywords(restriction);
  const matched = terms.filter((t) => {
    if (restriction.includes(t)) return true;
    return keywords.some((k) => t.includes(k) || k.includes(t));
  });
  const unmatched = terms.filter((t) => !matched.includes(t));
  return {
    ...base,
    status: matched.length ? "restriction_keyword_match" : "restriction_review_needed",
    restriction_text: restriction,
    restriction_keywords: keywords,
    matched_terms: matched,
    unmatched_terms: unmatched,
    coverage_note: "限定支付范围关键词包含关系提示；关键词未命中不等于不适用（同义表述需人工复核），命中也不等于自动报销。",
    disclaimer: "关键词提示 ≠ 医保结算判定；是否报销以经办机构核定为准。",
  };
}
