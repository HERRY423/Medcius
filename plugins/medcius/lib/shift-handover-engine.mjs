import { requiresRecordReconciliation } from "./record-lifecycle.mjs";
// Handover preparation: shared source state plus explicitly authored human events.
import { createPatientSourceSnapshot, assertPatientSourceSnapshot } from "./patient-source-snapshot.mjs";
import { classifyRecordLifecycle, describeRecordLifecycle, lifecycleTime } from "./record-lifecycle.mjs";
import { trackHighRiskFollowup, isExplicitCritical } from "./high-risk-followup-tracker.mjs";
import { readHandoverEvents, deriveHandoverResponsibility } from "./handover-events.mjs";
import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { assertHandoverConsistency, detachedFrozenOutput } from "./output-consistency.mjs";

export const SHIFT_TYPES = { MORNING_TO_EVENING: "day_to_night", EVENING_TO_MORNING: "night_to_day", WEEKEND_ON_CALL: "weekend_handoff" };
const hash = value => sha256Hex(canonicalJson(value));
const label = r => r.test_name || r.study_name || r.drug_name || r.title || (typeof r.code === "string" ? r.code : r.code?.text) || "名称未提供";

export class ShiftHandoverEngine {
  static createSnapshot(params) { return createPatientSourceSnapshot(params); }

  static analyzePatientHandover({ snapshot, windowStart, eventsAsOf, handoverContext = {}, handoverEvents = [], verifyHandoverEvent,
    verifyHandoverHistory, rulePack = null, shiftType = SHIFT_TYPES.MORNING_TO_EVENING, ...input }) {
    snapshot = snapshot ? assertPatientSourceSnapshot(snapshot) : createPatientSourceSnapshot(input);
    if (!Object.values(SHIFT_TYPES).includes(shiftType)) throw new Error("FAIL_CLOSED: Invalid handover shift type");
    if (typeof windowStart !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(windowStart)
      || lifecycleTime(windowStart) == null || lifecycleTime(windowStart) >= lifecycleTime(snapshot.as_of)) throw new Error("FAIL_CLOSED: Explicit valid handover window required");
    eventsAsOf ??= snapshot.as_of;
    if (typeof eventsAsOf !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(eventsAsOf)
      || lifecycleTime(eventsAsOf) == null || lifecycleTime(eventsAsOf) < lifecycleTime(snapshot.as_of)) throw new Error("FAIL_CLOSED: Invalid event cutoff");
    const session = { handover_id: handoverContext.handover_id ?? null, outgoing_doctor_id: handoverContext.outgoing_doctor_id ?? null,
      incoming_doctor_id: handoverContext.incoming_doctor_id ?? null };
    const human = readHandoverEvents({ events: handoverEvents, verifyEvent: verifyHandoverEvent, context: snapshot.context, session, eventsAsOf });
    const historyDigest = hash(human.history);
    const historyComplete = typeof verifyHandoverHistory === "function" && verifyHandoverHistory({ history_digest: historyDigest,
      context: structuredClone(snapshot.context), handover_context: structuredClone(session), events_as_of: eventsAsOf }) === true;
    const current = key => (snapshot.records[key] || []).filter(e => e.eligible);
    // Preserve a revision detected by the shared resolver even if the source kept status=final.
    const recordForState = entry => entry.lifecycle.change_type === "revision" ? { ...entry.record, result_status: "corrected" } : entry.record;
    const clinical = key => current(key).filter(e => !requiresRecordReconciliation(e.lifecycle.result_status));
    const item = entry => ({ title: label(entry.record), record: entry.record, evidence: entry.evidence, lifecycle: entry.lifecycle });
    const changes = Object.entries(snapshot.records).flatMap(([kind, entries]) => entries.filter(e => e.eligible).map(entry => {
      const state = classifyRecordLifecycle(recordForState(entry), { sourceType: entry.evidence.source_type, now: snapshot.as_of, cutoffTime: windowStart });
      return { ...item(entry), kind, lifecycle: state, description: describeRecordLifecycle(state, label(entry.record)), is_new_since_previous: null };
    })).filter(e => e.lifecycle.change_time_status === "in_window" || e.lifecycle.recorded_time_status === "in_window")
      .sort((a, b) => (lifecycleTime(b.lifecycle.change_time) ?? 0) - (lifecycleTime(a.lifecycle.change_time) ?? 0) || a.evidence.content_sha256.localeCompare(b.evidence.content_sha256));
    const followup = trackHighRiskFollowup({ orders: current("orders").map(recordForState), observations: current("observations").map(recordForState),
      diagnosticReports: current("diagnosticReports").map(recordForState), rulePack, now: snapshot.as_of, cutoffTime: windowStart,
      sourceAvailability: snapshot.source_availability });
    const dataGaps = [];
    if (!snapshot.source_availability.length) dataGaps.push("来源覆盖未知；未检索到不等于没有待跟进事项。");
    if (snapshot.excluded.length) dataGaps.push(`${snapshot.excluded.length} 条旧版本、冲突、缺来源/时间或未来记录未进入当前事实。`);
    if (!human.plans.length) dataGaps.push("未提供经来源核验的交班医生预案；不自动生成处置预案。");
    if (!historyComplete) dataGaps.push("交接事件历史完整性未核验；可能缺少后续撤回或修订，不能据此确认当前责任归属。");
    if (!session.handover_id || !session.outgoing_doctor_id || !session.incoming_doctor_id) dataGaps.push("交接班次或双方身份未完整提供，不能确认责任转交。");
    if (Object.values(snapshot.records).flat().some(e => e.evidence.ownership_basis === "feed_context")) dataGaps.push("部分记录仅绑定输入资料包，记录级归属尚未独立核验。");
    const scheduled = clinical("orders").map(e => ({ ...item(e), scheduled_time: e.record.scheduled_time ?? null, purpose: e.record.purpose ?? null, execution_status: "unknown" }));
    const sbar = {
      situation: { patient_id: snapshot.context.patient_id, encounter_id: snapshot.context.encounter_id, care_level: null, acuity_status: "unknown",
        note: "护理级别与病情稳定性不由床位、空数据或无报警推断。" },
      background: { source_notes: clinical("notes").map(item), allergy_summary: "过敏史需核对有来源的原始记录", has_allergy_gap: true },
      assessment: { critical_values: clinical("observations").filter(e => isExplicitCritical(e.record)).map(item),
        source_observations: clinical("observations").map(item), nursing_records: clinical("nursing").map(item),
        medication_orders: clinical("medications").map(e => ({ ...item(e), execution_status: "unknown" })),
        diagnostic_reports: current("diagnosticReports").map(item), fluid_balance_status: "unknown" },
      recommendation: { scheduled_follow_ups: scheduled, contingency_plans: human.plans,
        attribution: "仅保留来源核验的交班医师原话；不生成医学建议或新医嘱。" },
    };
    const packet = { schema_version: "medcius.shift-handover.v2", snapshot_id: snapshot.snapshot_id, as_of: snapshot.as_of,
      window_start: windowStart, shift_type: shiftType, context: snapshot.context, handover_context: session,
      sbar, record_changes: changes, high_risk_followup: followup, data_gaps: dataGaps,
      source_availability: snapshot.source_availability, source_visibility: snapshot.source_visibility, excluded_records: snapshot.excluded };
    const packetDigest = hash(packet);
    const responsibility = deriveHandoverResponsibility({ history: human.history, session, packetDigest, snapshotAsOf: snapshot.as_of });
    responsibility.event_history_completeness = historyComplete ? "host_verified_complete" : "unknown";
    responsibility.current_responsible_doctor_id = historyComplete ? responsibility.reported_responsible_doctor_id : null;
    return detachedFrozenOutput(assertHandoverConsistency({ ...packet, patient_id: snapshot.context.patient_id, generated_at: snapshot.as_of, packet_digest: packetDigest,
      events_as_of: eventsAsOf, handover_events: human.history, event_history_digest: historyDigest, responsibility,
      boundary: "准备、浏览、结果复核、责任转交与临床执行分别记录；本输出不写回医院系统。" }));
  }

