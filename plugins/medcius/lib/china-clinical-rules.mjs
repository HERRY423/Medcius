import { calculateChineseMdrd, classifyChineseAdultBmi, CHINA_CLINICAL_REFERENCE, CHINA_CALCULATION_PROVENANCE } from "./calculation-reference.mjs";
import { loadChinaSpecialtyRulePack } from "./specialty-rule-pack.mjs";
import { loadChinaPharmacyCatalog, resolveChinaPharmacyRecord, checkChinaMedicationSafety, buildChinaMedicationCoverage, specialAntimicrobialCandidate } from "./china-pharmacy-catalog.mjs";
import { requiresProductionPhi } from "./production-phi-policy.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";

const present = x => typeof x === "string" && x.trim().length > 0;
const recordKinds = new Set(["renal_assessment", "anthropometry", "disease_enrollment", "core_quality_scope", "quality_node", "vte_requirement", "vte_assessment", "perioperative_antibiotic", "medication", "antibiotic_administration", "microbiology", "antibiotic_authorization", "senior_round"]);
export const CHINA_CLINICAL_FIELDS = Object.freeze(("id kind patient_id encounter_id tenant_id source_reference status recorded_at "
  + "creatinine creatinine_unit stable_renal_function adult_ckd pregnant dialysis weight_kg height_cm pregnant_or_postpartum athlete "
  + "pack_id eligible criteria_version eligibility_source_id enrollment_id node_id performed not_applicable reason_code "
  + "population tool tool_version assessed_at last_clinical_change_at score factors_complete bleeding_risk_assessed prevention_decision_documented requirement_id "
  + "purpose route agent_class incision_at infusion_started_at infusion_completed_at anesthesia_started_at prophylaxis_stopped_at prophylaxis_ongoing incision_class cardiac_surgery extension_reviewed extension_source_id "
  + "drug_name approval_number manufacturer dosage_form spec antimicrobial tcm_injection diluents mixed_with_other_drugs therapy_horizon medication_id first_dose administered_at "
  + "specimen_collected test_type collected_at consent institution_authorized qualified_senior_expert prescriber_authorized consented_at emergency_override senior_qualification").split(" "));
const time = x => typeof x === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(x) && Number.isFinite(Date.parse(x)) ? Date.parse(x) : null;
const ref = row => ({ source_id: row.id, source_system: row.source_reference.source_system,
  resource_id: row.source_reference.resource_id, recorded_at: row.recorded_at, content_sha256: sha256Hex(canonicalJson(row)) });
const nodeState = node => node?.performed === true && node?.not_applicable !== true ? "documented"
  : node?.not_applicable === true && node?.performed !== true && present(node.reason_code) ? "exception_documented" : "unknown";

export function formatChinaClinicalCheck(check) {
  const state = ({ documented: "已找到来源记录，仍需临床核对", unknown: "资料不足", review_required: "需人工复核",
    exception_documented: "已记录不适用原因", pending: "待完成核查", not_applicable: "不适用本规则" })[check.status];
  const d = check.details;
  let detail = "";
  if (check.code === "CHINESE_MDRD" && d.status === "calculated") detail = `；估算 ${d.value} ${d.unit}（中国MDRD 175系数版本）`;
  if (check.code === "CHINESE_ADULT_BMI" && d.status === "calculated") detail = `；BMI ${d.value} kg/m²，${({ underweight: "体重过低", normal: "正常", overweight: "超重", obesity: "肥胖" })[d.category]}`;
  if (check.code === "ANTIMICROBIAL_GRADE" && d.grade) detail = `；目录分级：${({ non_restricted: "非限制使用级", restricted: "限制使用级", special: "特殊使用级" })[d.grade]}`;
  if (check.code === "PERIOP_FIRST_DOSE" && d.minutes_before_incision !== null) detail = `；切皮前 ${Math.round(d.minutes_before_incision)} 分钟开始输注，参考窗口 ${d.target_minutes.join("–")} 分钟`;
  if (check.code === "PERIOP_CLASS_I_DURATION" && d.hours !== null) detail = `；按首剂输注起算 ${Math.round(d.hours * 10) / 10} 小时，复核界值 ${d.limit_hours} 小时`;
  if (check.code === "ACTIVE_INGREDIENT_DUPLICATION") detail = `；重叠成分：${d.ingredients.map(x => x === "acetaminophen" ? "对乙酰氨基酚" : x).join("、")}，请药师核对累计暴露与风险`;
  if (check.code === "CHINA_LONG_TERM_MEDICATION_ACCESS") detail = `；医保${({ A: "甲类", B: "乙类", not_listed: "未列入目录" })[d.insurance_category] || "类别未核实"}；患者支付资格未裁定`;
  return `${check.title}：${state}${detail}`;
}

