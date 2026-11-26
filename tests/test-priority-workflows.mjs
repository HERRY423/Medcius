import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import vm from "node:vm";
import { createPatientSourceSnapshot } from "../plugins/medcius/lib/patient-source-snapshot.mjs";
import { prepareWardNightHandover } from "../plugins/medcius/lib/ward-handover.mjs";
import { resolveTextAnchor } from "../plugins/medcius/lib/evidence-anchors.mjs";
import { DischargeReadinessEngine } from "../plugins/medcius/lib/discharge-readiness-engine.mjs";
import { backtestRecordQuality } from "../plugins/medcius/lib/record-quality-backtest.mjs";
import { HospitalAgentAdapter, HOST_TYPES } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import { dischargeFixture } from "./fixtures/discharge-documentation.mjs";
import { input as historicalInput, policy } from "./fixtures/jiangsu-record-review.mjs";

const windowStart = "2026-10-04T12:00:00Z", asOf = "2026-10-05T00:00:00Z";
const ward = { tenant_id: "synthetic-tenant", ward_id: "synthetic-ward" };
const scope = { ...ward, as_of: asOf };
const member = suffix => ({ ...ward, patient_id: `synthetic-patient-${suffix}`, encounter_id: `synthetic-encounter-${suffix}` });
const roster = members => ({ ...scope, status: "complete", read_only_enforced: true, source_id: "synthetic-census", source_version: "v1",
  synchronized_through: asOf, fetched_at: asOf, members });
const lab = (id, time, extra = {}) => ({ id, source_system: "LIS", version_id: "v1", test_name: "血钾", value: 2.6, unit: "mmol/L",
  is_critical: true, status: "final", effective_time: time, issued: time, ...extra });
const order = (id, extra = {}) => ({ id, source_system: "HIS", version_id: "v1", title: "合成检查事项", status: "pending_execution",
  scheduled_time: "2026-10-04T18:00:00Z", authored_on: "2026-10-04T17:00:00Z", ...extra });
const nightPatient = (member, feeds = {}) => ({ snapshot: createPatientSourceSnapshot({ context: member,
  patient: { id: member.patient_id }, encounter: { id: member.encounter_id, class: "IMP", status: "in-progress" }, asOf, ...feeds }) });

test("night SBAR selects current critical results, carryover and pending tasks with source links", () => {
  const [critical, carryover, tasks, revised, missing] = ["critical", "carryover", "tasks", "revised", "missing"].map(member);
  const patients = [nightPatient(critical, { observations: [lab("new-critical", "2026-10-04T20:00:00Z")] }),
    nightPatient(carryover, { observations: [lab("carryover-critical", "2026-10-04T10:00:00Z")] }),
    nightPatient(tasks, { orders: [order("due-order"), order("completed-order", { status: "completed", source_status: "pending_execution" }),
      order("future-orders", { scheduled_time: "2026-10-05T02:00:00Z" }), order("draft-order", { status: "draft" })] }),
    nightPatient(revised, { observations: [lab("revised-obs", "2026-10-04T08:00:00Z"),
      lab("revised-obs", "2026-10-04T08:00:00Z", { version_id: "v2", is_critical: false, updated_at: "2026-10-04T10:00:00Z",
        status: "corrected" })] })];
  const wardRoster = roster([tasks, revised, carryover, critical, missing]);
  const args = { scope, roster: wardRoster, patients, windowStart };
  const result = prepareWardNightHandover(args);
  assert.deepEqual(result.priority.map(x => x.patient_id), [critical.patient_id, carryover.patient_id, tasks.patient_id]);
  assert.deepEqual(result.priority[0].signals.critical_values.map(x => [x.evidence.source_id, x.evidence.version_id]), [["new-critical", "v1"]]);
  assert.equal(result.priority[1].signals.critical_values.length, 0);
  assert.ok(result.priority[1].signals.unresolved_followup.some(x => x.evidence.some(e => e.source_id === "carryover-critical")));
  assert.deepEqual(result.priority[2].signals.pending_orders.map(x => x.evidence.source_id), ["due-order"]);
  assert.equal(result.priority[2].sbar_packet.responsibility.current_responsible_doctor_id, null);
  assert.deepEqual(result.remaining.map(x => x.status), ["no_priority_signal_in_supplied_records", "source_review_required"]);
  assert.throws(() => prepareWardNightHandover({ ...args, patients: [...patients, nightPatient(member("foreign"))] }), /SCOPE_MISMATCH/);
  assert.throws(() => prepareWardNightHandover({ ...args, host: "his_embed" }), /P0_SKILL_FROZEN/);
});

