/**
 * Deterministic parser for templated Chinese clinical notes.
 * Covers 出院/门诊/入院/手术/病程/护理. Does not diagnose.
 */

const UNCERTAIN = /疑似|待查|排除|拟诊|待排/;
const FAMILY = /母亲|父亲|父母|兄|弟|姐|妹|家族/;
const DENY_ALLERGY = /否认.{0,12}过敏/;
// 手术栏以“无/未”开头即未实施；允许扫描伪影跟在后面（页码/水印/分隔线）。
const NONE_PROC = /^(无|无手术|未见|未实施)(?![a-zA-Z\u4e00-\u9fa5])/;

const HEADING_NAMES =
  "入院诊断|出院诊断|出院主诊断|门诊诊断|初步诊断|术前诊断|术中诊断|术后诊断|诊断|手术及操作|手术操作|手术名称|过敏史|体格检查|既往史|家族史|主诉|现病史|诊疗经过|手术经过|病程记录|护理记录|辅助检查|检验结果|出院医嘱|处理|病理诊断|病理检查|病理|费用明细|费用结算|医疗收费";

const HEADING_RE = new RegExp(`^(?:${HEADING_NAMES})\\s*[：:]`, "m");

// 非标标题 → 规范标题（真实导出/粘贴病历最常见的方言；确定性归一，不做任何推断）。
const SECTION_ALIASES = {
  出院时诊断: "出院诊断",
  "诊断（出院）": "出院诊断",
  入院时诊断: "入院诊断",
  药物过敏史: "过敏史",
  查体: "体格检查",
  PE: "体格检查",
  出院处理: "出院医嘱",
  手术及操作名称: "手术及操作",
  手术操作名称: "手术操作",
  "手术/操作": "手术及操作",
};

const ALIAS_HEADINGS_RE = new RegExp(
  `^(?:${Object.keys(SECTION_ALIASES).map((alias) => alias.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})\\s*[：:]`,
  "m",
);

/**
 * Normalize structural dialects BEFORE section splitting:
 *   1. 【标题】 bracket headings → 标题：
 *   2. mid-line headings (merged by lost newlines / full-width spaces) → line start
 * Deterministic, text-level only.
 */
export function normalizeNoteStructure(text) {
  let src = String(text ?? "").replace(/\r\n/g, "\n");
  src = src.replace(new RegExp(`^【(${HEADING_NAMES})】\\s*[：:]?`, "gm"), "$1：");
  src = src.replace(new RegExp(`^【(${Object.keys(SECTION_ALIASES).join("|")})】\\s*[：:]?`, "gm"), "$1：");
  src = src.replace(
    new RegExp(`([ \\t　\\u3000])((?:${HEADING_NAMES}|${Object.keys(SECTION_ALIASES).join("|")})\\s*[：:])`, "g"),
    "\n$2",
  );
  return src;
}

/** @param {string} text */
export function splitSections(text) {
  const src = normalizeNoteStructure(text);
  const out = {};
  const re = new RegExp(HEADING_RE.source, "gm");
  const aliasRe = new RegExp(ALIAS_HEADINGS_RE.source, "gm");
  const hits = [];
  let m;
  while ((m = re.exec(src))) hits.push({ name: m[0].replace(/[：:\s]+$/, ""), start: m.index, headEnd: m.index + m[0].length });
  while ((m = aliasRe.exec(src))) {
    const name = SECTION_ALIASES[m[0].replace(/[：:\s]+$/, "")];
    if (name) hits.push({ name, start: m.index, headEnd: m.index + m[0].length });
  }
  hits.sort((a, b) => a.start - b.start);
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : src.length;
    out[hits[i].name] = src.slice(hits[i].headEnd, end).trim();
  }
  return out;
}

export function detectNoteType(text) {
  const t = String(text ?? "");
  if (/出院记录|出院诊断/.test(t)) return "discharge";
  if (/门诊病历|门诊诊断/.test(t)) return "outpatient";
  if (/手术记录|手术名称|手术经过/.test(t)) return "operative";
  if (/护理记录/.test(t)) return "nursing";
  if (/病程记录/.test(t)) return "progress";
  if (/入院记录/.test(t)) return "admission";
  return "unknown";
}