// Typed HIS facts only. Missing ownership, time or original source can never satisfy a node.
export function selectChinaClinicalRecords(records, context, asOf) {
  if (!Array.isArray(records)) throw new Error("CN_CLINICAL_RECORDS_ARRAY_REQUIRED");
  const accepted = [], excluded = [], counts = new Map();
  for (const row of records) counts.set(row?.id, (counts.get(row?.id) || 0) + 1);
  for (const row of records) {
    let reason = null;
    if (!recordKinds.has(row?.kind)) reason = "CLINICAL_RECORD_KIND_UNSUPPORTED";
    for (const field of ["patient_id", "encounter_id", "tenant_id"]) {
      if (row?.[field] && context?.[field] && row[field] !== context[field]) throw new Error("CN_CLINICAL_CONTEXT_MISMATCH");
      if (!present(row?.[field]) || !present(context?.[field])) reason = "EXPLICIT_OWNERSHIP_REQUIRED";
    }
    if (!present(row?.id) || !present(row?.kind) || !present(row?.source_reference?.source_system) || !present(row?.source_reference?.resource_id)) reason ||= "SOURCE_REFERENCE_REQUIRED";
    if (time(asOf) === null || time(row?.recorded_at) === null || time(row.recorded_at) > time(asOf)) reason ||= "SOURCE_TIME_INVALID_OR_FUTURE";
    if (!["final", "complete", "amended", "corrected"].includes(row?.status) && !(row?.kind === "medication" && row?.status === "active")) reason ||= "CURRENT_FINAL_RECORD_REQUIRED";
    if (counts.get(row?.id) !== 1) reason ||= "SOURCE_VERSION_CONFLICT";
    if (reason) excluded.push({ source_id: row?.id ?? null, reason }); else accepted.push(row);
  }
  return { accepted, excluded };
}