test("the next ward batch automatically carries verified unresolved tasks by encounter after a bed move", () => {
  const person = member("handoff");
  const first = prepareWardNightHandover({scope,roster:roster([{...person,bed_number:"01"}]),windowStart,
    patients:[nightPatient(person,{orders:[order("follow",{assigned_to_id:"fixture-team",followup_due_at:asOf})]})]});
  const nextTime = "2026-10-06T00:00:00Z", nextScope = {...scope,as_of:nextTime};
  const nextRoster = {...roster([{...person,bed_number:"18"}]),as_of:nextTime,synchronized_through:nextTime,fetched_at:nextTime};
  const args = {scope:nextScope,roster:nextRoster,windowStart:asOf,patients:[nightPatient(person,{asOf:nextTime})],
    previousWardHandover:first,verifyPreviousWardHandover:digest=>digest===first.digest};
  const next = prepareWardNightHandover(args);
  assert.equal(next.priority[0].bed_number,"18");
  const carried = next.priority[0].sbar_packet.carryover[0];
  assert.equal(carried.last_known_owner_id,"fixture-team");
  assert.equal(carried.closure_status,"unknown");
  assert.throws(()=>prepareWardNightHandover({...args,verifyPreviousWardHandover:()=>false}),/PREVIOUS_HANDOVER_UNVERIFIED/);
});

test("discharge template copies guarded sections and withholds disagreements across source documents", async () => {
  const { args, source } = dischargeFixture();
  const defined = (id, document_kind, text, extra = {}) => ({ id, document_kind, text, ...source.context, status: "final",
    version_id: "demo-v1", source_system: "EMR", timestamp: "2026-10-06T09:30:00Z", ...extra });
  const notes = [...source.notes,
    defined("demo-summary", "discharge_summary", "入院原因：合成资料甲\n住院经过：合成资料乙\n出院情况：合成资料丙\n出院诊断：合成条目甲\n手术及操作：无"),
    defined("demo-front", "front_sheet", "出院诊断：合成条目甲\n手术及操作：无"),
    defined("demo-settlement", "settlement_list", "出院诊断：合成条目乙\n手术及操作：无")];
  const snapshot = createPatientSourceSnapshot({ ...source, notes });
  const result = DischargeReadinessEngine.evaluateDischargeReadiness({ ...args, snapshot });
  const template = result.discharge_template;
  assert.equal(result.clinical_suitability.is_suitable_for_discharge, null);
  assert.equal(template.fields.hospital_course.value, "合成资料乙");
  const sourceRecord = snapshot.records.notes.find(entry => entry.record.id === "demo-summary").record;
  assert.equal(resolveTextAnchor(template.fields.hospital_course.evidence[0], sourceRecord).anchor_status, "verbatim_verified");
  assert.equal(template.comparisons.discharge_diagnoses.status, "recorded_text_differs");
  assert.equal(template.fields.discharge_diagnoses.value, null);
  assert.equal(template.document_sources.settlement_list.reference.source_id, "demo-settlement");
  assert.equal(template.comparisons.procedures.status, "recorded_text_agrees");
  assert.equal(template.fields.discharge_medications.items[0].evidence[0].source_id, "discharge-med");
  assert.match(template.fields.follow_up.items[0].value, /来源记录/);
  assert.match(template.copy_text, /住院经过\n合成资料乙/);
  assert.doesNotMatch(template.copy_text, /合成条目/);
  const future = defined("demo-settlement", "settlement_list", "出院诊断：合成条目甲", { version_id: "demo-v2", status: "corrected",
    updated_at: "2026-10-06T10:30:00Z" });
  const replay = DischargeReadinessEngine.evaluateDischargeReadiness({ ...args, snapshot: createPatientSourceSnapshot({ ...source, notes: [...notes, future] }) });
  assert.equal(replay.discharge_template.document_sources.settlement_list.reference.version_id, "demo-v1");

  const status = {};
  let clipboard;
  const ui = vm.createContext({ result, navigator: { clipboard: { async writeText(value) { clipboard = value; } } },
    sessionStorage: { getItem: () => null }, document: { addEventListener() {}, getElementById: () => status } });
  const html = readFileSync(new URL("../plugins/medcius/servers/api/src/ui/workstation.html", import.meta.url), "utf8");
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
  const rendered = ui.renderDischarge(result, { copyEnabled: true });
  assert.match(rendered, /复制模板字段/);
  assert.match(rendered, /<b>医保结算清单<\/b> · 合成条目乙/);
  await vm.runInContext("currentReport = { workflow: 'discharge-readiness', payload: result }; copyDischargeTemplate()", ui);
  assert.equal(clipboard, template.copy_text);
  assert.match(status.textContent, /已复制/);
});

