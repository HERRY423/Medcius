// Unit & Integration Tests for Consultation Preparation Workflow
// Validates: Targeted lab & diagnostic timeline, specialty notes excerpt, pending reports,
// active regimen synthesis, and HospitalAgentAdapter consult workflow execution.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ConsultPreparationEngine } from "../plugins/medcius/lib/consult-preparation-engine.mjs";
import { HospitalAgentAdapter, HOST_TYPES } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import { getCardiologyMultiSourceFeeds } from "../plugins/medcius/servers/fhir/sandbox/hospital-cardiology-sandbox.mjs";

console.log("== Testing Specialist Consultation Preparation ==");

const wardFeeds = getCardiologyMultiSourceFeeds();
const bed2 = wardFeeds[1]; // Bed 02: Heart failure with renal consult request

// ----------------------------------------------------
// Test 1: Consult Dossier Generation for Bed 02 (Nephrology Consult)
// ----------------------------------------------------
console.log("\n[Test 1] Testing Nephrology consult dossier generation on Bed 02...");

const consultRequest = {
  department: "肾内科",
  purpose: "评估顽固性心衰利尿剂抵抗及低钾电解质紊乱方案",
  urgency: "急会诊 (2h内完成)",
  requested_at: new Date().toISOString(),
};

const dossier = ConsultPreparationEngine.prepareConsultDossier({
  context: { tenant_id: "synthetic-hospital", patient_id: bed2.patient.id, encounter_id: bed2.encounter.id },
  asOf: new Date().toISOString(),
  patient: bed2.patient,
  encounter: bed2.encounter,
  consultRequest,
  notes: bed2.notes,
  observations: bed2.lis,
  diagnosticReports: bed2.pacs,
  medications: bed2.his_orders.filter((o) => o.is_medication),
  allergies: bed2.allergies,
});

assert.equal(dossier.success, true);
assert.equal(dossier.header.target_department, "肾内科");
assert.equal(dossier.header.patient_id, bed2.patient.id);
assert.ok(dossier.header.purpose.includes("利尿剂抵抗"));

// Check targeted specialty labs (NT-proBNP, K+)
assert.ok(dossier.targeted_labs_timeline.length >= 2, "Must include NT-proBNP and Potassium labs");
assert.ok(dossier.targeted_labs_timeline.some((l) => l.test_name.includes("BNP") || l.test_name.includes("K+")));

// Check active medications (呋塞米, 氯化钾)
assert.ok(dossier.medication_records_to_verify.some((m) => m.drug_name.includes("呋塞米")));
assert.ok(dossier.medication_records_to_verify.some((m) => m.drug_name.includes("氯化钾")));

// Check data gap (Bed 02 allergy missing)
assert.ok(dossier.data_gaps.length > 0);
assert.ok(dossier.data_gaps[0].includes("ALLERGY_MISSING"));

console.log("✓ Nephrology consult dossier generated with targeted labs and active medications");

// ----------------------------------------------------
// Test 2: Consult Dossier Brief Formatting
// ----------------------------------------------------
console.log("\n[Test 2] Testing formatted consult brief report text...");

const briefText = ConsultPreparationEngine.generateConsultBriefText({
  consultDossier: dossier,
  requestingDoctor: "心内科二病区住院总",
});

assert.ok(briefText.includes("【肾内科会诊前资料摘要包】"));
assert.ok(briefText.includes("一、会诊目的与拟解决核心问题"));
assert.ok(briefText.includes("二、本专科重点病程演变与病历摘录"));
assert.ok(briefText.includes("三、针对性专科检验指标时间轴"));
assert.ok(briefText.includes("六、当前主要用药方案"));
assert.ok(briefText.includes("呋塞米"));
assert.ok(briefText.includes("资料截至"));

console.log("✓ Formatted consult brief report generated");

// ----------------------------------------------------
// Test 3: HospitalAgentAdapter Consult Workflow Execution
// ----------------------------------------------------
console.log("\n[Test 3] Testing HospitalAgentAdapter.executeConsultPrepWorkflow...");