export function parseDemographics(text) {
  const t = String(text ?? "");
  const sexC = /性别[：:]\s*([男女])/.exec(t)?.[1] ?? null;
  const ageN = /年龄[：:]\s*(\d+)\s*岁/.exec(t)?.[1];
  return {
    sex: sexC === "男" ? "male" : sexC === "女" ? "female" : null,
    sex_cn: sexC,
    age: ageN ? Number(ageN) : null,
  };
}

export function parseLabs(text) {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const labs = [];
  const push = (name, value, unit, span) => labs.push({ name, value, unit, span });
  const scr = /(?:血肌酐|肌酐|Scr)\s*[：:为]?\s*(\d+(?:\.\d+)?)\s*(μmol\s*\/\s*L|umol\s*\/\s*L|µmol\s*\/\s*L)?/i.exec(t);
  if (scr) push("肌酐", Number(scr[1]), scr[2] ? "umol_L" : "umol_L", scr[0]);
  const alt = /(?:ALT|谷丙转氨酶|丙氨酸氨基转移酶)\s*[：:为]?\s*(\d+(?:\.\d+)?)/i.exec(t);
  if (alt) push("ALT", Number(alt[1]), "U/L", alt[0]);
  const ast = /(?:AST|谷草转氨酶|天冬氨酸氨基转移酶)\s*[：:为]?\s*(\d+(?:\.\d+)?)/i.exec(t);
  if (ast) push("AST", Number(ast[1]), "U/L", ast[0]);
  return labs;
}

/** @param {string} raw e.g. 2024-08-03 | 2024/8/3 | 2024年8月3日 */
export function parseCnDate(raw) {
  const s = String(raw ?? "").trim();
  const m = /^(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (Number.isNaN(new Date(iso).getTime())) return null;
  return iso;
}

/** 入院/出院日期与住院天数（病案首页与结算清单共用要素）。 */
export function parseEncounterDates(text) {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const grab = (label) => {
    const m = new RegExp(`${label}[：:]?\\s*(\\d{4}\\s*[-/年.]\\s*\\d{1,2}\\s*[-/月.]\\s*\\d{1,2}\\s*日?)`).exec(t);
    if (!m) return null;
    const iso = parseCnDate(m[1].replace(/\s+/g, ""));
    return iso ? { value: iso, span: m[1] } : null;
  };
  const admission = grab("入院日期") ?? grab("入院时间");
  const discharge = grab("出院日期") ?? grab("出院时间");
  const daysM = /住院天数[：:]?\s*(\d+)\s*天?/.exec(t);
  const recorded = daysM ? { value: Number(daysM[1]), span: daysM[0] } : null;
  let computed = null;
  if (admission && discharge) {
    const diff = (new Date(discharge.value) - new Date(admission.value)) / 86400000;
    if (Number.isFinite(diff)) computed = Math.round(diff) + 1;
  }
  return {
    admission_date: admission,
    discharge_date: discharge,
    recorded_stay_days: recorded,
    computed_stay_days: computed,
  };
}

/** 离院方式（1 医嘱离院 / 2 医嘱转院 / 3 医嘱转社区卫生或乡镇卫生院 / 4 非医嘱离院 / 5 死亡 / 9 其他）。 */
export const DISCHARGE_METHOD_NAMES = {
  1: "医嘱离院",
  2: "医嘱转院",
  3: "医嘱转社区卫生服务机构或乡镇卫生院",
  4: "非医嘱离院",
  5: "死亡",
  9: "其他",
};

export function parseDischargeMethod(text) {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const m = /离院方式[：:]?\s*(?:([1-9])\s*(?:[-—~至到]?\s*[^，。;；\s]{0,12})?|([^\d，。;；\s]{2,16}))/.exec(t);
  if (!m) return { value: null, name_cn: null, span: null, null_reason: "not_mentioned" };
  const span = m[0].trim();
  if (m[1]) {
    const code = Number(m[1]);
    return { value: code, name_cn: DISCHARGE_METHOD_NAMES[code] ?? null, span };
  }
  const name = m[2].trim();
  // 最长名称优先，避免“医嘱转院”被“医嘱”前缀误匹配为“医嘱离院”
  const entries = Object.entries(DISCHARGE_METHOD_NAMES).sort((a, b) => b[1].length - a[1].length);
  const byName = entries.find(([, n]) => name === n || name.includes(n) || n.includes(name));
  return { value: byName ? Number(byName[0]) : null, name_cn: name, span };
}

const FEE_ITEM_RE =
  /(床位费|护理费|诊查费|挂号费|检查费|检验费|化验费|治疗费|手术费|麻醉费|药品费|西药费|中成药费|中草药费|材料费|血费|氧气费|膳食费|其他费用)[：:为]?\s*([\d,，.]+)\s*元/g;

/** 病案费用信息：总额 + 分类费用（结算清单收费信息栏的确定性输入）。 */
export function parseFees(text) {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const totalM = /(?:总费用|费用总额|合计费用)[：:为]?\s*([\d,，.]+)\s*元?/.exec(t);
  const total = totalM
    ? { value: Number(totalM[1].replace(/[，,]/g, "")), span: totalM[0] }
    : null;
  const seen = new Set();
  const items = [];
  let m;
  FEE_ITEM_RE.lastIndex = 0;
  while ((m = FEE_ITEM_RE.exec(t))) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({ name, value: Number(m[2].replace(/[，,]/g, "")), span: m[0] });
  }
  const sum = items.length ? Number(items.reduce((a, i) => a + (Number.isFinite(i.value) ? i.value : 0), 0).toFixed(2)) : null;
  return { total, items, sum };
}

