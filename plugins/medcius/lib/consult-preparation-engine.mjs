import { createTextAnchor } from "./evidence-anchors.mjs";
import { requiresRecordReconciliation } from "./record-lifecycle.mjs";
// Read-only evidence retrieval; never generates a specialist opinion.
import { createConsultSnapshot, assertConsultSnapshot } from "./consult-snapshot.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { scanStructuredValue } from "../servers/phiguard/src/lib.mjs";
import { isExplicitCritical } from "./high-risk-followup-tracker.mjs";
import { assertConsultConsistency, detachedFrozenOutput } from "./output-consistency.mjs";

// Retrieval vocabulary, not diagnostic rules. Short Latin terms match whole tokens.
const profiles = [
  [/肾|透析/, ["肌酐", "scr", "尿素", "bun", "egfr", "血钾", "k+", "k", "钠", "na", "利尿", "水肿", "尿量", "肾", "ckd", "aki", "bnp", "nt-probnp"]],
  [/心|循环/, ["肌钙蛋白", "ctni", "ctnt", "bnp", "nt-probnp", "心电图", "超声心动", "胸闷", "胸痛", "心衰", "冠脉"]],
  [/呼吸|肺/, ["气促", "咳嗽", "痰", "胸片", "血气", "spo2", "氧分压", "哮喘", "慢阻肺", "肺"]],
  [/感染/, ["发热", "体温", "pct", "crp", "wbc", "培养", "药敏", "头孢", "美罗培南", "万古霉素"]],
  [/消化|内镜/, ["腹痛", "便血", "呕血", "胃镜", "肠镜", "胆红素", "转氨酶", "黑便", "腹胀"]],
  [/神经/, ["头晕", "意识", "偏瘫", "失语", "脑", "抽搐"]],
];
const vocabulary = [...new Set(profiles.flatMap(([, terms]) => terms))];
function match(text, term) {
  if (/^[a-z0-9+_-]+$/i.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").exec(text);
  }
  const index = text.toLowerCase().indexOf(term.toLowerCase());
  return index < 0 ? null : { index, 0: term };
}
const present = (value) => typeof value === "string" && value.trim().length > 0;
const label = (r) => r.test_name || r.study_name || r.drug_name || r.title || (typeof r.code === "string" ? r.code : r.code?.text) || "名称未提供";
const nursingFields = { temperature: ["体温", "℃"], systolic_bp: ["收缩压", "mmHg"], diastolic_bp: ["舒张压", "mmHg"],
  heart_rate: ["心率", "次/分"], spo2: ["SpO2", "%"], respiratory_rate: ["呼吸频率", "次/分"],
  intake_ml: ["入量", "ml"], output_ml: ["出量", "ml"], oral_intake_ml: ["口服入量", "ml"], iv_intake_ml: ["静脉入量", "ml"], urine_output_ml: ["尿量", "ml"], drain_output_ml: ["引流量", "ml"] };
const textOf = (r) => [label(r), r.text, r.impression, r.impression_text, r.findings,
  ...Object.entries(nursingFields).filter(([key]) => r[key] != null).map(([, [name]]) => name)].filter(Boolean).join(" ");
const stateLabels = { final: "最终报告", revised: "已更正", preliminary: "初步结果，待最终报告", cancelled: "已取消", entered_in_error: "录入错误", unknown: "状态未确认", ordered: "已开立，执行未确认", scheduled: "已安排", collected: "已采集" };

export class ConsultPreparationEngine {
  static createSnapshot(params) { return createConsultSnapshot(params); }

  static prepareConsultViews({ snapshot, consultRequests }) {
    assertConsultSnapshot(snapshot);
    if (!Array.isArray(consultRequests) || !consultRequests.length) throw new Error("FAIL_CLOSED: Missing consultation requests");
    return { snapshot_id: snapshot.snapshot_id, as_of: snapshot.as_of,
      views: consultRequests.map((consultRequest) => this.prepareConsultDossier({ snapshot, consultRequest })) };
  }

