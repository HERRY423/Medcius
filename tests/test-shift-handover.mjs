import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ShiftHandoverEngine as Engine, SHIFT_TYPES } from "../plugins/medcius/lib/shift-handover-engine.mjs";
import { HospitalAgentAdapter, HOST_TYPES } from "../plugins/medcius/lib/hospital-agent-adapter.mjs";
import { ConsultPreparationEngine } from "../plugins/medcius/lib/consult-preparation-engine.mjs";
import { canonicalJson, sha256Hex } from "../plugins/medcius/servers/shared/crypto.mjs";
import { getCardiologyMultiSourceFeeds } from "../plugins/medcius/servers/fhir/sandbox/hospital-cardiology-sandbox.mjs";

const context = { tenant_id: "fixture-hospital", patient_id: "fixture-patient", encounter_id: "fixture-encounter" };
const asOf = "2026-10-06T10:00:00Z", windowStart = "2026-10-06T00:00:00Z", eventsAsOf = "2026-10-06T12:00:00Z";
const session = { handover_id: "handover-1", outgoing_doctor_id: "doctor-out", incoming_doctor_id: "doctor-in" };
const lab = { id: "lab-1", name: "血钾", code: "k", value: 2.5, unit: "mmol/L", is_critical: true, status: "final", version_id: "v1", effective_time: "2026-10-06T09:00:00Z", issued: "2026-10-06T09:10:00Z" };
const source = { context, asOf, patient: { id: context.patient_id, bed_number: "01床", primary_diagnosis: "心肌梗死" }, encounter: { id: context.encounter_id },
  observations: [lab], notes: [{ id: "note-1", timestamp: "2026-10-06T08:00:00Z", text: "来源病程记录。" }],
  nursing: [{ id: "nurse-1", timestamp: "2026-10-06T09:00:00Z", urine_output_ml: 0 }],
  orders: [{ id: "order-1", title: "已开立复查医嘱", status: "active", authored_on: "2026-10-06T09:00:00Z" }],
  sourceAvailability: [{ kind: "lis", status: "available" }] };
const snapshot = Engine.createSnapshot(source);
const fixtureSecret = "synthetic-test-signing-key-only";
const signature = event => createHmac("sha256", fixtureSecret).update(canonicalJson(event)).digest("hex");
const sign = event => { const body = { ...event, signature_algorithm: "HMAC_SHA256" }; return { ...body, signature: signature(body) }; };
const verify = ({ signature: sig, ...event }) => sig === signature(event);
const event = (id, type, at, extra = {}) => sign({ ...context, handover_id: session.handover_id, event_id: id, type, occurred_at: `2026-10-06T${at}:00Z`,
  actor_id: ["transfer_accepted", "transfer_declined", "acceptance_revoked"].includes(type) ? session.incoming_doctor_id : session.outgoing_doctor_id, ...extra });
const prepare = (events = [], extra = {}) => Engine.analyzePatientHandover({ snapshot, windowStart, eventsAsOf, handoverContext: session,
  handoverEvents: events, verifyHandoverEvent: verify, ...extra });
