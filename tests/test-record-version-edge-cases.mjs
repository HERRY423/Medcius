import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecordLifecycle, lifecycleFields, resolveRecordVersions } from "../plugins/medcius/lib/record-lifecycle.mjs";

const now = "2026-10-04T12:00:00Z";
const options = { sourceType: "observation", now, cutoffTime: "2026-10-03T12:00:00Z" };
const sample = (extra = {}) => ({ id: "lab-one", code: "k", name: "Synthetic potassium", status: "final", value: 4, unit: "mmol/L",
  effective_time: "2026-10-04T08:00:00Z", resulted_at: "2026-10-04T08:00:00Z", version_id: "v1", ...extra });
const resolve = (records) => resolveRecordVersions(records, options);

test("future source updates cannot replace the current result even when occurrence and issue times are old", () => {
  const resolved = resolve([sample(), sample({ version_id: "v2", value: 8, updated_at: "2026-10-05T08:00:00Z" })]);
  assert.deepEqual(resolved.current_records.map((record) => record.value), [4]);
  assert.equal(resolved.entries.find((entry) => entry.record.version_id === "v2").selection_status, "future");
});

test("a single future-updated resource has no current version", () => {
  const resolved = resolve([sample({ meta: { lastUpdated: "2026-10-05T08:00:00Z" } })]);
  assert.equal(resolved.current_records.length, 0);
  assert.equal(resolved.entries[0].selection_status, "future");
});

test("a reused version with changed reference bounds is a preserved conflict", () => {
  for (const pair of [
    [sample({ ref_high: 5 }), sample({ ref_high: 3 })],
    [sample({ referenceRange: [{ low: { value: 3 }, high: { value: 5 } }] }), sample({ referenceRange: [{ low: { value: 3 }, high: { value: 3.5 } }] })],
    [sample({ reference_range_text: "3–5" }), sample({ reference_range_text: "3–3.5" })],
  ]) {
    const resolved = resolve(pair);
    assert.equal(resolved.entries.length, 2);
    assert.equal(resolved.current_records.length, 0);
    assert.ok(resolved.entries.every((entry) => entry.selection_reasons.includes("SAME_VERSION_CONTENT_CONFLICT")));
  }
});

test("clinical flags, codes, doses, and routes cannot be erased by deduplication", () => {
  for (const [before, after] of [
    [{ is_critical: false }, { is_critical: true }],
    [{ code: "k" }, { code: "na" }],
    [{ dosage: "1g" }, { dosage: "2g" }],
    [{ route: "po" }, { route: "iv" }],
    [{ frequency: "qd" }, { frequency: "bid" }],
    [{ patient_id: "patient-one" }, { patient_id: "patient-two" }],
  ]) {
    const resolved = resolve([sample(before), sample({ ...after, updated_at: "2026-10-04T10:00:00Z" })]);
    assert.equal(resolved.entries.length, 2);
    assert.equal(resolved.current_records.length, 0);
  }
});

test("equivalent raw and normalized aliases deduplicate without discarding their source representations", () => {
  const raw = sample({ value: undefined, result_value: "4", effective_time: undefined, sample_time: "2026-10-04T08:00:00Z", ref_low: 3, ref_high: 5, is_critical_reported: true });
  const normalized = sample({ referenceRange: [{ low: { value: 3 }, high: { value: 5 } }], is_critical: true });
  const resolved = resolve([raw, normalized]);
  assert.equal(resolved.entries.length, 1);
  assert.equal(resolved.current_records.length, 1);
  assert.equal(resolved.entries[0].source_records.length, 2);
});

test("every permutation of a replacement chain has exactly the same current resource", () => {
  const a = sample({ id: "a" });
  const b = sample({ id: "b", status: "corrected", version_id: "v2", value: 5, supersedes_id: "a", updated_at: "2026-10-04T09:00:00Z" });
  const c = sample({ id: "c", status: "corrected", version_id: "v3", value: 6, supersedes_id: "b", updated_at: "2026-10-04T10:00:00Z" });
  for (const records of [[a,b,c], [a,c,b], [b,a,c], [b,c,a], [c,a,b], [c,b,a]]) {
    const resolved = resolve(records);
    assert.deepEqual(resolved.current_records.map((record) => record.id), ["c"]);
    assert.equal(resolved.entries.length, 3);
    assert.equal(resolved.entries.filter((entry) => entry.selection_status === "superseded").length, 2);
  }
});

