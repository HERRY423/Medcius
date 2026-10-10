import { requiresRecordReconciliation } from "./record-lifecycle.mjs";
// Documentation reconciliation only. Clinical discharge suitability is never assessed here.
import { createPatientSourceSnapshot, assertPatientSourceSnapshot } from "./patient-source-snapshot.mjs";
import { readDischargeDocuments } from "./discharge-source-documents.mjs";
import { getSourceRecordFollowupState } from "./high-risk-followup-tracker.mjs";
import { buildPatientAffordabilityContext } from "./patient-affordability-context.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { assertDischargeConsistency, detachedFrozenOutput } from "./output-consistency.mjs";

const present = value => typeof value === "string" && value.trim().length > 0;
const name = r => r.drug_name || r.test_name || r.study_name || r.title || "名称未提供";
const hash = value => sha256Hex(canonicalJson(value));
const refMatches = (ref, item) => ref?.source_id === item.evidence.source_id && ref?.content_sha256 === item.evidence.content_sha256;
const statusLabels = { unknown: "输入范围或资料未知", gaps_present: "存在资料待核对项", fields_present_in_supplied_records: "所提供记录的核对字段已具备" };

export class DischargeReadinessEngine {
  static createSnapshot(params) { return createPatientSourceSnapshot(params); }

