// Local synthetic regressions for lifecycle state at progressive/draft surfaces.
import assert from "node:assert/strict";
import { HospitalAgentAdapter } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import { StagedDraftService } from "../plugins/medcius/lib/staged-draft-service.mjs";

const now = "2026-10-04T12:00:00Z";
const context = { tenant_id: "tenant-draft-synthetic", doctor_id: "doctor-synthetic", patient_id: "patient-synthetic",
  encounter_id: "encounter-synthetic", as_of: now };
const source = (status) => ({ connector_id: "synthetic-lis", kind: "lis", status, fetched_at: now,
  record_count: status === "available_empty" ? 0 : null, accepted_record_count: status === "available_empty" ? 0 : null,
  source_version: null, reason_code: status === "unavailable" ? "SOURCE_TIMEOUT" : null });
const feeds = { patient: { id: context.patient_id }, notes: [], nis: [], lis: [], pacs: [], his_orders: [] };
function fromFeeds(availability) {
  return HospitalAgentAdapter.routeAndExecuteWorkflow({ skillId: "patient-evolution-summary", host: "codex", context,
    dataFeeds: { ...feeds, source_availability: availability } });
}
function assertNoInventedNormal(views) {
  assert.notEqual(views.glance.status, "STABLE");
  assert.notEqual(views.glance.color, "GREEN");
  const draft = StagedDraftService.createStagedDraft({ patient: feeds.patient, progressiveViews: views });
  assert.doesNotMatch(draft.rendered_markdown, /病情平稳无特殊演变|出入量平衡。|遵前医嘱|今日复查/);
  assert.match(draft.rendered_markdown, /未提供医师评估与处置内容/);
  return draft;
}

for (const availability of [[], [source("unavailable")], [source("unknown")], [source("available_empty")]]) {
  const result = fromFeeds(availability);
  assertNoInventedNormal(result.progressive_views);
  assert.deepEqual(result.progressive_views.digest.blocks.source_availability, availability);
}

const lifecycleItems = [
  { id: "CHANGE-CANCEL", source_type: "Observation", source_id: "cancelled-result", version_id: "2", change_type: "cancellation",
    result_status: "cancelled", display_text: "合成检验已取消；原值不作为当前事实" },
  { id: "CHANGE-ERROR", source_type: "Observation", source_id: "error-result", change_type: "entered_in_error",
    result_status: "entered_in_error", display_text: "合成检验错误录入，待核对" },
  { id: "CHANGE-REV", source_type: "Observation", source_id: "revised-result", version_id: "2", change_type: "revision",
    result_status: "revised", display_text: "合成检验修订，旧版本确认不能关闭新结果" },
  { id: "CHANGE-LATE", source_type: "Observation", source_id: "late-result", change_type: "new_result", arrival_status: "late_record",
    result_status: "final", display_text: "合成迟到记录：事件发生在窗口前" },
  { id: "CHANGE-UNKNOWN", source_type: "Observation", source_id: "unknown-result", change_type: "unknown",
    result_status: "unknown", display_text: "合成检验结果状态未知" },
];
const item = { id: "LAB-SELECTED", summary: "合成血钾记录 4.2 mmol/L，最终结果", source_type: "Observation", source_id: "lab-current", span: "合成原文证据", timestamp: now };
const other = { ...item, id: "LAB-OTHER", summary: "未选择的合成检验记录", source_id: "lab-other" };
const summary = { patient: feeds.patient, critical_values: [], selectable_items: [item, other, ...lifecycleItems], blocks: {
  what_changed: { abnormal_labs: [item, other], vitals_and_fluids: { vitals: { t_max: 37.1, bp_max: "120/75", hr_avg: 78 },
    fluids: { intake_total_ml: 800, output_total_ml: 600, net_balance_label: "+200 mL", status: "partial" } } },
  whats_pending: {}, data_gaps: [], structured_multisource_alignment: [], source_availability: [source("available")],
  record_changes: { items: lifecycleItems, counts: { cancellation: 1, revision: 1, unknown: 1, late_record: 1, entered_in_error: 1 } },
  high_risk_followup: { items: [{ source_type: "Observation", source_id: "revised-result", version_id: "2", closure_status: "open" }] },
  evidence: [{ ...item, item_id: item.id }, { ...other, item_id: other.id }],
} };
const views = StagedDraftService.generateProgressiveViewsFromSummary(summary);
assert.deepEqual(views.digest.blocks.record_changes, summary.blocks.record_changes);
assert.deepEqual(views.digest.blocks.high_risk_followup, summary.blocks.high_risk_followup);
assert.deepEqual(views.digest.blocks.what_changed.abnormal_labs, summary.blocks.what_changed.abnormal_labs);
assert.equal(views.drilldown.full_evidence_spans[0].span, "合成原文证据");
const draft = assertNoInventedNormal(views);
for (const change of lifecycleItems) assert.ok(draft.rendered_markdown.includes(change.display_text));
assert.match(draft.rendered_markdown, /37.1|800/);
assert.match(draft.rendered_markdown, /来源: Observation \/ lab-current/);
assert.match(draft.rendered_markdown, /待核对/);
const selected = StagedDraftService.createStagedDraft({ progressiveViews: views, selectedItemIds: [item.id], assessmentAndPlan: "合成医师填写内容" });
assert.deepEqual(selected.selected_item_ids, [item.id]);
assert.deepEqual(selected.evidence_references.map((e) => e.source_id), ["lab-current"]);
assert.match(selected.rendered_markdown, /合成血钾记录/);
assert.doesNotMatch(selected.rendered_markdown, /未选择的合成检验记录/);
assert.doesNotMatch(selected.rendered_markdown, /37\.1|800/);
assert.match(selected.rendered_markdown, /未选择生命体征条目/);
assert.match(selected.rendered_markdown, /合成医师填写内容/);
// Returned views are detached from the summary; later caller edits cannot erase frozen state in this view.
summary.blocks.record_changes.items[0].display_text = "changed later";
assert.notEqual(views.digest.blocks.record_changes.items[0].display_text, "changed later");

for (const closure_status of ["open", "unknown", "requires_reconciliation"]) {
  const followupSummary = { blocks: { source_availability: [source("available")], what_changed: {},
    high_risk_followup: { items: [{ closure_status }] } } };
  assertNoInventedNormal(StagedDraftService.generateProgressiveViewsFromSummary(followupSummary));
}
const unknownCritical = StagedDraftService.generateProgressiveViewsFromSummary({ critical_values: [{ name: "合成血钾", value: 2.2, unit: "mmol/L", result_status: "unknown" }], blocks: {} });
assert.match(unknownCritical.glance.headline, /来源危急标记待核对/);
assert.match(unknownCritical.glance.headline, /状态未知/);
assertNoInventedNormal(StagedDraftService.generateProgressiveViews({}));
const failedUnknownGate = StagedDraftService.generateProgressiveViews({ gatingResult: { passed: false } });
assert.equal(failedUnknownGate.glance.status, "UNKNOWN");
assert.doesNotMatch(failedUnknownGate.glance.headline, /存在危急值或严重病情恶化/);
console.log("Lifecycle progressive-view and staged-draft boundary regressions passed.");