const adapterRes = HospitalAgentAdapter.executeConsultPrepWorkflow({
  host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
  context: {
    tenant_id: "hospital_pku_cardio",
    doctor_id: "DOC-PKU-8801",
    doctor_name: "林德明 (主治医师)",
    patient_id: "pat-cardio-002",
    encounter_id: "enc-cardio-002",
  },
  dataFeeds: bed2,
  consultRequest,
});

assert.equal(adapterRes.success, true);
assert.equal(adapterRes.host_info.workflow, "consult-preparation");
assert.ok(adapterRes.provenance.envelope_sha256);
assert.equal(adapterRes.security_contract.fail_closed_verified, true);
assert.ok(adapterRes.brief_text.includes("【肾内科会诊前资料摘要包】"));

console.log("✓ HospitalAgentAdapter consult workflow execution passed");

// ----------------------------------------------------
// Test 4: Fail-Closed on Missing Target Department
// ----------------------------------------------------
console.log("\n[Test 4] Testing fail-closed on missing consult department...");

assert.throws(
  () => HospitalAgentAdapter.executeConsultPrepWorkflow({
    host: HOST_TYPES.HOSPITAL_CUSTOM_AGENT,
    context: { tenant_id: "hosp_a", doctor_id: "DOC-01", patient_id: "pat-cardio-002", encounter_id: "enc-cardio-002" },
    dataFeeds: bed2,
    consultRequest: {}, // Missing department
  }),
  /FAIL_CLOSED: Missing target department/,
  "Must fail closed when consultRequest.department is missing"
);

console.log("✓ Fail-closed verified on missing consult department");

console.log("\nALL CONSULTATION PREPARATION TESTS PASSED!");

// Fixed synthetic replay: these checks establish behavior, not clinical benefit.
const asOf = "2026-10-05T10:00:00.000Z";
const context = { tenant_id: "fixture-hospital", patient_id: "fixture-p", encounter_id: "fixture-e" };
const base = { context, patient: { id: context.patient_id }, encounter: { id: context.encounter_id }, asOf };
const request = { department: "肾内科", purpose: "核对血钾变化", question: "请核对血钾的结果版本", focus_terms: ["血钾"] };
const lab = { id: "lab-k", name: "血钾", value: 2.5, is_critical: true, status: "final", effective_time: "2026-10-05T08:00:00Z", updated_at: "2026-10-05T08:05:00Z" };
const corrected = { ...lab, value: 4.1, is_critical: false, status: "corrected", updated_at: "2026-10-05T09:00:00Z" };
const lateText = "背景资料。".repeat(60) + "血钾待复核，不能据此确认病因。";
const input = { ...base, observations: [lab, corrected,
  { ...lab, id: "irrelevant", name: "alkaline phosphatase", is_critical: false },
  { ...lab, id: "future", effective_time: "2026-10-05T11:00:00Z" },
  { ...lab, id: "no-time", effective_time: null, updated_at: null },
  { ...lab, id: null },
], notes: [{ id: "note-long", title: "病程", text: lateText, timestamp: "2026-10-05T07:00:00Z" }],
  diagnosticReports: [
    { id: "rep-final", name: "肾超声", status: "final", study_time: "2026-10-05T06:00:00Z" },
    { id: "rep-cancel", name: "肾超声", status: "cancelled", cancelled_at: "2026-10-05T07:00:00Z" },
    { id: "rep-prelim", name: "肾超声", status: "preliminary", study_time: "2026-10-05T06:00:00Z", impression: "初步描述" },
    { id: "rep-unknown", name: "肾超声", status: "unrecognized", ordered_at: "2026-10-05T05:00:00Z" },
    { id: "rep-future-order", name: "肾超声", status: "registered", ordered_at: "2026-10-05T11:00:00Z" },
  ], medications: [
    { id: "med-unknown", drug_name: "氯化钾", authored_on: "2026-10-05T06:00:00Z" },
    { id: "med-active", drug_name: "示例用药", status: "active", authored_on: "2026-10-05T06:00:00Z" },
    { id: "med-stopped", drug_name: "停用药", status: "stopped", stopped_at: "2026-10-05T07:00:00Z" },
  ] };