  static evaluateDischargeReadiness({ snapshot, inpatientMedications = [], dischargeMedications = [], medicationTransitions = [],
    followUpPlans = [], patientInstructions = [], financialAccessRecords = [], ...input }) {
    snapshot = snapshot ? assertPatientSourceSnapshot(snapshot) : createPatientSourceSnapshot({ ...input, medications: inpatientMedications });
    const encounterClass = typeof snapshot.encounter.class === "object" ? snapshot.encounter.class.code : snapshot.encounter.class;
    if (encounterClass !== "IMP" || snapshot.encounter.status !== "in-progress") throw new Error("FAIL_CLOSED: Active inpatient encounter required for discharge preparation");
    const documentSets = Object.fromEntries(Object.entries({ dischargeMedications, medicationTransitions, followUpPlans, patientInstructions, financialAccessRecords })
      .map(([kind, records]) => [kind, readDischargeDocuments(records, { context: snapshot.context, asOf: snapshot.as_of, kind })]));
    const docs = kind => documentSets[kind].current;
    const sources = kind => (snapshot.records[kind] || []).filter(e => e.eligible);
    const findings = [];
    const add = (domain, code, message, evidence = []) => findings.push({ domain, code, message, evidence });
    for (const [kind, set] of Object.entries(documentSets)) for (const entry of set.excluded) {
      if (entry.reason !== "superseded") add(kind === "financialAccessRecords" ? "access" : kind === "dischargeMedications" || kind === "medicationTransitions" ? "medications" : "follow_up",
        "DOCUMENT_EXCLUDED", `来源资料 ${entry.source_id ?? "标识缺失"} 未进入当前核对：${entry.reason}`);
    }
    for (const entry of snapshot.excluded) if (entry.reason !== "superseded") add("source", "SOURCE_RECORD_EXCLUDED", `来源记录未进入当前核对：${entry.reason}`, [entry.evidence]);
    if (!snapshot.source_availability.length) add("source", "SOURCE_COVERAGE_UNKNOWN", "来源覆盖范围未提供；无法证明院内资料已全部纳入。");
    for (const source of snapshot.source_availability) if (!["available", "available_empty"].includes(source.status)) add("source", "SOURCE_UNAVAILABLE_OR_UNKNOWN", "存在不可用或完整性未知的来源，请回源核对。");

    // Result availability, recorded review, and follow-up ownership are separate facts.
    const resultItems = [...sources("observations"), ...sources("diagnosticReports")].map(entry => {
      const r = entry.record;
      const selected = entry.lifecycle.change_type === "revision" ? { ...r, result_status: "corrected" } : r;
      const state = getSourceRecordFollowupState(selected, { sourceType: entry.evidence.source_type === "observation" ? "observation" : "diagnostic_report", now: snapshot.as_of });
      const result = { title: name(r), record: r, evidence: entry.evidence, result_status: state.result_status,
        review_status: state.review_status, result_review_status: state.closure_status,
        clinical_tasks_completed: false, follow_up_plan_ids: [] };
      if (!["final", "revised"].includes(state.result_status)) add("results", requiresRecordReconciliation(state.result_status) ? "RESULT_RECONCILIATION_REQUIRED" : "RESULT_NOT_FINAL",
        `${name(r)}：${state.result_status}，不能视为最终结果已完成核对。`, [entry.evidence]);
      else if (state.review_status !== "acknowledged") add("results", "RESULT_REVIEW_UNCONFIRMED", `${name(r)}：已有结果，当前版本的来源复核记录尚未确认。`, [entry.evidence]);
      return result;
    });
    if (!resultItems.length) add("results", "RESULT_SCOPE_UNKNOWN", "当前输入无可核对的结果；不等于没有待回报或待复核结果。");
    const sourceOrders = sources("orders").map(entry => {
      const linked = resultItems.filter(result => [result.record.order_id, result.record.service_request_id, result.record.based_on_id].includes(entry.evidence.source_id));
      if (!linked.length && !requiresRecordReconciliation(entry.lifecycle.result_status)) add("results", "ORDER_RESULT_LINK_UNKNOWN", `${name(entry.record)}：来源未明确关联到结果；执行及是否需要结果仍待核对。`, [entry.evidence]);
      return { record: entry.record, evidence: entry.evidence, source_status: entry.lifecycle.result_status, linked_result_ids: linked.map(r => r.evidence.source_id) };
    });

    // Exact source links replace class/name-based guesses about therapeutic equivalence.
    const inpatient = sources("medications").filter(e => !requiresRecordReconciliation(e.lifecycle.result_status)).map(e => ({ record: e.record, evidence: e.evidence }));
    const discharge = docs("dischargeMedications");
    for (const med of discharge) {
      const missing = ["drug_name", "dosage", "route", "frequency", "duration_or_stop_rule"].filter(key => !present(med.record[key]));
      if (missing.length) add("medications", "DISCHARGE_MEDICATION_FIELDS_MISSING", `出院用药 ${name(med.record)} 缺少字段：${missing.join("、")}；不补造。`, [med.evidence]);
    }
    const transitions = docs("medicationTransitions").map(item => {
      const r = item.record, before = inpatient.find(m => refMatches(r.inpatient_ref, m)), after = discharge.find(m => refMatches(r.discharge_ref, m));
      const problems = [];
      if (!["continue", "change", "stop", "new"].includes(r.action)) problems.push("ACTION_UNKNOWN");
      if (!present(r.author_id)) problems.push("AUTHOR_MISSING");
      if (r.action !== "new" && !before) problems.push("INPATIENT_LINK_STALE_OR_MISSING");
      if (r.action === "new" && r.inpatient_ref != null) problems.push("NEW_ACTION_HAS_INPATIENT_LINK");
      if (r.action !== "stop" && !after) problems.push("DISCHARGE_LINK_STALE_OR_MISSING");
      if (r.action === "stop" && r.discharge_ref != null) problems.push("STOP_ACTION_HAS_DISCHARGE_LINK");
      if (["change", "stop", "new"].includes(r.action) && !present(r.rationale_text)) problems.push("RATIONALE_MISSING");
      const differences = before && after ? ["drug_name", "medication_code", "code_system", "dosage", "route", "frequency"].filter(key => (before.record[key] ?? null) !== (after.record[key] ?? null)) : [];
      if (r.action === "continue" && differences.length) problems.push("CONTINUE_FIELDS_DIFFER");
      if (problems.length) add("medications", "TRANSITION_REQUIRES_REVIEW", `用药衔接记录需核对：${problems.join("、")}`, [item.evidence, before?.evidence, after?.evidence].filter(Boolean));
      return { ...item, documentation_status: problems.length ? "gaps_present" : "fields_present_in_supplied_records", problems, differences,
        inpatient: before ?? null, discharge: after ?? null, clinical_appropriateness: "not_assessed" };
    });
    for (const [side, rows, key] of [["在院", inpatient, "inpatient_ref"], ["出院", discharge, "discharge_ref"]]) for (const med of rows) {
      const linked = transitions.filter(t => refMatches(t.record[key], med));
      if (linked.length !== 1) add("medications", linked.length ? "MULTIPLE_TRANSITION_RECORDS" : "TRANSITION_DOCUMENTATION_MISSING",
        `${side}用药 ${name(med.record)}：${linked.length ? "多条衔接记录相互需要核对" : "未见明确的继续、调整、停止或新增记录"}；不推断应当使用哪种治疗。`, [med.evidence]);
    }
    const byDrugCode = new Map();
    for (const med of discharge) {
      if (!present(med.record.medication_code) || !present(med.record.code_system)) continue;
      const key = `${med.record.code_system}:${med.record.medication_code}`;
      const prior = byDrugCode.get(key);
      if (prior) add("medications", "SAME_CODE_MULTIPLE_ENTRIES", "出院清单出现多个相同药品编码条目，需人工核对是否为有意安排。", [prior.evidence, med.evidence]);
      byDrugCode.set(key, med);
    }
    if (!inpatient.length || !discharge.length) add("medications", "MEDICATION_LIST_SCOPE_UNKNOWN", "在院或出院用药清单为空；不能据此推断无需用药或已完成用药核对。");

    // A note mentioning follow-up, especially a negated mention, is not an appointment.
    const plans = docs("followUpPlans").map(item => {
      const r = item.record, missing = ["purpose", "destination", "responsible_party", "contact_route", "author_id"].filter(key => !present(r[key]));
      if (!present(r.timing_text) && !present(r.scheduled_at)) missing.push("timing");
      if (r.scheduled_at != null && (typeof r.scheduled_at !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(r.scheduled_at) || !Number.isFinite(Date.parse(r.scheduled_at)) || Date.parse(r.scheduled_at) < Date.parse(snapshot.as_of))) missing.push("scheduled_time_invalid_or_past");
      if (!["planned", "requested", "booked"].includes(r.arrangement_status)) missing.push("arrangement_status");
      if (r.arrangement_status === "booked" && !present(r.appointment_reference)) missing.push("appointment_reference");
      const target = r.target_ref ? resultItems.find(result => refMatches(r.target_ref, result)) : null;
      if (r.target_ref && !target) missing.push("result_link_stale_or_missing");
      if (missing.length) add("follow_up", "FOLLOW_UP_FIELDS_MISSING", `后续安排缺少或无法核对：${missing.join("、")}`, [item.evidence]);
      if (target) target.follow_up_plan_ids.push(r.id);
      return { ...item, missing_fields: missing, documentation_status: missing.length ? "gaps_present" : "fields_present_in_supplied_records",
        appointment_verified: false, execution_status: "not_assessed" };
    });
    if (!plans.length) add("follow_up", "FOLLOW_UP_SCOPE_UNKNOWN", "未提供可溯源的后续安排；病历中出现“复查/随访”不等于已有预约。");
    for (const result of resultItems.filter(r => r.result_review_status !== "closed")) {
      const validPlans = plans.filter(p => refMatches(p.record.target_ref, result) && !p.missing_fields.length);
      if (!validPlans.length) add("follow_up", "RESULT_TRACKING_DETAILS_MISSING", `${result.title}：未见绑定当前结果版本、责任人、时间和联络途径的完整跟进资料。`, [result.evidence]);
    }
    const instructions = docs("patientInstructions");
    for (const item of instructions) if (!present(item.record.text) || !present(item.record.author_id)) add("follow_up", "PATIENT_INSTRUCTION_FIELDS_MISSING", "宣教/警示资料缺少原文或提供者。", [item.evidence]);
    if (!instructions.length) add("follow_up", "PATIENT_INSTRUCTIONS_NOT_PROVIDED", "未提供有来源的患者宣教或警示说明，不自动生成通用症状和复诊时限。");
    // Allergy strings without resource/time evidence cannot establish a documented negative.
    add("source", "ALLERGY_SOURCE_REVIEW_REQUIRED", "过敏史需核对有来源的原始记录；不把未提供转换为无已知过敏。");

    const financial = docs("financialAccessRecords").map(({ record }) => record.kind === "patient_cost_estimate" && record.status === "available"
      && Date.parse(record.valid_until) < Date.parse(snapshot.as_of) ? { ...record, status: "expired" } : record);
    const affordability = buildPatientAffordabilityContext({ records: financial, dischargeMedicationCount: discharge.length });
    const domain = (key, rows) => { const gaps = findings.filter(f => f.domain === key); return { status: !rows.length ? "unknown" : gaps.length ? "gaps_present" : "fields_present_in_supplied_records",
      status_label: statusLabels[!rows.length ? "unknown" : gaps.length ? "gaps_present" : "fields_present_in_supplied_records"], items: rows, findings: gaps }; };
    const result = { schema_version: "medcius.discharge-document-check.v2", patient: { id: snapshot.context.patient_id },
      snapshot_id: snapshot.snapshot_id, as_of: snapshot.as_of,
      document_snapshot_digest: hash(Object.fromEntries(Object.entries(documentSets).map(([key, set]) => [key, set.snapshot_digest]))),
      clinical_suitability: { assessed: false, is_suitable_for_discharge: null, decision_owner: "主管医师", note: "资料完整性核对不能判定临床上是否适合出院。" },
      readiness_verdict: { is_ready: null, deprecated: true, status_label: "仅资料核对；未评估是否适合出院" },
      documentation_summary: { status: "review_required", coverage: "not_established", findings_count: findings.length,
        label: "仅汇总输入范围内的资料与缺口，不给出可出院/不可出院结论" },
      domains: { results: { ...domain("results", resultItems), source_orders: sourceOrders }, medications: { ...domain("medications", transitions), inpatient, discharge }, follow_up: { ...domain("follow_up", plans), patient_instructions: instructions } },
      source_availability: snapshot.source_availability, source_visibility: snapshot.source_visibility, findings, patient_affordability: affordability,
      source_notes: sources("notes").map(e => ({ record: e.record, evidence: e.evidence })),
      excluded_records: { source: snapshot.excluded, documents: Object.fromEntries(Object.entries(documentSets).map(([key, set]) => [key, set.excluded])) },
      boundary: "只读资料核对；不生成处方、医疗建议、出院批准、电子签名或医院写回。" };
    result.packet_digest = hash(result);
    return detachedFrozenOutput(assertDischargeConsistency(result));
  }

