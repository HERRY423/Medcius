import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecordLifecycle, resolveRecordVersions } from "../plugins/medcius/lib/record-lifecycle.mjs";
import { PatientEvolutionEngine } from "../plugins/medcius/lib/patient-evolution-engine.mjs";
import { HospitalDataAdapter } from "../plugins/medcius/lib/hospital-data-adapter.mjs";
import { extractDualTimestamp, TimelineReconstructor } from "../plugins/medcius/lib/timeline-reconstructor.mjs";

const now = "2026-10-04T12:00:00Z", cutoffTime = "2026-10-03T12:00:00Z";
const base = { id: "result-synthetic", code: "k", name: "合成血钾", value: 4, unit: "mmol/L", status: "final",
  version_id: "v1", effective_time: "2026-10-04T08:00:00Z", resulted_at: "2026-10-04T09:00:00Z", _source: { system: "lis-synthetic" } };
const analyze = (inputs) => PatientEvolutionEngine.analyzePatientEvolution({ patient: { id: "synthetic-patient" }, now, ...inputs });

test("new publication, correction, cancellation, unknown, and late arrival are separate axes", () => {
  const classify = (patch) => classifyRecordLifecycle({ ...base, ...patch }, { now, cutoffTime });
  assert.equal(classify({}).change_type, "new_result");
  assert.equal(classify({ status: "corrected", updated_at: "2026-10-04T10:00:00Z" }).change_type, "revision");
  assert.equal(classify({ status: "cancelled", cancelled_at: "2026-10-04T10:00:00Z" }).change_type, "cancellation");
  assert.equal(classify({ status: null }).result_status, "unknown");
  assert.equal(classify({ resulted_at: null }).change_type, "unknown", "sampling is not publication");
  const late = classify({ effective_time: "2026-10-01T08:00:00Z", recorded_at: "2026-10-04T10:00:00Z" });
  assert.equal(late.arrival_status, "late_record");
  assert.equal(late.event_time_status, "historical");
  assert.equal(late.is_new_since_previous, null);
});

test("a corrected value replaces its old version without fabricating a physiological trend", () => {
  const summary = analyze({ observations: [base, { ...base, status: "corrected", version_id: "v2", value: 3.5, updated_at: "2026-10-04T10:00:00Z" }] });
  const lab = summary.blocks.what_changed.abnormal_labs[0];
  assert.equal(lab.current_value, 3.5);
  assert.equal(lab.delta_summary.includes("基线"), false);
  assert.equal(summary.blocks.record_changes.counts.revision, 1);
  assert.equal(summary.blocks.record_changes.counts.new_result, 0, "a superseded result is not counted as a current new result");
  assert.equal(summary.blocks.record_changes.items.find((item) => item.version_id === "v1").selection_status, "superseded");
});

test("a changed version with final status still expresses a revision", () => {
  const summary = analyze({ observations: [base, { ...base, version_id: "v2", value: 3.5, updated_at: "2026-10-04T10:00:00Z" }] });
  assert.equal(summary.blocks.what_changed.abnormal_labs[0].change_type, "revision");
  assert.equal(summary.blocks.record_changes.counts.revision, 1);
});

test("explicit replacement and stable resource identity link different source message ids", () => {
  for (const pair of [
    [base, { ...base, id: "replacement", supersedes_id: base.id, version_id: "v2", status: "corrected", value: 3, updated_at: "2026-10-04T10:00:00Z" }],
    [{ ...base, source_record_id: "resource" }, { ...base, id: "message-2", source_record_id: "resource", version_id: "v2", status: "corrected", value: 3, updated_at: "2026-10-04T10:00:00Z" }],
  ]) {
    const resolved = resolveRecordVersions(pair, { now, cutoffTime });
    assert.equal(resolved.current_records.length, 1);
    assert.equal(resolved.current_records[0].value, 3);
  }
});