const snapshot = ConsultPreparationEngine.createSnapshot(input);
const revised = ConsultPreparationEngine.prepareConsultDossier({ snapshot, consultRequest: request });
assert.equal(revised.targeted_labs_timeline.length, 1);
assert.equal(revised.targeted_labs_timeline[0].value, 4.1);
assert.equal(revised.targeted_labs_timeline[0].is_critical, false);
assert.equal(revised.targeted_labs_timeline[0].reference_range, null);
assert.equal(revised.targeted_labs_timeline[0].interpretation, "not_evaluated");
assert.ok(revised.additional_records.some(r => r.evidence.source_id === "irrelevant"), "short k must not match alkaline");
assert.equal(revised.relevant_imaging_reports[0].impression, null, "missing impression must stay unknown");
assert.equal(revised.pending_specialty_reports.length, 2);
assert.ok(revised.record_status_changes.some(r => r.evidence.source_id === "rep-cancel"));
assert.ok(revised.record_status_changes.some(r => r.evidence.source_id === "med-stopped"));
assert.equal(revised.active_medications.length, 1);
assert.equal(revised.active_medications[0].route, null);
assert.equal(revised.active_medications[0].frequency, null);
assert.equal(revised.medication_records_to_verify.length, 1);
const note = revised.relevant_clinical_notes[0];
assert.ok(note.excerpt.includes("血钾"));
assert.equal(lateText.slice(note.evidence.span.start, note.evidence.span.end), note.excerpt);
assert.ok(note.evidence.span.start > 120, "must retrieve matching span beyond old first-120 truncation");
assert.ok(revised.excluded_records.some(r => r.reason === "superseded"));
assert.ok(revised.excluded_records.some(r => r.reason === "SOURCE_TIME_MISSING"));
assert.ok(revised.excluded_records.some(r => r.reason === "SOURCE_ID_MISSING"));
assert.ok(!revised.evidence_records.some(r => ["future", "rep-future-order"].includes(r.evidence.source_id)));
assert.throws(() => { snapshot.records.observations.push({}); }, TypeError);
input.observations[1].value = 99;
assert.equal(ConsultPreparationEngine.prepareConsultDossier({ snapshot, consultRequest: request }).dossier_sha256, revised.dossier_sha256);
// Restore the deliberately mutated input for reorder/duplicate replay.
input.observations[1].value = 4.1;
const reordered = ConsultPreparationEngine.createSnapshot({ ...input, observations: input.observations.slice().reverse() });
assert.equal(reordered.snapshot_id, snapshot.snapshot_id);
const duplicate = ConsultPreparationEngine.createSnapshot({ ...input, observations: [...input.observations, { ...corrected }] });
assert.equal(duplicate.snapshot_id, snapshot.snapshot_id);
const views = ConsultPreparationEngine.prepareConsultViews({ snapshot, consultRequests: [request, { department: "感染科", purpose: "整理培养结果", focus_terms: ["培养"] }] });
assert.ok(views.views.every(v => v.snapshot_id === snapshot.snapshot_id && v.as_of === asOf));
assert.notEqual(views.views[0].dossier_sha256, views.views[1].dossier_sha256);
const conflict = ConsultPreparationEngine.createSnapshot({ ...base, observations: [{ ...lab, version_id: "v1" }, { ...lab, version_id: "v1", value: 8 }] });
const conflicted = ConsultPreparationEngine.prepareConsultDossier({ snapshot: conflict, consultRequest: request });
assert.equal(conflicted.targeted_labs_timeline.length, 0);
assert.ok(conflicted.excluded_records.every(r => r.reason === "conflict"));
for (const patch of [{ context: { ...context, tenant_id: "" } }, { encounter: { id: "other" } }, { asOf: null },
  { observations: [{ ...lab, patient_id: "other" }] }, { observations: [{ ...lab, subject: { reference: "Patient/other" } }] },
  { notes: [{ id: "phi", text: "电话：13800138000", timestamp: asOf }] }]) {
  assert.throws(() => ConsultPreparationEngine.createSnapshot({ ...base, ...patch }), /FAIL_CLOSED/);
}
for (const invalid of [{ department: "肾内科" }, { department: "  ", purpose: "血钾" }, { ...request, focus_terms: [""] }]) {
  assert.throws(() => ConsultPreparationEngine.prepareConsultDossier({ snapshot, consultRequest: invalid }), /FAIL_CLOSED/);
}
assert.throws(() => ConsultPreparationEngine.prepareConsultDossier({ snapshot: JSON.parse(JSON.stringify(snapshot)), consultRequest: request }), /FAIL_CLOSED/);
assert.throws(() => HospitalAgentAdapter.executeConsultPrepWorkflow({ host: HOST_TYPES.HIS_EMBED,
  context: { ...context, doctor_id: "fixture-doctor" }, dataFeeds: {}, consultRequest: request }), /FROZEN|FORBIDDEN|not enabled/i);