const blank = prepare();
assert.equal(blank.responsibility.status, "not_proposed");
assert.equal(blank.sbar.situation.care_level, null);
assert.equal(blank.sbar.situation.acuity_status, "unknown");
assert.equal(blank.sbar.assessment.fluid_balance_status, "unknown");
assert.equal(blank.sbar.recommendation.contingency_plans.length, 0);
assert.equal(blank.sbar.assessment.nursing_records[0].record.urine_output_ml, 0);
assert.equal(blank.sbar.recommendation.scheduled_follow_ups[0].scheduled_time, null);
assert.equal(blank.high_risk_followup.counts.open, 1);
assert.ok(blank.record_changes.some(c => c.evidence.source_id === "lab-1"));
assert.ok(blank.record_changes.every(c => c.is_new_since_previous === null));
assert.ok(!Engine.generateHandoverText({ handoverData: blank }).includes("整体平稳"));
assert.ok(!Engine.generateHandoverText({ handoverData: blank }).includes("胸痛应急"));
assert.ok(!Engine.generateHandoverText({ handoverData: blank }).includes("签字确认"));
const plan = event("plan-event-1", "plan_recorded", "10:01", { plan_id: "plan-1", trigger_text: "收到补充报告时", action_text: "请核对原始报告，并联系交班医师澄清记录中的问题。" });
const planned = prepare([plan]);
assert.equal(planned.sbar.recommendation.contingency_plans[0].action_text, plan.action_text);
assert.equal(planned.sbar.recommendation.contingency_plans[0].evidence.source_id, plan.event_id);
assert.notEqual(planned.packet_digest, blank.packet_digest);
const offer = event("offer-1", "transfer_proposed", "10:02", { packet_digest: planned.packet_digest });
const accept = event("accept-1", "transfer_accepted", "10:03", { packet_digest: planned.packet_digest, target_event_id: offer.event_id });
assert.equal(prepare([plan, offer]).responsibility.status, "awaiting_acceptance");
const accepted = prepare([plan, offer, accept]);
assert.equal(accepted.responsibility.status, "accepted_in_source");
assert.equal(accepted.responsibility.reported_responsible_doctor_id, session.incoming_doctor_id);
assert.equal(accepted.responsibility.current_responsible_doctor_id, null, "individual signatures do not prove history completeness");
assert.equal(accepted.responsibility.clinical_tasks_completed, false);
assert.equal(accepted.high_risk_followup.counts.open, planned.high_risk_followup.counts.open);
assert.equal(accepted.packet_digest, planned.packet_digest, "responsibility events do not rewrite the clinical packet");
assert.deepEqual(prepare([accept, plan, offer, accept]), accepted, "input order and duplicate deliveries must not change state");
const plan2 = event("plan-event-2", "plan_recorded", "10:04", { plan_id: "plan-1", supersedes_event_id: plan.event_id, action_text: "先核对报告标识，再联系交班医师。" });
assert.equal(prepare([plan, offer, accept, plan2]).responsibility.status, "requires_reconfirmation");
const updatedSnapshot = Engine.createSnapshot({ ...source, observations: [{ ...lab, value: 2.7 }] });
assert.equal(prepare([plan, offer, accept], { snapshot: updatedSnapshot }).responsibility.status, "requires_reconfirmation");
const revoke = event("revoke-1", "acceptance_revoked", "10:04", { packet_digest: planned.packet_digest, target_event_id: accept.event_id });
assert.equal(prepare([plan, offer, accept, revoke]).responsibility.status, "acceptance_revoked");
assert.equal(prepare([plan, offer, accept, revoke]).responsibility.reported_responsible_doctor_id, null);
const decline = event("decline-1", "transfer_declined", "10:04", { packet_digest: planned.packet_digest, target_event_id: offer.event_id });
assert.equal(prepare([plan, offer, decline]).responsibility.status, "declined");
const withdraw = event("withdraw-1", "transfer_withdrawn", "10:04", { packet_digest: planned.packet_digest, target_event_id: offer.event_id });
assert.equal(prepare([plan, offer, withdraw]).responsibility.status, "withdrawn");
const planWithdraw = event("plan-withdraw", "plan_withdrawn", "10:04", { plan_id: "plan-1", supersedes_event_id: plan.event_id });
assert.equal(prepare([plan, planWithdraw]).sbar.recommendation.contingency_plans.length, 0);
// Explicitly sign malicious variants to test semantic validation independently of signatures.
for (const patch of [{ actor_id: session.outgoing_doctor_id }, { target_event_id: "wrong" }, { patient_id: "wrong" }, { tenant_id: "wrong" },
  { encounter_id: "wrong" }, { handover_id: "wrong" }, { occurred_at: "2026-10-06T13:00:00Z" }]) {
  const { signature: _sig, ...raw } = accept;
  assert.throws(() => prepare([plan, offer, sign({ ...raw, ...patch })]), /FAIL_CLOSED/);
}
assert.throws(() => prepare([plan], { verifyHandoverEvent: undefined }), /verifier required/);
assert.throws(() => prepare([{ ...plan, action_text: "tampered", verified: true }]), /verification failed/);
assert.throws(() => prepare([accept]), /predecessor/);
assert.throws(() => prepare([plan, offer, decline, accept]), /pending|ordering/);
assert.throws(() => prepare([event("phi", "plan_recorded", "10:01", { plan_id: "p", action_text: "电话 13800138000" })]), /PHI/);
const conflictId = event(plan.event_id, "plan_recorded", "10:05", { plan_id: "plan-1", action_text: "不同内容" });
assert.throws(() => prepare([plan, conflictId]), /ID reused/);
assert.throws(() => prepare([], { windowStart: null }), /window/);
assert.throws(() => prepare([], { shiftType: "made-up" }), /shift type/);
assert.throws(() => Engine.createSnapshot({ ...source, encounter: { id: "wrong" } }), /mismatch/);
const corrected = Engine.createSnapshot({ ...source, observations: [lab, { ...lab, version_id: "v2", status: "corrected", updated_at: "2026-10-06T09:40:00Z", value: 4.1, is_critical: false }] });
assert.equal(prepare([], { snapshot: corrected }).sbar.assessment.critical_values.length, 0);
assert.ok(prepare([], { snapshot: corrected }).record_changes.some(c => c.lifecycle.change_type === "revision"));
const ackConflict = Engine.createSnapshot({ ...source, observations: [{ ...lab, acknowledged: false, acknowledged_at: "2026-10-06T09:30:00Z", acknowledged_version_id: "v1" }] });
const conflicting = prepare([], { snapshot: ackConflict });
assert.notEqual(conflicting.high_risk_followup.items[0].closure_status, "closed");
const future = Engine.createSnapshot({ ...source, observations: [{ ...lab, effective_time: "2026-10-06T11:00:00Z" }] });
assert.equal(prepare([], { snapshot: future }).sbar.assessment.critical_values.length, 0);
const consult = ConsultPreparationEngine.prepareConsultDossier({ snapshot, consultRequest: { department: "肾内科", purpose: "整理血钾" } });
assert.equal(consult.snapshot_id, blank.snapshot_id, "consultation and handover share the exact same source snapshot");
const bed = getCardiologyMultiSourceFeeds()[0];
const adapted = HospitalAgentAdapter.executeShiftHandoverWorkflow({ context: { tenant_id: "sandbox", doctor_id: "fixture-doctor", patient_id: bed.patient.id, encounter_id: bed.encounter.id }, dataFeeds: bed });
assert.equal(adapted.success, true);
assert.equal(adapted.handover.responsibility.status, "not_proposed");
assert.ok(adapted.provenance.envelope_sha256);
assert.throws(() => HospitalAgentAdapter.executeShiftHandoverWorkflow({ host: HOST_TYPES.HIS_EMBED,
  context: { ...context, doctor_id: "fixture-doctor" }, dataFeeds: {} }), /FROZEN|FORBIDDEN|not enabled/i);