function history(withSettlement = true) {
  const source = historicalInput();
  if (withSettlement) source.notes.push({ ...source.notes[0], document_kind: "settlement_list", id: "settlement-1",
    text: "结算清单\n入院日期：2026-10-01\n出院日期：2026-10-03\n出院诊断：合成基础病" });
  return source;
}

test("historical backtest separates failed coverage from findings and binds optional labels to the snapshot", () => {
  const source = history(), tenantId = source.context.tenant_id;
  const snapshot = createPatientSourceSnapshot(source);
  const reference = { snapshot_hash: snapshot.snapshot_id, findings: [{ section: "settlement_list", code: "DISCHARGE_METHOD_MISSING" }] };
  const result = backtestRecordQuality({ tenantId, policy, cases: [{ snapshot, reference }] });
  assert.equal(result.counts.reviewed, 1);
  assert.equal(result.reference_comparison.cases_compared, 1);
  assert.equal(result.reference_comparison.matched, 1);
  assert.ok(result.cases[0].findings.some(item => item.section === "evidence" && item.code === "DOCUMENTED_DIAGNOSIS_NOT_ON_FRONT_SHEET"));
  assert.equal(result.cases[0].documents.settlement_list.reference.source_id, "settlement-1");
  const changed = backtestRecordQuality({ tenantId, policy: { ...policy, conditions: [] }, cases: [{ snapshot, reference }] });
  assert.notEqual(changed.policy.sha256, result.policy.sha256);
  assert.equal(changed.cases[0].findings.some(item => item.section === "evidence"), false);
  const missing = backtestRecordQuality({ tenantId, policy, cases: [{ snapshot: createPatientSourceSnapshot(history(false)), reference }] });
  assert.equal(missing.counts.partially_reviewed, 1);
  assert.equal(missing.reference_comparison.matched, null);
  assert.throws(() => backtestRecordQuality({ tenantId: "foreign", policy, cases: [{ snapshot }] }), /SCOPE_MISMATCH/);
  assert.throws(() => backtestRecordQuality({ tenantId, policy, cases: [{ snapshot }, { snapshot }] }), /SCOPE_MISMATCH/);
});

test("backtest command emits a report without note text", () => {
  const source = history();
  const path = join(mkdtempSync(join(tmpdir(), "medcius-record-backtest-")), "cohort.json");
  writeFileSync(path, JSON.stringify({ tenant_id: source.context.tenant_id, policy, cases: [{ source }] }));
  const result = spawnSync(process.execPath, ["scripts/backtest-record-quality.mjs", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).counts.reviewed, 1);
  assert.doesNotMatch(result.stdout, /合成基础病|目前诊断/);
});

test("EMR fact packet keeps source anchors and negation, withholds orphan facts, and binds the cutoff", () => {
  const context = { ...member("fact"), doctor_id: "synthetic-doctor", as_of: "2026-10-05T08:00:00+08:00" };
  const dataFeeds = { patient: { id: context.patient_id, name: "合成姓名" }, encounter: { id: context.encounter_id },
    notes: [{ id: "note-negative", text: "病程记录：否认胸痛。", timestamp: "2026-10-04T20:00:00Z" }],
    his_orders: [{ id: "pending-source", title: "合成医嘱", status: "pending_execution", authored_on: "2026-10-04T22:00:00Z" }] };
  const result = HospitalAgentAdapter.executePreRoundWorkflow({ context, dataFeeds });
  const packet = HospitalAgentAdapter.buildPreRoundFactPack(result);
  const note = packet.facts.find(item => item.evidence.source_id === "note-negative");
  assert.equal(note.attributes.presence, "negative");
  assert.equal(note.verbatim, "否认胸痛");
  assert.equal(packet.context.as_of, "2026-10-05T00:00:00.000Z");
  assert.ok(packet.facts.every(item => ["verbatim_verified", "resource_linked", "sources_linked"].includes(item.evidence.anchor_status)));
  assert.equal(packet.writeback, false);
  assert.equal(JSON.stringify(packet).includes("合成姓名"), false);
  assert.throws(() => HospitalAgentAdapter.buildPreRoundFactPack(structuredClone(result)), /RESEARCH_SNAPSHOT_UNAVAILABLE/);
  const his = HospitalAgentAdapter.executePreRoundWorkflow({ host: HOST_TYPES.HIS_EMBED, context, dataFeeds });
  assert.throws(() => HospitalAgentAdapter.buildPreRoundFactPack(his), /ENGINEERING_ONLY/);
});
