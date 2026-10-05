import test from "node:test";
import assert from "node:assert/strict";
import { ReadOnlyHospitalDataBridge } from "../plugins/medcius/lib/read-only-hospital-data-bridge.mjs";
import { createFhirR4Connectors } from "../plugins/medcius/lib/connectors/fhir-r4-connector.mjs";
import { createViewLibraryConnectors } from "../plugins/medcius/lib/connectors/view-library-connector.mjs";
import { createViewDbConnector, VIEWDB_ROW_MAPPERS } from "../plugins/medcius/lib/connectors/viewdb-connector.mjs";
import { createCdaDocumentConnector } from "../plugins/medcius/lib/connectors/cda-document-connector.mjs";
import { createHl7v2Connectors, mapOruObservations, mapRdeMedicationOrders, parseHl7v2Message } from "../plugins/medcius/lib/connectors/hl7v2-connector.mjs";

const context = { tenant_id: "tenant-synthetic", doctor_id: "doctor-synthetic", patient_id: "patient-synthetic", encounter_id: "encounter-synthetic" };
const oldTime = "2026-09-30T04:00:00Z";
const newTime = "2026-10-04T08:00:00Z";
const identity = { subject: { reference: `Patient/${context.patient_id}` }, encounter: { reference: `Encounter/${context.encounter_id}` } };
function envelope(records, extra = {}) { return { source_system: "test-source", ...context, fetched_at: newTime, source_version: "test-only-v1", records, ...extra }; }
function connector(records, extra = {}) { return { id: "test-source", kind: "lis", capabilities: ["read"], readPatient: async () => envelope(records, extra) }; }
function bridge(connectors, requiredKinds = []) { return new ReadOnlyHospitalDataBridge({ connectors, requiredKinds }); }
function fhirConnector(kind, resources, extra = {}) {
  return createFhirR4Connectors({ baseUrl: "https://synthetic.local/fhir", extraKinds: ["pacs", "notes"],
    fetchImpl: async () => ({ ok: true, json: async () => ({ resourceType: "Bundle", entry: resources.map(resource => ({ resource })), ...extra }) }),
  }).find(c => c.kind === kind);
}

test("configured availability distinguishes successful empty, unavailable and degraded records", async () => {
  const empty = await bridge([connector([])], ["lis"]).readPatientSnapshot(context);
  assert.equal(empty.source_availability[0].status, "available_empty");
  assert.equal(empty.source_availability[0].record_count, 0);
  assert.deepEqual(empty.dataFeeds.source_availability, empty.source_availability);
  const failed = await bridge([{ ...connector([]), readPatient: async () => { throw new Error("CONNECTOR_FHIR_HTTP_ERROR: secret patient=A@example.com"); } }]).readPatientSnapshot(context);
  assert.equal(failed.source_availability[0].status, "unavailable");
  assert.equal(failed.source_availability[0].record_count, null);
  assert.equal(failed.source_availability[0].fetched_at, null);
  assert.equal(failed.unavailable_sources[0].error, "CONNECTOR_FHIR_HTTP_ERROR");
  assert.doesNotMatch(JSON.stringify(failed), /secret|example\.com/);
  const unknown = await bridge([connector([{ id: "unowned", ownership_status: "source_subject_absent" }])]).readPatientSnapshot(context);
  assert.equal(unknown.source_availability[0].status, "unknown");
  assert.equal(unknown.source_availability[0].record_count, 1);
  assert.equal(unknown.source_availability[0].accepted_record_count, 0);
  assert.equal(unknown.completeness, "partial_with_explicit_unknown_sources");
});