console.log("Handover: source snapshot, no invented plans, signed event replay, responsibility transitions, stale confirmations and independent clinical follow-up passed.");

const html = readFileSync(new URL("../plugins/medcius/servers/api/src/ui/workstation.html", import.meta.url), "utf8");
const ui = vm.createContext({ sessionStorage: { getItem: () => null } });
vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
const hostile = structuredClone(accepted);
hostile.sbar.recommendation.contingency_plans[0].action_text = '<img src=x onerror="alert(1)">';
const rendered = ui.renderHandover(hostile);
assert.ok(rendered.includes("来源记录显示接班人已确认此资料包"));
assert.ok(rendered.includes("查看原始依据"));
assert.ok(rendered.includes("&lt;img"));
assert.ok(!rendered.includes('<img src=x'));
assert.ok(!ui.renderHandover(blank).includes("来源记录显示接班人已确认"));

const completePlanned = prepare([plan], { verifyHandoverHistory: () => true });
const completeOffer = event("complete-offer", "transfer_proposed", "10:02", { packet_digest: completePlanned.packet_digest });
const completeAccept = event("complete-accept", "transfer_accepted", "10:03", { packet_digest: completePlanned.packet_digest, target_event_id: completeOffer.event_id });
const fullHistory = [plan, completeOffer, completeAccept];
const attestHistory = envelope => envelope.history_digest === sha256Hex(canonicalJson(fullHistory)) && envelope.events_as_of === eventsAsOf;
const complete = prepare(fullHistory, { verifyHandoverHistory: attestHistory });
assert.equal(complete.responsibility.current_responsible_doctor_id, session.incoming_doctor_id);
const completeRevoke = event("complete-revoke", "acceptance_revoked", "10:04", { packet_digest: completePlanned.packet_digest, target_event_id: completeAccept.event_id });
const latestHistory = [...fullHistory, completeRevoke];
const attestLatest = envelope => envelope.history_digest === sha256Hex(canonicalJson(latestHistory));
const omittedRevocation = prepare(fullHistory, { verifyHandoverHistory: attestLatest });
assert.equal(omittedRevocation.responsibility.event_history_completeness, "unknown");
assert.equal(omittedRevocation.responsibility.current_responsible_doctor_id, null, "omitting a signed revocation must not prove current responsibility");
const unchangedFinalStatus = Engine.createSnapshot({ ...source, observations: [{ ...lab, version_id: null },
  { ...lab, version_id: null, value: 2.7, updated_at: "2026-10-06T09:40:00Z", acknowledged: true, acknowledged_at: "2026-10-06T09:45:00Z" }] });
const inferredRevision = prepare([], { snapshot: unchangedFinalStatus });
assert.ok(inferredRevision.record_changes.some(c => c.lifecycle.change_type === "revision"));
assert.notEqual(inferredRevision.high_risk_followup.items[0].closure_status, "closed", "resolver-inferred revisions retain acknowledgement binding requirements");