function clip(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function itemsFromDxBlock(block) {
  const raw = String(block ?? "").trim();
  if (!raw) return [];
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    const num = line.match(/^\d+\s*[\.、．]\s*(.+)$/);
    if (num) items.push(clip(num[1]));
    else {
      for (const part of line.split(/[；;]/)) {
        const p = clip(part);
        if (p) items.push(p);
      }
    }
  }
  return items;
}

/**
 * Extract ConText 3-Axis Assertions (Presence, Temporality, Experiencer)
 * @param {string} sentence
 */
export function extractConTextAssertion(sentence = "") {
  const s = String(sentence || "").trim();

  // Axis 1: Presence (存在性状态: 阳性/现症, 阴性/否定, 疑似/无法判断, 未评估, 未提及)
  let presence = "positive";
  if (/未查|未行|未做|未予评估|未行体检|未及|未测|未见检查|未做检查/.test(s)) {
    presence = "not_evaluated";
  } else if (/否认|无|未见|未触及|未闻及|未诉|未出现|未发生|无明显|未有|阴性/.test(s)) {
    presence = "negative";
  } else if (/疑似|待查|待排|可能|拟诊|不除外|不排除|考虑|倾向/.test(s)) {
    presence = "uncertain";
  }

  // Axis 2: Temporality (时态维度: 当前/现症, 既往史, 假设/预警)
  let temporality = "current";
  if (/既往|既往史|曾于|年前|月前|既往有|既往曾|既往因|既往诊断|既往行/.test(s)) {
    temporality = "historical";
  } else if (/若出现|如发生|必要时|随访|预警|如果|一旦|警惕/.test(s)) {
    temporality = "hypothetical";
  }

  // Axis 3: Experiencer (经历者维度: 患者本人, 家属/家族史, 他人)
  let experiencer = "patient";
  if (/母亲|父亲|父母|家族|家族史|兄|弟|姐|妹|爷爷|奶奶|外公|外婆|同胞|同室/.test(s)) {
    experiencer = "family_member";
  }

  let presence_label = "【阳性/现症】";
  if (presence === "negative") presence_label = "【阴性/否定】";
  else if (presence === "not_evaluated") presence_label = "【未评估】";
  else if (presence === "uncertain") presence_label = "【疑似/待查】";

  return {
    presence,
    temporality,
    experiencer,
    presence_label,
  };
}