  static prepareConsultDossier({ snapshot, consultRequest = {}, ...input }) {
    if (!consultRequest || typeof consultRequest !== "object") throw new Error("FAIL_CLOSED: Invalid consultation request");
    if (!present(consultRequest.department)) throw new Error("FAIL_CLOSED: Missing target department");
    if (!present(consultRequest.purpose)) throw new Error("FAIL_CLOSED: Missing explicit consultation purpose");
    if (scanStructuredValue(consultRequest).total > 0) throw new Error("FAIL_CLOSED_PHI_VIOLATION: Consultation request requires PHI Guard");
    for (const field of ["question", "urgency", "requested_at"]) {
      if (consultRequest[field] != null && typeof consultRequest[field] !== "string") throw new Error("FAIL_CLOSED: Invalid consultation field");
    }
    if (consultRequest.focus_terms != null && (!Array.isArray(consultRequest.focus_terms) || consultRequest.focus_terms.length > 20 || consultRequest.focus_terms.some((term) => !present(term) || term.length > 80))) throw new Error("FAIL_CLOSED: Invalid focus terms");
    snapshot = snapshot ? assertConsultSnapshot(snapshot) : createConsultSnapshot(input);
    const profile = profiles.find(([pattern]) => pattern.test(consultRequest.department));
    const intent = [consultRequest.purpose, consultRequest.question].filter(Boolean).join(" ");
    const focus = [...new Set([...(consultRequest.focus_terms || []).map(term => term.trim()), ...vocabulary.filter((term) => match(intent, term))])];
    const specialty = profile?.[1] || [];
    const sections = { relevant_clinical_notes: [], targeted_labs_timeline: [], nursing_observations: [], relevant_imaging_reports: [],
      pending_specialty_reports: [], active_medications: [], medication_records_to_verify: [], record_status_changes: [], additional_records: [] };
    const gaps = [];
    const allergyKnown = snapshot.allergies != null && (!Array.isArray(snapshot.allergies) || snapshot.allergies.length > 0);
    if (!allergyKnown) gaps.push("ALLERGY_MISSING: 过敏史记录缺失；不等于无过敏");
    else gaps.push("ALLERGY_PROVENANCE_UNVERIFIED: 过敏史输入尚未绑定资源与时间，需回源核对，未作为已证实事实展示");
    if (!profile) gaps.push("SPECIALTY_PROFILE_MISSING: 无此专科检索模板，按诉求词检索并保留其他资料入口");
    if (!focus.length) gaps.push("FOCUS_UNMAPPED: 诉求尚未映射到检索词；请补充关注指标或资料词，当前仅按专科整理");
    if (!snapshot.source_availability.length) gaps.push("SOURCE_COVERAGE_UNKNOWN: 来源覆盖范围未提供");
    if (Object.values(snapshot.records).flat().some(entry => entry.evidence.ownership_basis === "feed_context")) {
      gaps.push("FEED_CONTEXT_ONLY: 部分记录仅绑定输入资料包上下文，记录级患者与就诊归属未独立核验");
    }
    for (const source of snapshot.source_availability) {
      if (source.status !== "available") gaps.push(`SOURCE_COVERAGE: ${source.source_type || source.kind || source.connector_id || "来源"}：${({ available_empty: "接口成功但返回为空", unavailable: "接口不可用", unknown: "完整性未知" })[source.status] || "状态未知"}`);
    }
    if (snapshot.excluded.length) gaps.push(`SOURCE_RECORDS_EXCLUDED: ${snapshot.excluded.length} 条非当前、冲突或缺少来源/时间的记录不进入当前事实`);
    for (const [kind, entries] of Object.entries(snapshot.records)) for (const entry of entries) {
      if (!entry.eligible) continue;
      const { record: r, lifecycle: state, evidence } = entry;
      const text = textOf(r);
      const purposeMatches = focus.filter((term) => match(text, term));
      const specialtyMatches = specialty.filter((term) => match(text, term));
      const critical = isExplicitCritical(r);
      const reason = purposeMatches.length ? "consult_question" : specialtyMatches.length ? "specialty_context" : critical ? "source_critical" : "other_source_record";
      const common = { title: label(r), evidence, result_status: state.result_status,
        status_label: stateLabels[state.result_status], relevance: { reason, matched_terms: purposeMatches.length ? purposeMatches : specialtyMatches },
        timestamp: state.event_time ?? state.change_time ?? r.ordered_at, source_critical: critical };
      if (requiresRecordReconciliation(state.result_status)) { sections.record_status_changes.push(common); continue; }
      if (kind === "medications") {
        const med = { ...common, drug_name: label(r), dosage: r.dosage ?? null, route: r.route ?? null,
          frequency: r.frequency ?? null, authored_on: r.authored_on ?? null, execution_status: "unknown" };
        (r.status === "active" ? sections.active_medications : sections.medication_records_to_verify).push(med);
        continue;
      }
      if (reason === "other_source_record") { sections.additional_records.push(common); continue; }
      if (kind === "notes") {
        const noteText = r.text || "";
        const terms = purposeMatches.length ? purposeMatches : specialtyMatches;
        const hit = terms.map((term) => match(noteText, term)).find(Boolean);
        const start = Math.max(0, (hit?.index ?? 0) - 45), end = Math.min(noteText.length, start + 220);
        sections.relevant_clinical_notes.push({ ...common, note_id: evidence.source_id, excerpt: noteText.slice(start, end),
          evidence: { ...evidence, span: createTextAnchor(r, { start, end }), text_anchor: createTextAnchor(r, { start, end }) } });
      } else if (kind === "observations") {
        sections.targeted_labs_timeline.push({ ...common, test_name: label(r), value: r.value ?? r.valueQuantity?.value ?? null,
          unit: r.unit ?? r.valueQuantity?.unit ?? null, effective_time: state.event_time, is_critical: critical,
          reference_range: r.referenceRange ?? null, interpretation: "not_evaluated" });
      } else if (kind === "nursing") {
        sections.nursing_observations.push({ ...common, title: r.title || "护理原始记录", measurements: Object.entries(nursingFields)
          .filter(([key]) => r[key] != null).map(([field, [label, unit]]) => ({ field, label, unit, value: r[field] })),
          period: r.period ?? null, interpretation: "not_evaluated" });
      } else if (kind === "diagnosticReports") {
        const report = { ...common, report_name: label(r), impression: r.impression ?? r.impression_text ?? null, ordered_at: r.ordered_at ?? null };
        (["final", "revised"].includes(state.result_status) ? sections.relevant_imaging_reports : sections.pending_specialty_reports).push(report);
      } else if (kind === "orders") sections.pending_specialty_reports.push({ ...common, report_name: label(r), impression: null,
        status_label: "检查医嘱；与报告关联及执行情况待核对", ordered_at: r.ordered_at ?? null });
    }
    const rank = { consult_question: 0, source_critical: 1, specialty_context: 2, other_source_record: 3 };
    for (const rows of Object.values(sections)) rows.sort((a, b) => rank[a.relevance.reason] - rank[b.relevance.reason]
      || new Date(b.timestamp) - new Date(a.timestamp) || a.evidence.content_sha256.localeCompare(b.evidence.content_sha256));
    const result = { success: true, snapshot_id: snapshot.snapshot_id, as_of: snapshot.as_of,
      header: { patient_id: snapshot.context.patient_id, encounter_id: snapshot.context.encounter_id,
        target_department: consultRequest.department.trim(), purpose: consultRequest.purpose.trim(),
        question: consultRequest.question?.trim() || null, urgency: consultRequest.urgency || null, requested_at: consultRequest.requested_at || null },
      allergy_status: allergyKnown ? "过敏史来源待核对" : "未明确记录 (缺口)",
      allergy_evidence: { source_type: "snapshot_allergy_feed", source_id: null, status: "resource_provenance_unverified" },
      retrieval: { strategy: "explicit_terms_v1", focus_terms: focus, specialty_terms: specialty, clinical_relevance_validated: false },
      ...sections, data_gaps: gaps, source_availability: snapshot.source_availability, source_visibility: snapshot.source_visibility,
      evidence_records: Object.values(snapshot.records).flat().filter((entry) => entry.selection_status !== "future"
        && !snapshot.excluded.some((item) => item.reason === "future" && item.evidence.content_sha256 === entry.evidence.content_sha256))
        .map(({ record, evidence, selection_status, selection_reasons }) => ({ record, evidence, selection_status, selection_reasons })),
      excluded_records: snapshot.excluded, boundary: "仅整理来源资料；未匹配不等于不存在；不生成会诊意见，不确认诊疗或给药执行。" };
    result.views = { glance: { purpose: result.header.purpose, question: result.header.question,
      counts: Object.fromEntries(Object.entries(sections).map(([key, rows]) => [key, rows.length])), data_gaps: gaps },
      digest: Object.fromEntries(Object.entries(sections).map(([key, rows]) => {
        const items = rows.filter((row, index) => index < 5 || row.source_critical);
        return [key, { items, total: rows.length, remaining: rows.length - items.length }];
      })),
      drilldown: { snapshot_id: snapshot.snapshot_id, sections, excluded_records: snapshot.excluded },
    };
    result.dossier_sha256 = sha256Hex(canonicalJson(result));
    return detachedFrozenOutput(assertConsultConsistency(result));
  }