export function evaluateChinaClinicalRules({ records = [], patient = {}, context = {}, asOf,
  medications = [], pharmacyCatalog, region, renalInstabilityDetected = false } = {}) {
  const { accepted: rows, excluded } = selectChinaClinicalRecords(records, context, asOf);
  const checks = [];
  const add = (code, title, status, evidenceRows = [], details = {}, source = "single_disease") => checks.push({ code, title, status,
    evidence: evidenceRows.map(ref), details, rule_source: typeof source === "string" ? CHINA_CLINICAL_REFERENCE.sources[source] : source });
  for (const record of excluded) add("CLINICAL_RECORD_EXCLUDED", "本土规则来源资料未进入核查", "unknown", [], record);
  const one = kind => { const list = rows.filter(r => r.kind === kind); return list.length === 1 ? list[0] : null; };
  const renal = one("renal_assessment"), anthropometry = one("anthropometry");
  const mdrd = calculateChineseMdrd({ ...renal, age: patient.age, sex: ({ 男: "male", 女: "female" })[patient.gender] || patient.gender,
    stable_renal_function: renalInstabilityDetected ? false : renal?.stable_renal_function });
  const bmi = classifyChineseAdultBmi({ ...anthropometry, age: patient.age });
  if (rows.some(r => r.kind === "renal_assessment")) add("CHINESE_MDRD", "中国改良MDRD估算", mdrd.status === "calculated" ? "documented" : "unknown", renal ? [renal] : [], mdrd, "c_mdrd");
  if (rows.some(r => r.kind === "anthropometry")) add("CHINESE_ADULT_BMI", "中国成人BMI分级", bmi.status === "calculated" ? "documented" : "unknown", anthropometry ? [anthropometry] : [], bmi, "bmi");

  for (const review of rows.filter(r => r.kind === "core_quality_scope")) {
    const pack = loadChinaSpecialtyRulePack("cn-core-monitoring");
    for (const [code, title] of pack.nodes) {
      const matches = rows.filter(r => r.kind === "quality_node" && r.enrollment_id === review.id && r.node_id === code);
      const node = matches.length === 1 ? matches[0] : null;
      add(code, title, nodeState(node),
        [review, ...(node ? [node] : [])], { pack_id: pack.pack_id, official_indicator_rate: null }, "core_monitoring");
    }
  }

  for (const enrollment of rows.filter(r => r.kind === "disease_enrollment")) {
    let pack;
    try { pack = loadChinaSpecialtyRulePack(enrollment.pack_id); } catch { add("PACK_UNSUPPORTED", "专科规则包未收录", "unknown", [enrollment]); continue; }
    if (!["cn-stemi", "cn-heart-failure", "cn-pneumonia", "cn-cerebral-infarction"].includes(pack.pack_id)) {
      add("PACK_SCOPE_UNSUPPORTED", "本记录不适用单病种入组规则", "unknown", [enrollment]); continue;
    }
    if (enrollment.eligible !== true || enrollment.criteria_version !== "NHC-2020" || !present(enrollment.eligibility_source_id)
      || (pack.pack_id === "cn-pneumonia" && !(patient.age >= 18))) {
      add("DISEASE_ELIGIBILITY_UNKNOWN", "单病种入组条件未确认", "unknown", [enrollment], { pack_id: pack.pack_id, scope: pack.scope }); continue;
    }
    for (const [code, title] of pack.nodes) {
      const matches = rows.filter(r => r.kind === "quality_node" && r.enrollment_id === enrollment.id && r.node_id === code);
      const node = matches.length === 1 ? matches[0] : null;
      // 'documented' asserts that the record exists, never that the treatment is appropriate.
      const status = nodeState(node);
      add(code, title, status, [enrollment, ...(node ? [node] : [])], { pack_id: pack.pack_id, scope: pack.scope, conflict: matches.length > 1 });
    }
  }

  for (const required of rows.filter(r => r.kind === "vte_requirement")) {
    if (!rows.some(r => r.kind === "vte_assessment" && r.requirement_id === required.id)) add("VTE_ASSESSMENT_MISSING", "Padua/Caprini及出血风险评估未取得", "unknown", [required], {}, "vte");
  }
  for (const vte of rows.filter(r => r.kind === "vte_assessment")) {
    const expected = vte.population === "medical" ? "Padua" : vte.population === "surgical" ? "Caprini" : null;
    const applicable = patient.age >= 18 && expected && vte.tool === expected && present(vte.tool_version);
    const assessed = time(vte.assessed_at), changed = vte.last_clinical_change_at == null ? null : time(vte.last_clinical_change_at);
    const fresh = assessed !== null && assessed <= time(asOf) && (vte.last_clinical_change_at == null || (changed !== null && changed <= assessed));
    for (const [code, title, ok] of [
      ["VTE_SCALE", "Padua/Caprini适用量表、版本与风险评估", applicable && fresh && Number.isFinite(vte.score) && vte.score >= 0 && vte.factors_complete === true],
      ["VTE_BLEEDING", "出血风险评估记录", applicable && fresh && vte.bleeding_risk_assessed === true],
      ["VTE_PREVENTION", "预防决策或禁忌记录", applicable && fresh && vte.prevention_decision_documented === true],
      ["VTE_REASSESSMENT", "病情变化后再评估", applicable && fresh],
    ]) add(code, title, ok ? "documented" : "unknown", [vte], { expected_tool: expected, tool_version: vte.tool_version ?? null, automatic_score: false }, "vte");
  }

  for (const op of rows.filter(r => r.kind === "perioperative_antibiotic")) {
    if (op.purpose === "treatment") { add("PERIOP_TREATMENT_EXCLUDED", "治疗性用药不套用预防停药窗口", "not_applicable", [op], {}, "antimicrobial"); continue; }
    const incision = time(op.incision_at), start = time(op.infusion_started_at), end = time(op.infusion_completed_at), stopped = time(op.prophylaxis_stopped_at);
    const longInfusion = op.agent_class === "vancomycin" || op.agent_class === "fluoroquinolone";
    const valid = op.purpose === "prophylaxis" && op.route === "IV" && ["standard", "vancomycin", "fluoroquinolone"].includes(op.agent_class)
      && [incision, start, end].every(t => t !== null && t <= time(asOf)) && start <= end;
    const minutes = valid ? (incision - start) / 60000 : null;
    const window = longInfusion ? [60, 120] : [30, 60];
    const atAnesthesia = !longInfusion && time(op.anesthesia_started_at) !== null && start === time(op.anesthesia_started_at);
    const timing = valid && end <= incision && ((minutes >= window[0] && minutes <= window[1]) || atAnesthesia);
    add("PERIOP_FIRST_DOSE", "切皮前首剂实际给药及输注完成核查", !valid ? "unknown" : timing ? "documented" : "review_required", [op], { minutes_before_incision: minutes, target_minutes: window }, "antimicrobial");
    if (op.incision_class !== "I" || op.purpose !== "prophylaxis") {
      add("PERIOP_DURATION_SCOPE", "I类切口预防用药适用范围待核对", "unknown", [op], {}, "antimicrobial"); continue;
    }
    // The guideline does not define an electronic timestamp denominator. Report the explicit basis.
    const durationValid = start !== null && start <= time(asOf) && (stopped === null ? op.prophylaxis_ongoing === true && op.prophylaxis_stopped_at == null : op.prophylaxis_ongoing !== true && stopped >= start && stopped <= time(asOf));
    const hours = durationValid ? ((stopped ?? time(asOf)) - start) / 3600000 : null;
    const cardiacException = op.cardiac_surgery === true && op.extension_reviewed === true && present(op.extension_source_id);
    const limit = cardiacException ? 48 : 24;
    add("PERIOP_CLASS_I_DURATION", "I类切口预防用药24小时停药复核", !durationValid ? "unknown" : hours > limit ? "review_required" : stopped === null ? "pending" : "documented", [op],
      { hours, limit_hours: limit, basis: "first_prophylactic_infusion_to_stop_or_as_of", cardiac_exception_documented: cardiacException, automatic_stop_order: false }, "antimicrobial");
  }

  const meds = [...rows.filter(r => r.kind === "medication"), ...medications.filter(m => !rows.some(r => r.kind === "medication" && r.id === m.id))];
  if (meds.length) {
    const production = requiresProductionPhi(context);
    const catalog = pharmacyCatalog || loadChinaPharmacyCatalog({ production });
    const lookupContext = { as_of: asOf, region, hospital_id: context.tenant_id, production };
    for (const med of meds) {
      const grade = resolveChinaPharmacyRecord(catalog, "antimicrobial_grade", med, lookupContext);
      const candidate = specialAntimicrobialCandidate(med.drug_name || med.name);
      if (!grade.record && !candidate && med.antimicrobial !== true) continue;
      const medEvidence = rows.includes(med) ? [med] : [];
      add("ANTIMICROBIAL_GRADE", "省级/院内抗菌药物分级核对", grade.record ? "documented" : "unknown", medEvidence,
        { medication_id: med.id ?? null, grade: grade.record?.grade ?? null, grade_source: grade.record?.source ?? null, candidate_only: !grade.record && candidate }, "antimicrobial");
      if (grade.record ? grade.record.grade !== "special" : !candidate) continue;
      const administrations = rows.filter(r => r.kind === "antibiotic_administration" && r.medication_id === med.id && r.first_dose === true);
      const administered = administrations.length === 1 ? time(administrations[0].administered_at) : null;
      const linked = kind => rows.filter(r => r.kind === kind && r.medication_id === med.id);
      const culture = linked("microbiology").filter(r => r.specimen_collected === true && r.test_type === "culture" && time(r.collected_at) !== null && time(r.collected_at) <= time(asOf));
      const before = administered !== null && administered <= time(asOf) && culture.some(r => time(r.collected_at) <= administered);
      add("ANTIMICROBIAL_CULTURE", "治疗给药前微生物培养标本留取记录", before ? "documented" : "unknown", [...medEvidence, ...administrations, ...culture],
        { medication_id: med.id, ordered_test_is_not_collection: true, institution_rate: null }, "antimicrobial");
      const consultation = linked("antibiotic_authorization");
      const approved = consultation.length === 1 && consultation[0].consent === true && consultation[0].institution_authorized === true
        && consultation[0].qualified_senior_expert === true && consultation[0].prescriber_authorized === true
        && administered !== null && administered <= time(asOf) && time(consultation[0].consented_at) !== null && time(consultation[0].consented_at) <= administered;
      add("SPECIAL_ANTIBIOTIC_AUTHORIZATION", "特殊使用级授权会诊及处方权限记录", approved ? "documented" : "unknown", [...medEvidence, ...consultation],
        { medication_id: med.id, emergency_requires_review: consultation.some(r => r.emergency_override === true), senior_round_is_not_consent: true }, "antimicrobial");
      const rounds = linked("senior_round");
      add("SPECIAL_ANTIBIOTIC_SENIOR_ROUND", "高级职称医师查房记录", rounds.some(r => r.senior_qualification === true) ? "documented" : "unknown", rounds, { medication_id: med.id, replaces_authorized_consultation: false }, "antimicrobial");
    }
    for (const finding of checkChinaMedicationSafety({ medications: meds, catalog, context: lookupContext }).findings) {
      add(finding.code, "药品成分与中药注射剂配伍核查", finding.status, rows.filter(r => finding.medication_ids.includes(r.id)), finding, finding.source ?? finding.sources?.[0] ?? null);
    }
    for (const coverage of buildChinaMedicationCoverage({ medications: meds.filter(m => ["long_term", "discharge"].includes(m.therapy_horizon)), catalog, context: lookupContext })) {
      add("CHINA_LONG_TERM_MEDICATION_ACCESS", "长程/出院用药医保与可获得性核对", coverage.status === "unknown" ? "unknown" : "review_required",
        rows.filter(r => r.id === coverage.medication_id), coverage, "insurance");
    }
  }
  return { schema_version: "medcius.china-clinical-checks.v1", provenance: CHINA_CALCULATION_PROVENANCE,
    calculations: { chinese_mdrd: mdrd, china_adult_bmi: bmi }, checks, institutional_rates: null,
    boundary: "Source-bound documentation and reference checks only; no treatment orders, accreditation verdict or payer eligibility determination." };
}