const lots = ConsultPreparationEngine.createSnapshot({ ...base, observations: Array.from({ length: 10 }, (_, i) => ({ ...lab, id: `many-${i}` })) });
const lotsView = ConsultPreparationEngine.prepareConsultDossier({ snapshot: lots, consultRequest: request });
assert.equal(lotsView.views.digest.targeted_labs_timeline.items.length, 10, "source-critical records must not be hidden by ordinary cap");
const report = ConsultPreparationEngine.generateConsultBriefText({ consultDossier: revised });
assert.ok(!report.includes("未见明显异常"));
assert.ok(report.includes("结论未提供"));
assert.ok(report.includes("来源 observation/lab-k"));
console.log("✓ Frozen snapshot, multi-specialty views, corrections, conflicts, PHI, provenance, time and no-fabrication regression checks passed");

// Execute the actual reference UI renderer, including HTML escaping and expandable evidence.
const workstationHtml = readFileSync(new URL("../plugins/medcius/servers/api/src/ui/workstation.html", import.meta.url), "utf8");
const ui = vm.createContext({ sessionStorage: { getItem: () => null } });
vm.runInContext(workstationHtml.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
const hostile = structuredClone(revised);
hostile.header.purpose = '<img src=x onerror="alert(1)">';
const rendered = ui.renderConsult(hostile);
assert.ok(rendered.includes("查看原始依据"));
assert.ok(rendered.includes("资料截至"));
assert.ok(rendered.includes("&lt;img"));
assert.ok(!rendered.includes('<img src=x'));
assert.ok(rendered.includes("lab-k"));
assert.ok(!rendered.includes("未见明显异常"));
console.log("✓ Reference consultation UI renders source evidence and safely escapes input");

const nursingSnapshot = ConsultPreparationEngine.createSnapshot({ ...base, nursing: [
  { id: "nursing-1", timestamp: "2026-10-05T08:00:00Z", urine_output_ml: 0, temperature: 36.8 },
] });
const nursingView = ConsultPreparationEngine.prepareConsultDossier({ snapshot: nursingSnapshot,
  consultRequest: { department: "肾内科", purpose: "整理尿量记录" } });
assert.equal(nursingView.nursing_observations[0].measurements.find(m => m.field === "urine_output_ml").value, 0);
assert.equal(nursingView.nursing_observations[0].period, null);
assert.equal(nursingView.nursing_observations[0].evidence.source_id, "nursing-1");
assert.equal(nursingView.nursing_observations[0].interpretation, "not_evaluated");

const routed = HospitalAgentAdapter.routeAndExecuteWorkflow({ skillId: "consult-preparation", host: HOST_TYPES.CODEX,
  mode: "research", context: { tenant_id: "synthetic-hospital", patient_id: bed2.patient.id, encounter_id: bed2.encounter.id, doctor_id: "fixture-doctor", as_of: new Date().toISOString() },
  dataFeeds: bed2, options: { consultRequests: [request, { department: "心内科", purpose: "整理心衰资料" }] } });
assert.equal(routed.consultation_views.views.length, 2);
assert.ok(routed.consultation_views.views.every(v => v.snapshot_id === routed.dossier.snapshot_id));
const invalidTimeSnapshot = ConsultPreparationEngine.createSnapshot({ ...base, observations: [{ ...lab, updated_at: "invalid" }] });
assert.equal(ConsultPreparationEngine.prepareConsultDossier({ snapshot: invalidTimeSnapshot, consultRequest: request }).targeted_labs_timeline.length, 0);
assert.ok(invalidTimeSnapshot.excluded.some(e => e.reason === "SOURCE_TIME_INVALID"));