  static generateConsultBriefText({ consultDossier: d }) {
    assertConsultConsistency(d);
    const lines = [`【${d.header.target_department}会诊前资料摘要包】`, `资料截至：${d.as_of}`, "一、会诊目的与拟解决核心问题",
      `会诊诉求：${d.header.purpose}`, `具体问题：${d.header.question || "未另行填写"}`, "二、本专科重点病程演变与病历摘录"];
    const add = (rows, describe) => {
      if (!rows.length) lines.push("当前输入未检索到资料；不等于不存在。");
      for (const row of rows) lines.push(`• ${describe(row)} [${row.status_label}] (${row.timestamp}) [来源 ${row.evidence.locator}; 版本 ${row.evidence.version_id ?? "未提供"}]`);
    };
    add(d.relevant_clinical_notes, (r) => r.excerpt);
    lines.push("三、针对性专科检验指标时间轴");
    add(d.targeted_labs_timeline, (r) => `${r.test_name}: ${r.value ?? "未提供"} ${r.unit ?? "单位未提供"}`);
    lines.push("相关护理原始记录（记录区间未确认时不汇总）");
    add(d.nursing_observations, (r) => r.measurements.map(m => `${m.label} ${m.value} ${m.unit}`).join("；"));
    lines.push("四、相关已出影像与专科检查结论"); add(d.relevant_imaging_reports, (r) => `${r.report_name}：${r.impression ?? "结论未提供"}`);
    lines.push("五、初步结果与状态待核对资料"); add(d.pending_specialty_reports, (r) => `${r.report_name}：${r.impression ?? "结论未提供"}`);
    lines.push("六、当前主要用药方案（医嘱，实际给药未确认）"); add(d.active_medications, (r) => `${r.drug_name} ${r.dosage ?? "剂量未提供"}`);
    lines.push("用药状态待核对"); add(d.medication_records_to_verify, (r) => `${r.drug_name} ${r.dosage ?? "剂量未提供"}`);
    lines.push("撤销或录入错误"); add(d.record_status_changes, (r) => r.title);
    lines.push(`其他资料入口：${d.additional_records.length} 条；可在完整视图核对。`, ...d.data_gaps, d.boundary);
    return lines.join("\n");
  }
}