function field(value, span, extra = {}) {
  if (value == null || value === "") {
    return { value: null, span: null, location: extra.location ?? null, null_reason: extra.null_reason ?? "not_mentioned" };
  }
  return {
    value,
    span: span || value,
    location: extra.location ?? null,
    presence: extra.presence ?? "present",
    temporality: extra.temporality ?? "current",
    experiencer: extra.experiencer ?? "patient",
  };
}

function firstDxSection(sec) {
  return sec["出院诊断"] || sec["出院主诊断"] || sec["术后诊断"] || sec["门诊诊断"] || sec["初步诊断"] || sec["诊断"] || "";
}

function procSection(sec) {
  return sec["手术及操作"] || sec["手术操作"] || sec["手术名称"] || "";
}

/** @param {string} text */
export function parseCnNote(text) {
  const src = String(text ?? "");
  const sec = splitSections(src);
  const note_type = detectNoteType(src);

  const admItems = itemsFromDxBlock(sec["入院诊断"] || (note_type === "admission" ? sec["初步诊断"] : "") || "");
  const admConfirmed = admItems.filter((x) => !UNCERTAIN.test(x));
  const admission_diagnosis = admConfirmed.length
    ? field(admConfirmed.join("；"), admConfirmed[0], { location: "入院诊断" })
    : field(null, null, { location: "入院诊断", null_reason: admItems.length ? "mentioned_unclear" : "not_mentioned" });

  const dcItems = itemsFromDxBlock(firstDxSection(sec)).filter((x) => !UNCERTAIN.test(x));
  const discharge_diagnosis_primary = dcItems[0]
    ? field(dcItems[0], dcItems[0], { location: "诊断" })
    : field(null, null, { location: "诊断" });
  const others = dcItems.slice(1);
  const discharge_diagnosis_other = others.length
    ? field(others.join("；"), others[0], { location: "诊断" })
    : field(null, null, { location: "诊断" });

  const procBlock = clip(procSection(sec));
  let procedures;
  if (!procBlock || NONE_PROC.test(procBlock)) {
    procedures = field(null, null, { location: "手术" });
  } else {
    const procVal = procBlock.replace(/[。.\s]+$/, "");
    procedures = field(procVal, procVal, { location: "手术", temporality: "current" });
  }

  const allgPatient = String(sec["过敏史"] ?? "")
    .split(/[。；;\n]/)
    .map(clip)
    .filter(Boolean)
    .filter((s) => !FAMILY.test(s));
  const denyLine = allgPatient.find((s) => DENY_ALLERGY.test(s));
  let allergy_history;
  if (denyLine) allergy_history = field(denyLine, denyLine, { location: "过敏史", presence: "absent" });
  else if (allgPatient.length) allergy_history = field(allgPatient.join("；"), allgPatient[0], { location: "过敏史", presence: "present" });
  else allergy_history = field(null, null, { location: "过敏史" });

  const exam = clip(sec["体格检查"] ?? "");
  const physical_exam = exam ? field(exam, exam.slice(0, 120), { location: "体格检查" }) : field(null, null, { location: "体格检查" });

  const patho = clip(sec["病理诊断"] || sec["病理检查"] || sec["病理"] || "");
  const pathology = patho ? field(patho, patho.slice(0, 120), { location: "病理" }) : field(null, null, { location: "病理" });

  const instr = clip(sec["出院医嘱"] || sec["处理"] || "");
  const discharge_instructions = instr ? field(instr, instr.slice(0, 160), { location: "出院医嘱" }) : field(null, null, { location: "出院医嘱" });

  const encounter_dates = parseEncounterDates(src);
  const discharge_method = parseDischargeMethod(src);
  const fees = parseFees(src);

  return {
    note_type,
    demographics: parseDemographics(src),
    labs: parseLabs(src),
    encounter_dates,
    discharge_method,
    fees,
    admission_diagnosis,
    discharge_diagnosis_primary,
    discharge_diagnosis_other,
    procedures,
    allergy_history,
    physical_exam,
    pathology,
    discharge_instructions,
    _parser: "parse-cn-note",
  };
}
