import assert from "node:assert/strict";
import test from "node:test";
import { trackHighRiskFollowup } from "../plugins/medcius/lib/high-risk-followup-tracker.mjs";

const now = "2026-10-04T12:00:00Z";
const rulePack = {
  pack_id: "synthetic-lifecycle", version: "1", data_class: "synthetic",
  clinical_rules: { followup: [{
    rule_id: "source-critical", kind: "laboratory", match: { explicit_critical: true },
    required_stages: ["ordered", "resulted", "acknowledged"],
    due_minutes: { ordered: 30, resulted: 30, preliminary: 30, cancelled: 30, unknown: 30 },
  }] },
};
const result = (extra = {}) => ({
  id: "result-1", order_id: "order-1", code: "k", name: "Synthetic potassium",
  status: "final", value: 2.5, unit: "mmol/L", is_critical: true,
  resulted_at: "2026-10-04T08:00:00Z", version_id: "v1", ...extra,
});
const track = (observations, options = {}) => trackHighRiskFollowup({ observations, now, rulePack, ...options });
const item = (observations, options = {}) => track(observations, options).items[0];

test("a final result remains open until that result is acknowledged", () => {
  const pending = item([result()]);
  assert.equal(pending.stage, "resulted");
  assert.equal(pending.result_status, "final");
  assert.equal(pending.review_status, "pending");
  assert.equal(pending.closure_status, "open");
  assert.equal(pending.overdue, true);
  const closed = track([result({ acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" })]);
  assert.equal(closed.items[0].review_status, "acknowledged");
  assert.equal(closed.items[0].closure_status, "closed");
  assert.equal(closed.counts.open, 0);
});

test("a correction reopens the result even when its preceding version was acknowledged", () => {
  const corrected = item([
    result({ acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" }),
    result({ status: "corrected", version_id: "v2", value: 4.0, updated_at: "2026-10-04T10:00:00Z" }),
  ]);
  assert.equal(corrected.stage, "resulted");
  assert.equal(corrected.result_status, "revised");
  assert.equal(corrected.change_type, "revision");
  assert.equal(corrected.review_status, "pending");
  assert.equal(corrected.closure_status, "open");
  assert.equal(corrected.stage_timestamp, "2026-10-04T10:00:00Z");
  assert.equal(corrected.evidence.length, 2);
});

test("a copied old acknowledgement cannot close a new version", () => {
  const staleAck = item([result({ status: "amended", version_id: "v2", updated_at: "2026-10-04T10:00:00Z", acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" })]);
  assert.equal(staleAck.review_status, "pending");
  assert.equal(staleAck.closure_status, "open");
  assert.notEqual(staleAck.stage, "acknowledged");
});

test("later timestamps alone do not rescue an acknowledgement bound to another version", () => {
  const staleAck = item([result({ version_id: "v2", updated_at: "2026-10-04T10:00:00Z", acknowledged_at: "2026-10-04T11:00:00Z", acknowledged_version_id: "v1" })]);
  assert.equal(staleAck.review_status, "pending");
  assert.equal(staleAck.closure_status, "open");
});

test("acknowledged booleans and unbound acknowledgement times do not manufacture closure", () => {
  for (const record of [
    result({ acknowledged: true }),
    result({ resulted_at: null, acknowledged_at: "2026-10-04T10:00:00Z" }),
    result({ acknowledged_at: "2026-10-04T13:00:00Z" }),
  ]) {
    const tracked = item([record]);
    assert.notEqual(tracked.closure_status, "closed");
    assert.notEqual(tracked.stage, "acknowledged");
  }
});

test("cancelled and entered-in-error states supersede older acknowledged finals without becoming complete", () => {
  for (const status of ["cancelled", "revoked", "entered-in-error"]) {
    const tracked = track([
      result({ acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" }),
      result({ status, version_id: "v2", updated_at: "2026-10-04T10:00:00Z" }),
    ]);
    assert.equal(tracked.items[0].stage, status === "entered-in-error" ? "entered_in_error" : "cancelled");
    assert.equal(tracked.items[0].closure_status, "requires_reconciliation");
    assert.equal(tracked.items[0].overdue, null);
    assert.equal(tracked.counts.open, 1);
    assert.equal(tracked.counts.acknowledged, 0);
  }
});

test("order cancellation does not erase prior result evidence or count as complete", () => {
  const cancelled = track([result({ acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" })], {
    orders: [{ id: "order-1", status: "cancelled", cancelled_at: "2026-10-04T10:00:00Z", version_id: "o2" }],
  });
  assert.equal(cancelled.items[0].stage, "cancelled");
  assert.equal(cancelled.items[0].result_status, "final");
  assert.equal(cancelled.items[0].closure_status, "requires_reconciliation");
  assert.equal(cancelled.items[0].evidence.length, 2);
});

test("an absent or unrecognized result status stays unknown, even when a timestamp exists", () => {
  for (const status of [null, "", "unknown", "unrecognized-code"]) {
    const unknown = item([result({ status })]);
    assert.equal(unknown.stage, "unknown");
    assert.equal(unknown.result_status, "unknown");
    assert.equal(unknown.closure_status, "unknown");
    assert.equal(unknown.overdue, null);
    assert.notEqual(unknown.gap, null);
  }
});

test("unknown or future result times cannot produce overdue or current-state closure", () => {
  for (const resulted_at of [null, "bad-time", "2026-10-05T00:00:00Z"]) {
    const unknown = item([result({ resulted_at })]);
    assert.equal(unknown.overdue, null);
    assert.equal(unknown.closure_status, "unknown");
  }
});

test("contradictory versions with no proven ordering remain unknown rather than array-order selected", () => {
  const records = [result(), result({ status: "corrected", version_id: "v2", value: 4.0 })];
  for (const order of [records, [...records].reverse()]) {
    const conflict = item(order);
    assert.equal(conflict.stage, "unknown");
    assert.equal(conflict.closure_status, "unknown");
    assert.equal(conflict.overdue, null);
    assert.equal(conflict.evidence.length, 2);
    assert.ok(conflict.uncertainty_reasons.length > 0);
  }
});

test("conflicting payloads under the same source version are not silently superseded", () => {
  const conflict = item([result(), result({ value: 4.0, updated_at: "2026-10-04T10:00:00Z" })]);
  assert.equal(conflict.closure_status, "unknown");
  assert.equal(conflict.overdue, null);
});

test("independent results under one order all need acknowledgement", () => {
  const multiple = item([
    result({ acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" }),
    result({ id: "result-2", resulted_at: "2026-10-04T10:00:00Z" }),
  ]);
  assert.equal(multiple.stage, "resulted");
  assert.equal(multiple.review_status, "partially_acknowledged");
  assert.equal(multiple.closure_status, "open");
  assert.equal(multiple.record_states.length, 2);
});

test("later acknowledged results do not hide earlier unacknowledged results", () => {
  const multiple = item([
    result(),
    result({ id: "result-2", resulted_at: "2026-10-04T10:00:00Z", acknowledged_at: "2026-10-04T10:05:00Z", acknowledged_version_id: "v1" }),
  ]);
  assert.equal(multiple.closure_status, "open");
  assert.equal(multiple.review_status, "partially_acknowledged");
  assert.equal(multiple.stage_timestamp, "2026-10-04T08:00:00Z");
});

test("an acknowledgement on the parent order cannot acknowledge its result", () => {
  const pending = item([result()], { orders: [{ id: "order-1", status: "completed", authored_on: "2026-10-04T07:00:00Z", acknowledged_at: "2026-10-04T10:00:00Z" }] });
  assert.equal(pending.review_status, "pending");
  assert.equal(pending.closure_status, "open");
});

test("late-arriving historical results retain event time and are not a current new result", () => {
  const late = item([result({
    event_time: "2026-10-01T08:00:00Z", resulted_at: "2026-10-01T08:00:00Z", recorded_at: "2026-10-04T10:00:00Z",
  })], { cutoffTime: "2026-10-03T12:00:00Z" });
  assert.equal(late.arrival_status, "late_record");
  assert.equal(late.stage_timestamp, "2026-10-01T08:00:00Z");
  assert.equal(late.current_window_event, false);
  assert.equal(late.closure_status, "open");
});

test("an unavailable result interface makes closure and overdue unknown", () => {
  const unavailable = track([result({ acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" })], {
    unavailableSources: [{ kind: "lis", connector_id: "synthetic-lis", error: "TIMEOUT" }],
  });
  assert.equal(unavailable.items[0].availability_status, "unavailable");
  assert.equal(unavailable.items[0].closure_status, "unknown");
  assert.equal(unavailable.items[0].overdue, null);
  assert.equal(unavailable.counts.open, 1);
  assert.equal(unavailable.interpretation, "unknown_due_to_unavailable_sources");
});

test("empty data from an unavailable interface cannot mean no outstanding items", () => {
  const unavailable = track([], { unavailableSources: [{ kind: "lis", connector_id: "synthetic-lis", error: "TIMEOUT" }] });
  assert.equal(unavailable.interpretation, "unknown_due_to_unavailable_sources");
  assert.equal(unavailable.availability_status, "unavailable");
  assert.equal(unavailable.counts.total, 0);
  assert.equal(unavailable.counts.complete_for_available_sources, false);
});

test("source IDs and independent event/reception times survive into evidence", () => {
  const tracked = item([result({ event_time: "2026-10-04T08:00:00Z", recorded_at: "2026-10-04T10:00:00Z", _source: { system: "synthetic-lis" } })]);
  assert.equal(tracked.evidence[0].source_id, "result-1");
  assert.equal(tracked.evidence[0].source_version, "v1");
  assert.equal(tracked.evidence[0].event_time, "2026-10-04T08:00:00Z");
  assert.equal(tracked.evidence[0].recorded_at, "2026-10-04T10:00:00Z");
});

test("a revised result can close only with an acknowledgement bound to that revision", () => {
  const revised = result({ status: "corrected", version_id: "v2", updated_at: "2026-10-04T10:00:00Z", acknowledged_at: "2026-10-04T10:05:00Z" });
  const unbound = item([revised]);
  assert.equal(unbound.review_status, "unknown");
  assert.equal(unbound.closure_status, "open");
  assert.equal(unbound.gap, "PENDING_REVISED_RESULT_ACKNOWLEDGEMENT");
  const bound = item([{ ...revised, acknowledged_version_id: "v2" }]);
  assert.equal(bound.review_status, "acknowledged");
  assert.equal(bound.closure_status, "closed");
});

test("new versions with retained final status reopen changed content using source update time", () => {
  const revised = item([
    result({ acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" }),
    result({ version_id: "opaque-id-a", value: 4, updated_at: "2026-10-04T10:00:00Z", acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" }),
  ]);
  assert.equal(revised.result_status, "revised");
  assert.equal(revised.change_type, "revision");
  assert.equal(revised.stage_timestamp, "2026-10-04T10:00:00Z");
  assert.equal(revised.closure_status, "open");
});

test("explicit replacement identity does not leave the superseded value current", () => {
  const replaced = item([
    result({ acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" }),
    result({ id: "replacement-1", status: "corrected", supersedes_id: "result-1", supersedes_version_id: "v1", version_id: "v2", value: 4, updated_at: "2026-10-04T10:00:00Z" }),
  ]);
  assert.equal(replaced.record_states.length, 1);
  assert.equal(replaced.record_states[0].source_id, "replacement-1");
  assert.equal(replaced.evidence.length, 2);
  assert.equal(replaced.closure_status, "open");
});

test("a future receipt cannot be used to assert known state at an earlier as-of time", () => {
  const future = item([result({ recorded_at: "2026-10-05T10:00:00Z", acknowledged_at: "2026-10-04T10:05:00Z", acknowledged_version_id: "v1" })]);
  assert.equal(future.closure_status, "unknown");
  assert.equal(future.overdue, null);
  assert.ok(future.uncertainty_reasons.includes("RECORD_RECEIVED_OUTSIDE_AS_OF"));
});

test("unknown source availability remains distinct from an available empty response", () => {
  const unknown = track([], { sourceAvailability: [{ kind: "lis", status: "unknown", reason_code: "NOT_CONFIGURED" }] });
  assert.equal(unknown.availability_status, "unknown");
  assert.equal(unknown.counts.complete_for_available_sources, false);
  const availableEmpty = track([], { sourceAvailability: [{ kind: "lis", status: "available_empty", record_count: 0 }] });
  assert.equal(availableEmpty.availability_status, "available");
  assert.equal(availableEmpty.interpretation, "none_identified_from_available_rules_and_sources");
  assert.equal(availableEmpty.counts.complete_for_available_sources, true);
});

test("an unrelated unavailable interface does not invalidate a known result review", () => {
  const known = track([result({ acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" })], {
    sourceAvailability: [{ kind: "lis", status: "available" }, { kind: "financial_access", status: "unavailable" }],
  });
  assert.equal(known.items[0].closure_status, "closed");
  assert.equal(known.availability_status, "available");
});

test("null or missing deadlines never become a zero-minute overdue rule", () => {
  for (const deadline of [null, "", false, undefined]) {
    const noDue = item([result()], { rulePack: { ...rulePack, clinical_rules: { followup: [{ ...rulePack.clinical_rules.followup[0], due_minutes: { resulted: deadline } }] } } });
    assert.equal(noDue.overdue, null);
    assert.equal(noDue.due_minutes, null);
  }
});

test("source resource identity links revised HL7 messages while retaining both message citations", () => {
  const revised = item([
    result({ id: "hl7-msg-one", source_record_id: "stable-obx-id", acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" }),
    result({ id: "hl7-msg-two", source_record_id: "stable-obx-id", status: "corrected", version_id: "v2", updated_at: "2026-10-04T10:00:00Z" }),
  ]);
  assert.equal(revised.record_states.length, 1);
  assert.equal(revised.record_states[0].record_identity, "stable-obx-id");
  assert.equal(revised.record_states[0].source_id, "hl7-msg-two");
  assert.equal(revised.result_status, "revised");
  assert.equal(revised.closure_status, "open");
  assert.deepEqual(revised.evidence.map((source) => source.source_id), ["hl7-msg-one", "hl7-msg-two"]);
});

test("first finalization after a preliminary result is a new result with its own review", () => {
  const preliminary = result({ status: "preliminary", acknowledged_at: "2026-10-04T08:05:00Z", acknowledged_version_id: "v1" });
  const firstFinal = result({ status: "final", version_id: "v2", resulted_at: "2026-10-04T10:00:00Z" });
  const pending = item([preliminary, firstFinal]);
  assert.equal(pending.result_status, "final");
  assert.equal(pending.change_type, "new_result");
  assert.equal(pending.review_status, "pending");
  assert.equal(pending.gap, "PENDING_CLINICIAN_ACKNOWLEDGEMENT");
  const acknowledged = item([preliminary, { ...firstFinal, acknowledged_at: "2026-10-04T10:05:00Z", acknowledged_version_id: "v2" }]);
  assert.equal(acknowledged.closure_status, "closed");
  assert.equal(acknowledged.change_type, "new_result");
});