test("withdrawn results cannot remain in the current numerical or critical panels", () => {
  for (const status of ["cancelled", "entered-in-error"]) {
    const summary = analyze({ lisFeed: [
      { ...base, is_critical_reported: true },
      { ...base, status, version_id: "v2", cancelled_at: "2026-10-04T10:00:00Z", updated_at: "2026-10-04T10:00:00Z" },
    ] });
    assert.equal(summary.blocks.what_changed.abnormal_labs.length, 0);
    assert.equal(summary.critical_values.length, 0);
    assert.equal(summary.blocks.whats_pending.cancelled_or_invalid.length, 1);
  }
});

test("ambiguous versions or reused version identifiers stay unknown", () => {
  const conflicting = [{ ...base, value: 4 }, { ...base, value: 6, updated_at: "2026-10-04T10:00:00Z" }];
  const summary = analyze({ observations: conflicting });
  assert.equal(summary.blocks.what_changed.abnormal_labs.length, 0);
  assert.ok(summary.blocks.record_changes.items.every((item) => item.selection_status === "conflict"));
});

test("a late historical result and note are visible without appearing as today's new measurements or symptoms", () => {
  const summary = analyze({ lisFeed: [{ ...base, effective_time: "2026-10-01T08:00:00Z", resulted_at: "2026-10-01T09:00:00Z", recorded_at: now }],
    notes: [{ id: "note-late", event_time: "2026-10-01T08:00:00Z", timestamp: now, recorded_at: now, text: "患者出现胸痛。" }] });
  assert.equal(summary.blocks.record_changes.counts.late_record, 2);
  assert.equal(summary.blocks.record_changes.counts.new_result, 0, "late historical publications do not inflate this window's new-result count");
  assert.equal(summary.blocks.what_changed.abnormal_labs.length, 0);
  assert.equal(summary.blocks.what_changed.clinical_symptoms.length, 0);
  assert.ok(summary.blocks.record_changes.items.find((item) => item.source_id === "note-late").summary.includes("不作为"));
});

test("unknown source status is not fabricated as final, active, or preliminary", () => {
  assert.equal(HospitalDataAdapter.normalizeLisFeed([{ ...base, status: undefined }]).observations[0].status, null);
  assert.equal(HospitalDataAdapter.normalizePacsFeed([{ id: "image", study_time: now }]).diagnostic_reports[0].status, null);
  assert.equal(HospitalDataAdapter.normalizeHisOrders([{ id: "order" }]).orders[0].status, null);
  const summary = analyze({ observations: [{ ...base, status: null }] });
  assert.match(summary.blocks.what_changed.abnormal_labs[0].summary, /状态未知/);
  assert.match(summary.blocks.structured_multisource_alignment[0].lis_summary, /状态未知/);
  assert.match(summary.blocks.structured_multisource_alignment[0].nis_summary, /未提供/);
});

test("empty interfaces, unavailable interfaces and unknown completeness retain different messages", () => {
  const sourceAvailability = [
    { connector_id: "lis", kind: "lis", status: "available_empty", record_count: 0 },
    { connector_id: "pacs", kind: "pacs", status: "unavailable", record_count: null },
    { connector_id: "nis", kind: "nis", status: "unknown", record_count: 1 },
  ];
  const summary = analyze({ sourceAvailability });
  assert.deepEqual(summary.blocks.source_availability, sourceAvailability);
  for (const status of ["AVAILABLE_EMPTY", "UNAVAILABLE", "UNKNOWN"]) assert.ok(summary.blocks.data_gaps.some((item) => item.gap_type === `SOURCE_${status}`));
  assert.match(summary.blocks.data_gaps.find((item) => item.gap_type === "RENAL_FUNCTION_MISSING").summary, /不据此推断未做检查/);
});

test("nursing corrections do not double count fluid and cancelled measurements are excluded", () => {
  const original = { id: "nis", version_id: "1", timestamp: "2026-10-04T08:00:00Z", status: "final", intake_ml: 100 };
  const corrected = { ...original, version_id: "2", status: "corrected", updated_at: now, intake_ml: 150 };
  assert.equal(HospitalDataAdapter.normalizeNisFeed([original, corrected], { now }).fluid_balance.intake_total_ml, 150);
  assert.equal(HospitalDataAdapter.normalizeNisFeed([{ ...corrected, status: "cancelled", cancelled_at: now }], { now }).fluid_balance, null);
});