test("required identity stays fail closed while a truly empty clinical feed is explicit", async () => {
  await assert.rejects(bridge([{ ...connector([]), kind: "patient" }], ["patient"]).readPatientSnapshot(context), /BRIDGE_PATIENT_CARDINALITY/);
  await assert.rejects(bridge([connector([{ id: "unowned", ownership_status: "source_encounter_absent" }])], ["lis"]).readPatientSnapshot(context), /BRIDGE_REQUIRED_SOURCE_UNOWNED/);
  await assert.rejects(bridge([{ ...connector([]), readPatient: async () => { throw new Error("Patient secret 13900001111"); } }], ["lis"]).readPatientSnapshot(context), /^Error: BRIDGE_REQUIRED_SOURCE_UNAVAILABLE: lis\/test-source: CONNECTOR_READ_FAILED$/);
  await assert.rejects(bridge([{ ...connector([]), readPatient: async () => { throw new Error("CONNECTOR_PATIENT_MISMATCH: private patient"); } }]).readPatientSnapshot(context), /^Error: BRIDGE_IDENTITY_REJECTED: CONNECTOR_PATIENT_MISMATCH$/);
});

test("parse warnings and incomplete reads cannot be called complete empty results", async () => {
  for (const extra of [{ parse_warnings: ["malformed row"] }, { complete: false }, { truncated: true }]) {
    const snapshot = await bridge([connector([], extra)]).readPatientSnapshot(context);
    assert.equal(snapshot.source_availability[0].status, "unknown");
  }
  const missingId = await bridge([connector([{ result_value: 0 }])]).readPatientSnapshot(context);
  assert.equal(missingId.source_availability[0].status, "unknown");
  assert.equal(missingId.dataFeeds.lis.length, 0);
});

test("FHIR result status, version, clinical time and source update time survive separately", async () => {
  for (const status of ["amended", "corrected", "cancelled", "entered-in-error", undefined]) {
    const source = fhirConnector("lis", [{ resourceType: "Observation", id: "obs-1", ...identity, status,
      meta: { versionId: "7", lastUpdated: newTime }, effectiveDateTime: oldTime, issued: newTime,
      valueQuantity: { value: 4.1, unit: "mmol/L" } }]);
    const snapshot = await bridge([source], ["lis"]).readPatientSnapshot(context);
    const result = snapshot.dataFeeds.lis[0];
    assert.equal(result.status, status ?? null);
    assert.equal(result.source_status, status ?? null);
    assert.equal(result.version_id, "7");
    assert.equal(result._source.record_version, "7");
    assert.equal(result.event_time, oldTime);
    assert.equal(result.updated_at, newTime);
    assert.equal(result.resulted_at, newTime);
    assert.equal(result.recorded_at, null, "fetch time must not invent a source recording time");
  }
});

test("FHIR PACS cancellation is not turned into preliminary and unknown does not imply active", async () => {
  const pacs = await fhirConnector("pacs", [{ resourceType: "DiagnosticReport", id: "report-1", ...identity, status: "cancelled", meta: { versionId: "3" }, effectiveDateTime: oldTime, issued: newTime }]).readPatient(context);
  assert.equal(pacs.records[0].status, "cancelled");
  assert.equal(pacs.records[0].ordered_at, null);
  assert.equal(pacs.records[0].study_time, oldTime);
  const his = await fhirConnector("his", [{ resourceType: "MedicationRequest", id: "med-1", ...identity }]).readPatient(context);
  assert.equal(his.records[0].status, null);
  assert.equal(his.records[0].change_type, null);
});

test("FHIR capped pagination is unknown; malformed success response is unavailable", async () => {
  const source = fhirConnector("lis", [], { link: [{ relation: "next", url: "Observation?page=more" }] });
  const snapshot = await bridge([source]).readPatientSnapshot(context);
  assert.equal(snapshot.source_availability[0].status, "unknown");
  const badSource = createFhirR4Connectors({ baseUrl: "https://synthetic.local/fhir", fetchImpl: async () => ({ ok: true, json: async () => ({ resourceType: "OperationOutcome", issue: [] }) }) }).find(c => c.kind === "lis");
  const badSnapshot = await bridge([badSource]).readPatientSnapshot(context);
  assert.equal(badSnapshot.source_availability[0].status, "unavailable");
  assert.equal(badSnapshot.source_availability[0].reason_code, "CONNECTOR_FHIR_SEARCH_REPLY_INVALID");
  const malformed = await bridge([fhirConnector("lis", [{ resourceType: "OperationOutcome", issue: [] }])]).readPatientSnapshot(context);
  assert.equal(malformed.source_availability[0].status, "unknown");
  assert.equal(malformed.source_availability[0].reason_code, "SOURCE_READ_INCOMPLETE");
});