  static generateDischargeChecklistText({ readinessResult: d }) {
    assertDischargeConsistency(d);
    const lines = ["【出院资料核对清单】", `资料截至：${d.as_of}`, d.clinical_suitability.note];
    for (const [key, label] of [["results", "一、结果资料"], ["medications", "二、用药衔接资料"], ["follow_up", "三、后续安排资料"]]) {
      lines.push(label, d.domains[key].status_label);
      for (const finding of d.domains[key].findings) lines.push(`• ${finding.message}`);
      for (const row of d.domains[key].items) {
        lines.push(`• ${row.title || row.record.purpose || row.record.action || "来源记录"} [来源 ${row.evidence.locator || row.evidence.source_reference?.resource_id}]`);
        if (key === "results") lines.push(`  结果状态：${row.result_status}；来源复核：${row.review_status}；内容：${row.record.impression ?? row.record.value ?? "未提供"}`);
        if (key === "medications") {
          for (const [side, med] of [["在院", row.inpatient], ["出院", row.discharge]]) lines.push(`  ${side}：${med ? [med.record.drug_name, med.record.dosage, med.record.route, med.record.frequency].map(v => v ?? "未提供").join(" / ") : "未提供或未绑定"}`);
          lines.push(`  来源原因：${row.record.rationale_text ?? "未提供"}；治疗合理性未评估。`);
        }
        if (key === "follow_up") lines.push(`  时间：${row.record.scheduled_at || row.record.timing_text || "未提供"}；去向：${row.record.destination ?? "未提供"}；责任人：${row.record.responsible_party ?? "未提供"}；联络：${row.record.contact_route ?? "未提供"}；来源安排状态：${row.record.arrangement_status ?? "未知"}（预约未外部核验）。`);
      }
    }
    for (const item of d.domains.follow_up.patient_instructions) lines.push(`来源患者说明：${item.record.text ?? "未提供"} [${item.evidence.source_reference.resource_id}]`);
    lines.push("四、费用与可获得性资料", `来源状态：${d.patient_affordability.assessment_status}；不能推断无经济障碍。`);
    for (const fact of d.patient_affordability.verified_facts.filter(f => f.kind === "patient_cost_estimate" && f.status === "available")) lines.push(`• 来源估算 ${fact.amount} ${fact.currency}，有效至 ${fact.valid_until}；非账单或待遇裁定。`);
    for (const finding of d.findings.filter(f => ["source", "access"].includes(f.domain))) lines.push(`• ${finding.message}`);
    lines.push(d.boundary);
    return lines.join("\n");
  }
}