  static generateHandoverText({ handoverData: d }) {
    assertHandoverConsistency(d);
    const lines = ["【交接班准备资料（SBAR）】", `资料截至：${d.as_of}；变化窗口起点：${d.window_start}`,
      "一、S（现状）", d.sbar.situation.note, "二、B（来源病程）"];
    const add = rows => {
      if (!rows.length) lines.push("当前资料中未检索到；不等于不存在。");
      for (const row of rows) lines.push(`• ${row.title}：${row.record.text ?? row.record.value ?? row.record.impression ?? row.record.dosage ?? "请核对原始字段"} [来源 ${row.evidence.locator}]`);
    };
    add(d.sbar.background.source_notes);
    lines.push("三、A（变化与待跟进）");
    for (const change of d.record_changes) lines.push(`• ${change.description} [来源 ${change.evidence.locator}]`);
    for (const pending of d.high_risk_followup.items) lines.push(`• ${pending.label}：结果复核 ${pending.review_status}；跟进 ${pending.closure_status}`);
    add(d.sbar.assessment.nursing_records);
    lines.push("四、R（来源医嘱与医生原话预案）"); add(d.sbar.recommendation.scheduled_follow_ups);
    for (const plan of d.sbar.recommendation.contingency_plans) lines.push(`• ${plan.trigger_text ?? "触发条件未提供"}：${plan.action_text} [交班医生 ${plan.author_id}；来源事件 ${plan.evidence.source_id}]`);
    lines.push(`责任交接状态：${d.responsibility.status}`, d.responsibility.boundary, ...d.data_gaps, d.boundary);
    return lines.join("\n");
  }
}