test("view-library preserves status, correction and acknowledgement versions without inventing finality", async () => {
  const row = { id: "result-1", ...context, version_id: "2", source_record_id: "stable-1", status: "corrected", sample_time: oldTime,
    recorded_at: newTime, updated_at: newTime, cancelled_at: null, acknowledged_at: oldTime, acknowledged_version_id: "1" };
  const sources = createViewLibraryConnectors({ queryView: async () => [row], extraViews: ["pacs", "notes"] });
  for (const kind of ["lis", "pacs", "notes", "nis", "his"]) {
    const record = (await sources.find(c => c.kind === kind).readPatient(context)).records[0];
    assert.equal(record.version_id, "2");
    assert.equal(record.source_record_id, "stable-1");
    assert.equal(record.recorded_at, newTime);
    assert.equal(record.acknowledged_version_id, "1");
    assert.equal(record.status, "corrected");
  }
  const unknownSources = createViewLibraryConnectors({ queryView: async () => [{ id: "result-unknown", ...context }], extraViews: ["pacs"] });
  for (const kind of ["encounter", "lis", "pacs", "his"]) assert.equal((await unknownSources.find(c => c.kind === kind).readPatient(context)).records[0].status, null);
  const nis = (await createViewLibraryConnectors({ queryView: async () => [{ id: "vital-1", recorded_at: newTime }] }).find(c => c.kind === "nis").readPatient(context)).records[0];
  assert.equal(nis.timestamp, null, "source recording time is not clinical observation time");
  assert.equal(nis.recorded_at, newTime);
});

test("malformed view HTTP body is unavailable, never available_empty", async () => {
  const source = createViewLibraryConnectors({ baseUrl: "https://synthetic.local", fetchImpl: async () => ({ ok: true, json: async () => ({ error: "not a row collection" }) }) }).find(c => c.kind === "lis");
  const snapshot = await bridge([source]).readPatientSnapshot(context);
  assert.equal(snapshot.source_availability[0].status, "unavailable");
});

test("viewdb preserves configured lifecycle columns around a reduced row mapper", async () => {
  const source = createViewDbConnector({ id: "viewdb-lis", kind: "lis", table: "v_lis", columns: ["id", "version_id", "recorded_at", "acknowledged_version_id"],
    mapRow: VIEWDB_ROW_MAPPERS.lis, query: async () => [{ id: "obs-1", ...context, status: "entered-in-error", version_id: "5", sample_time: oldTime, recorded_at: newTime, acknowledged_version_id: "4" }] });
  const record = (await source.readPatient(context)).records[0];
  assert.equal(record.status, "entered-in-error");
  assert.equal(record.version_id, "5");
  assert.equal(record.recorded_at, newTime);
  assert.equal(record.event_time, oldTime);
  assert.equal(record.acknowledged_version_id, "4");
  const capped = createViewDbConnector({ id: "viewdb-capped", kind: "lis", table: "v_lis", columns: ["id"], limit: 1, query: async () => [{ id: "obs-1", ...context }] });
  assert.equal((await bridge([capped]).readPatientSnapshot(context)).source_availability[0].status, "unknown");
});

function segment(type, values) { const fields = Array(Math.max(...Object.keys(values).map(Number)) + 1).fill(""); fields[0] = type; for (const [index, value] of Object.entries(values)) fields[index] = value; return fields.join("|"); }
function hl7Message({ control = "msg-v2", status = "C", value = "4.2", type = "ORU^R01" } = {}) {
  return [`MSH|^~\\&|SYNTH|SYNTH|MEDCIUS|SYNTH|20261004080000+0000||${type}|${control}|P|2.5`,
    `PID|1||${context.patient_id}`, segment("PV1", { 19: context.encounter_id }),
    segment("OBR", { 2: "order-1", 22: "20261004070000+0000" }),
    segment("OBX", { 1: "1", 2: "NM", 3: "2823-3^K", 4: "1", 5: value, 6: "mmol/L", 11: status, 14: "20260930040000+0000" }),
  ].join("\r");
}