test("replacement cycles and links that contradict source time stay unknown", () => {
  const a = sample({ id: "a", supersedes_id: "b" });
  const b = sample({ id: "b", supersedes_id: "a", version_id: "v2" });
  const cycle = resolve([a,b]);
  assert.equal(cycle.current_records.length, 0);
  assert.ok(cycle.entries.every((entry) => entry.selection_reasons.includes("CYCLIC_VERSION_RELATION")));
  const contradiction = resolve([sample({ id: "a", updated_at: "2026-10-04T11:00:00Z" }),
    sample({ id: "b", supersedes_id: "a", status: "corrected", version_id: "v2", updated_at: "2026-10-04T10:00:00Z" })]);
  assert.equal(contradiction.current_records.length, 0);
  assert.ok(contradiction.entries.every((entry) => entry.selection_reasons.includes("VERSION_TIME_RELATION_CONFLICT")));
});

test("version identifiers do not supply an ordering", () => {
  const resolved = resolve([sample({ version_id: "999" }), sample({ value: 8, version_id: "1000" })]);
  assert.equal(resolved.current_records.length, 0);
  assert.ok(resolved.entries.every((entry) => entry.selection_status === "conflict"));
});

test("different sources and independent measurements stay distinct", () => {
  const resolved = resolve([sample({ id: "a", source_system: "one" }), sample({ id: "b", source_system: "one" }),
    sample({ id: "c", supersedes_id: "a", source_system: "two" })]);
  assert.equal(resolved.current_records.length, 3);
});

test("end and change times survive normalization and describe cancellation", () => {
  const fields = { end_date: "2026-10-04T10:00:00Z", changed_at: "2026-10-04T10:00:00Z", start_time: "2026-10-01T08:00:00Z",
    stopped_at: "2026-10-04T10:00:00Z", study_time: "2026-10-03T08:00:00Z", issued: "2026-10-04T09:00:00Z" };
  assert.deepEqual(lifecycleFields(fields), fields);
  const state = classifyRecordLifecycle({ id: "med", status: "stopped", ...fields, study_time: undefined }, { sourceType: "medication", now });
  assert.equal(state.change_time, "2026-10-04T10:00:00Z");
  assert.equal(state.change_type, "cancellation");
  assert.equal(state.event_time, "2026-10-01T08:00:00Z");
});

test("received-at and event time remain separate for late historical records", () => {
  const state = classifyRecordLifecycle(sample({ effective_time: "2026-10-01T08:00:00Z", resulted_at: "2026-10-01T09:00:00Z", recorded_at: "2026-10-04T10:00:00Z" }), options);
  assert.equal(state.event_time_status, "historical");
  assert.equal(state.arrival_status, "late_record");
  assert.equal(state.change_time, "2026-10-01T09:00:00Z");
});

test("initial finalization after a preliminary result is not mislabeled as correction of a prior final result", () => {
  const resolved = resolve([sample({ status: "preliminary" }), sample({ version_id: "v2", resulted_at: "2026-10-04T10:00:00Z" })]);
  const current = resolved.entries.find((entry) => entry.is_current);
  assert.equal(current.record.status, "final");
  assert.equal(current.lifecycle.change_type, "new_result");
});

test("a valid acknowledgement can resolve otherwise identical snapshots of the same version", () => {
  const before = sample({ acknowledged_at: null });
  const after = sample({ acknowledged_at: "2026-10-04T10:00:00Z", acknowledged_version_id: "v1" });
  for (const records of [[before, after], [after, before]]) {
    const resolved = resolve(records);
    assert.equal(resolved.entries.length, 2);
    assert.equal(resolved.current_records.length, 1);
    assert.equal(resolved.current_records[0].acknowledged_at, after.acknowledged_at);
    assert.equal(resolved.entries.flatMap((entry) => entry.source_records).length, 2);
  }
});

test("an acknowledgement targeting another version cannot resolve an unchanged-version tie", () => {
  const resolved = resolve([sample({ acknowledged_at: null }),
    sample({ acknowledged_at: "2026-10-04T10:00:00Z", acknowledged_version_id: "v0" })]);
  assert.equal(resolved.current_records.length, 0);
  assert.equal(resolved.entries.length, 2);
  assert.ok(resolved.entries.every((entry) => entry.selection_status === "conflict"));
});

test("a future acknowledgement cannot resolve an unchanged-version tie", () => {
  const resolved = resolve([sample({ acknowledged_at: null }),
    sample({ acknowledged_at: "2026-10-05T10:00:00Z", acknowledged_version_id: "v1" })]);
  assert.equal(resolved.current_records.length, 0);
  assert.equal(resolved.entries.length, 2);
  assert.ok(resolved.entries.every((entry) => entry.selection_status === "conflict"));
});