test("missing timeline times remain null even when a fallback clock is supplied", () => {
  assert.deepEqual(extractDualTimestamp({}, { fallbackRecordTime: Date.parse(now) }), { t_event: null, t_record: null, uncertainty: true });
  const timeline = TimelineReconstructor.reconstructTimeline([{ id: "unknown" }], { fallbackTime: Date.parse(now) });
  assert.equal(timeline[0]._timeline_meta.t_event, null);
  assert.equal(timeline[0]._timeline_meta.lag_minutes, null);
  assert.equal(TimelineReconstructor.extractDeltaWindow(timeline, Date.parse(cutoffTime), Date.parse(now)).length, 0);
});

test("an empty selected draft never claims all work is closed or treatment unchanged", () => {
  const summaryData = analyze({});
  const draft = PatientEvolutionEngine.generateProgressNoteDraft({ summaryData, selectedItemIds: [], doctorId: "synthetic-doctor" });
  assert.equal(draft.draft_text.includes("无待办事项"), false);
  assert.equal(draft.draft_text.includes("维持既有诊疗方案"), false);
  assert.match(draft.draft_text, /不代表所有事项已闭环/);
});

test("retracted and superseded note text cannot appear as current symptoms", () => {
  const note = { id: "note", version_id: "v1", status: "final", event_time: "2026-10-04T08:00:00Z",
    resulted_at: "2026-10-04T08:00:00Z", text: "病程记录：患者出现明显胸闷气促。" };
  for (const status of ["cancelled", "entered-in-error"]) {
    const summary = analyze({ notes: [note, { ...note, status, version_id: "v2", updated_at: "2026-10-04T10:00:00Z" }] });
    assert.equal(summary.blocks.what_changed.clinical_symptoms.length, 0);
    assert.equal(summary.blocks.whats_pending.cancelled_or_invalid.length, 1);
  }
  const corrected = analyze({ notes: [note, { ...note, version_id: "v2", status: "corrected",
    updated_at: "2026-10-04T10:00:00Z", text: "病程记录：患者未诉明显胸闷气促。" }] });
  assert.equal(corrected.blocks.what_changed.clinical_symptoms.length, 1);
  assert.match(corrected.blocks.what_changed.clinical_symptoms[0].summary, /未诉/);
  const future = analyze({ notes: [{ ...note, recorded_at: "2026-10-05T08:00:00Z" }] });
  assert.equal(future.blocks.what_changed.clinical_symptoms.length, 0);
});

test("cancelled medication order cannot remain a new medication despite an old change label", () => {
  const summary = analyze({ medications: [{ id: "cancelled-med", drug_name: "合成药物", status: "cancelled",
    change_type: "added", authored_on: "2026-10-04T08:00:00Z", cancelled_at: "2026-10-04T10:00:00Z" }] });
  assert.equal(summary.blocks.what_changed.medication_diff.added.length, 0);
  assert.equal(summary.blocks.whats_pending.cancelled_or_invalid.length, 1);
});

test("late arrival remains explicit in follow-up rather than looking like a new event", () => {
  const summary = analyze({ observations: [{ ...base, is_critical: true,
    effective_time: "2026-10-01T08:00:00Z", recorded_at: now }] });
  assert.equal(summary.blocks.high_risk_followup.items[0].arrival_status, "late_record");
  assert.equal(summary.blocks.high_risk_followup.items[0].current_window_event, false);
});

test("cross-source panels cannot revive cancelled images or late historical measurements", () => {
  const summary = analyze({ diagnosticReports: [{ id: "cancelled-image", name: "超声心动", status: "cancelled",
    event_time: "2026-10-04T08:00:00Z", cancelled_at: "2026-10-04T10:00:00Z", impression: "合成撤销影像结论" }],
    observations: [{ ...base, code: "scr", name: "肌酐", effective_time: "2026-10-01T08:00:00Z", recorded_at: now }] });
  const alignment = JSON.stringify(summary.blocks.structured_multisource_alignment);
  assert.equal(alignment.includes("合成撤销影像结论"), false);
  assert.equal(alignment.includes("血肌酐"), false);
});