test("HL7 correction and cancellation retain stable result identity and independent message version", async () => {
  const first = mapOruObservations(parseHl7v2Message(hl7Message({ control: "msg-v1", status: "F" }))).records[0];
  const revised = mapOruObservations(parseHl7v2Message(hl7Message())).records[0];
  assert.equal(first.source_record_id, revised.source_record_id);
  assert.notEqual(first.version_id, revised.version_id);
  assert.notEqual(first.id, revised.id);
  assert.equal(revised.status, "C");
  assert.equal(revised.result_status, "corrected");
  assert.equal(revised.event_time, "2026-09-30T04:00:00+00:00");
  assert.equal(revised.updated_at, "2026-10-04T07:00:00+00:00");
  assert.equal(revised.recorded_at, null);
  for (const status of ["D", "W", "X", "U"]) {
    const mapped = mapOruObservations(parseHl7v2Message(hl7Message({ status, value: "" })));
    assert.equal(mapped.records.length, 1);
    assert.equal(mapped.records[0].result_value, null);
  }
  const blank = mapOruObservations(parseHl7v2Message(hl7Message({ status: "" }))).records[0];
  assert.equal(blank.status, null);
  assert.equal(blank.result_status, null);
});

test("both HL7 entry paths retain lifecycle; catalog source receipt time is explicit", async () => {
  const direct = createHl7v2Connectors({ fetchMessages: async () => [hl7Message()] }).find(c => c.kind === "lis");
  const catalog = createHl7v2Connectors({ listMessages: async () => [{ id: "message-1", recorded_at: newTime }], loadMessage: async () => hl7Message() }).find(c => c.kind === "lis");
  const a = (await direct.readPatient(context)).records[0];
  const b = (await catalog.readPatient(context)).records[0];
  assert.equal(a.result_status, "corrected");
  assert.equal(b.result_status, "corrected");
  assert.equal(a.recorded_at, null);
  assert.equal(b.recorded_at, newTime);
  assert.equal(b.updated_at, a.updated_at);
  assert.equal(b.version_id, a.version_id);
});

test("HL7 medication missing order status is unknown; cancellation request is not cancellation", () => {
  const raw = hl7Message({ type: "RDE^O11" }) + "\r" + segment("ORC", { 1: "CA", 2: "med-order-1", 9: "20261004070000+0000" }) + "\r" + segment("RXE", { 2: "MED-SYNTH^Synthetic medicine", 5: "1", 7: "mg" });
  const pending = mapRdeMedicationOrders(parseHl7v2Message(raw)).records[0];
  assert.equal(pending.status, null);
  assert.equal(pending.change_type, null);
  assert.equal(pending.source_order_control, "CA");
  // Explicit source ORC-5 cancellation, not the ORC-1 request, establishes state.
  const explicit = raw.split("\r").map(line => line.startsWith("ORC|") ? segment("ORC", { 1: "OC", 2: "med-order-1", 5: "CA", 9: "20261004070000+0000" }) : line).join("\r");
  assert.equal(mapRdeMedicationOrders(parseHl7v2Message(explicit)).records[0].status, "cancelled");
});

test("CDA catalog preserves explicit correction metadata and does not invent event time", async () => {
  const source = createCdaDocumentConnector({ listDocuments: async () => [{ id: "doc-1", status: "amended", version_id: "3", recorded_at: newTime, acknowledged_version_id: "2" }], loadDocument: async () => "<text>Synthetic record</text>" });
  const record = (await source.readPatient(context)).records[0];
  assert.equal(record.status, "amended");
  assert.equal(record.version_id, "3");
  assert.equal(record.recorded_at, newTime);
  assert.equal(record.event_time, null);
});
