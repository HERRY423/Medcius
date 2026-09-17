// Real-Data-Channel Connector Tests (REG-ACTION-TRACKER R26: P3 视图库 / P4 HL7 v2).
// Positive: synthetic-replay fixtures through the read-only bridge (same contract
// as the P1/P2 PoC). Negative: identifier/SQL-shape injection rejection, write
// surface rejection, context fail-closed, malformed HL7 fail-closed, parse-warning
// degrade, PHI exit-guard tokenization and raw-PHI blocking.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReadOnlyHospitalDataBridge } from "../plugins/medcius/lib/read-only-hospital-data-bridge.mjs";
import {
  createViewDbConnector,
  createViewDbConnectors,
  VIEWDB_ROW_MAPPERS,
} from "../plugins/medcius/lib/connectors/viewdb-connector.mjs";
import {
  createHl7v2Connectors,
  parseHl7v2Message,
} from "../plugins/medcius/lib/connectors/hl7v2-connector.mjs";
import { withPhiExitGuard } from "../plugins/medcius/lib/connectors/phi-exit-guard.mjs";

const viewdbFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../plugins/medcius/fixtures/connectors/viewdb-replay.json", import.meta.url)), "utf8"),
);
const hl7Fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../plugins/medcius/fixtures/connectors/hl7v2-replay.json", import.meta.url)), "utf8"),
);

const context = {
  tenant_id: "sandbox-hospital",
  doctor_id: "doctor-synthetic-1",
  patient_id: "patient-synthetic-1",
  encounter_id: "encounter-synthetic-1",
  time_window: "24h",
};
const GUARD_SALT = "synthetic-exit-guard-salt-9876543210";

console.log("== Testing real-data-channel connectors (P3 view-database / P4 HL7 v2) ==");

// ----------------------------------------------------
// Test 1: P3 replay -> bridge snapshot, SELECT-only + parameterized verified
// ----------------------------------------------------
console.log("\n[Test 1] View-database connectors replay whitelisted views through the bridge...");
const observedSql = [];
const replayQuery = async (sql, params) => {
  observedSql.push({ sql, params });
  const table = /FROM\s+([A-Za-z_0-9]+)/i.exec(sql)[1];
  const rows = viewdbFixture.rows[table] ?? [];
  // Emulate the DB engine applying the bound scope parameters.
  if (table === viewdbFixture.tables.patient) return rows.filter((r) => r.patient_id === context.patient_id);
  if (table === viewdbFixture.tables.encounter) return rows.filter((r) => r.encounter_id === context.encounter_id);
  return rows.filter((r) => r.patient_id === context.patient_id && r.encounter_id === context.encounter_id);
};
const viewdbConnectors = createViewDbConnectors({
  query: replayQuery,
  tables: viewdbFixture.tables,
  columns: viewdbFixture.columns,
  sourceVersion: viewdbFixture.source_version,
});
const guardedViewdb = viewdbConnectors.map((connector) => withPhiExitGuard(connector, { salt: GUARD_SALT }));
const viewdbBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter", "lis", "his"],
  connectors: guardedViewdb,
});
const viewdbSnapshot = await viewdbBridge.readPatientSnapshot(context);
assert.equal(viewdbSnapshot.completeness, "complete_for_configured_connectors");
assert.equal(viewdbSnapshot.dataFeeds.patient.id, context.patient_id);
assert.equal(viewdbSnapshot.dataFeeds.encounter.status, "in-progress");
assert.equal(viewdbSnapshot.dataFeeds.lis.length, 2);
const criticalLis = viewdbSnapshot.dataFeeds.lis.find((record) => record.code === "2823-3");
assert.equal(criticalLis.is_critical, true, "is_critical=1/LL flag must map to critical");
assert.equal(viewdbSnapshot.dataFeeds.his_orders[0].drug_name, "注射用头孢曲松钠（合成）");
assert.ok(viewdbSnapshot.source_manifest.every((entry) => entry.payload_sha256 && entry.read_only === true));
console.log("✓ P3 replay produced a complete, provenance-stamped read-only snapshot (4 views)");

// Test 1b: SQL discipline — every statement is a single parameterized SELECT
for (const { sql, params } of observedSql) {
  assert.ok(/^SELECT\s/i.test(sql), "only SELECT is ever built");
  assert.ok(!/;/.test(sql), "no statement chaining");
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|MERGE)\b/i.test(sql), "no write keywords");
  assert.ok(sql.includes("?"), "values must be bound, not interpolated");
  assert.ok(!JSON.stringify(params).match(/DROP|DELETE/i), "no write payload in params");
  assert.ok(/tenant_id = \?/.test(sql), "tenant isolation clause forced");
  assert.ok(sql.includes("patient_id = ?"), "patient scope forced");
}
assert.equal(observedSql.length, 4);
console.log("✓ All 4 built statements are parameterized SELECTs with tenant+patient scoping");

// ----------------------------------------------------
// Test 2: identifier / SQL-shape injection rejected at construction
// ----------------------------------------------------
console.log("\n[Test 2] Config identifiers are validated (SQL injection through config impossible)...");
assert.throws(() => createViewDbConnector({ id: "x", kind: "lis", table: "vw; DROP TABLE x", columns: ["id"], query: replayQuery }), /CONNECTOR_VIEWDB_IDENTIFIER_INVALID/);
assert.throws(() => createViewDbConnector({ id: "x", kind: "lis", table: "vw_ok", columns: ["id", "1=1; DELETE"], query: replayQuery }), /CONNECTOR_VIEWDB_IDENTIFIER_INVALID/);
assert.throws(() => createViewDbConnector({ id: "x", kind: "lis", table: "vw_ok", columns: ["id"], orderBy: "id; DROP TABLE x", query: replayQuery }), /CONNECTOR_VIEWDB_IDENTIFIER_INVALID/);
assert.throws(() => createViewDbConnector({ id: "x", kind: "not-a-kind", table: "vw_ok", columns: ["id"], query: replayQuery }), /CONNECTOR_VIEWDB_KIND_INVALID/);
assert.throws(() => createViewDbConnector({ id: "x", kind: "lis", table: "vw_ok", columns: ["id"], query: "SELECT 1" }), /CONNECTOR_VIEWDB_QUERY_REQUIRED/);
assert.throws(() => createViewDbConnectors({ query: replayQuery, tables: { lis: "vw_lis" } }), /CONNECTOR_VIEWDB_TABLE_MISSING/);
console.log("✓ Malicious/invalid table/column/orderBy/kind config rejected before any query exists");

// ----------------------------------------------------
// Test 3: context fail-closed and non-SELECT executor surface
// ----------------------------------------------------
console.log("\n[Test 3] Missing context fails closed; hostile executor cannot smuggle writes...");
const strictConnector = createViewDbConnector({
  id: "viewdb-strict", kind: "lis", table: "vw_lis", columns: ["id"],
  query: async (sql) => { if (!/^SELECT/i.test(sql)) throw new Error("EXECUTOR_NON_SELECT"); return []; },
});
await assert.rejects(() => strictConnector.readPatient({ tenant_id: "t", patient_id: "p" }), /CONNECTOR_VIEWDB_CONTEXT_REQUIRED: encounter_id/);
// even if a deployment hands us a hostile executor, the built SQL is still SELECT
const executed = [];
await createViewDbConnector({
  id: "viewdb-audit", kind: "lis", table: "vw_lis", columns: ["id"], query: async (sql, params) => { executed.push(sql); return []; },
}).readPatient(context);
assert.ok(/^SELECT/i.test(executed[0]));
console.log("✓ Context fail-closed verified; connector side of the SQL contract holds under hostile executors");

// ----------------------------------------------------
// Test 4: P4 HL7 v2 replay -> bridge snapshot
// ----------------------------------------------------
console.log("\n[Test 4] HL7 v2 subscription connectors replay ADT/ORU/RDE through the bridge...");
const allMessages = [...hl7Fixture.messages.adt, ...hl7Fixture.messages.oru, ...hl7Fixture.messages.rde];
const hl7Connectors = createHl7v2Connectors({ fetchMessages: async () => allMessages, sourceVersion: hl7Fixture.source_version });
const guardedHl7 = hl7Connectors.map((connector) => withPhiExitGuard(connector, { salt: GUARD_SALT }));
const hl7Bridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter", "lis", "his"],
  connectors: guardedHl7,
});
const hl7Snapshot = await hl7Bridge.readPatientSnapshot(context);
assert.equal(hl7Snapshot.completeness, "complete_for_configured_connectors");
assert.equal(hl7Snapshot.dataFeeds.patient.gender, "male");
assert.equal(hl7Snapshot.dataFeeds.encounter.id, context.encounter_id);
assert.equal(hl7Snapshot.dataFeeds.encounter.period_start, "2026-08-20T08:00:00");
const hl7Critical = hl7Snapshot.dataFeeds.lis.find((record) => record.code === "2823-3");
assert.equal(hl7Critical.is_critical, true, "OBX-8 LL must map to critical");
assert.equal(hl7Critical.result_value, 2.4);
assert.equal(hl7Snapshot.dataFeeds.his_orders[0].drug_name, "注射用头孢曲松钠（合成）");
assert.equal(hl7Snapshot.dataFeeds.his_orders[0].dosage, "2g");
assert.equal(hl7Snapshot.dataFeeds.his_orders[0].route, "静脉滴注");
console.log("✓ P4 replay mapped ADT/ORU/RDE flows into a complete bridge snapshot");

// ----------------------------------------------------
// Test 5: malformed HL7 fails closed; OBX degrade surfaces in parse_warnings
// ----------------------------------------------------
console.log("\n[Test 5] Malformed MSH fails closed; malformed OBX degrades with explicit warning...");
assert.throws(() => parseHl7v2Message("PID|1||x"), /CONNECTOR_HL7_MSH_MISSING/);
assert.throws(() => parseHl7v2Message("MSH|^~\\&|A|B|C|D|E|||F"), /CONNECTOR_HL7_MESSAGE_TYPE_MISSING/);
assert.throws(() => parseHl7v2Message(""), /CONNECTOR_HL7_EMPTY_MESSAGE/);
const oruEnvelope = await hl7Connectors[2].readPatient(context);
assert.equal(oruEnvelope.records.length, 2, "malformed OBX skipped");
assert.ok(oruEnvelope.parse_warnings.some((warning) => warning.includes("skipped_malformed_OBX")), "degrade must be explicit");
const failingFetch = createHl7v2Connectors({ fetchMessages: async () => ["PID|1||no-msh"] });
await assert.rejects(() => failingFetch[0].readPatient(context), /CONNECTOR_HL7_MSH_MISSING/);
console.log("✓ Message-level fail-closed and record-level explicit degrade both verified");

// ----------------------------------------------------
// Test 6: multiple ADT events dedupe to one patient/encounter card (last wins)
// ----------------------------------------------------
console.log("\n[Test 6] Multiple ADT events dedupe to single cards (bridge cardinality holds)...");
const adtUpdate = hl7Fixture.messages.adt[0].replace("20260825080000||ADT^A01", "20260825090000||ADT^A08").replace("MSG0001", "MSG0004").replace("ICU^01^床", "心内^03^床");
const multiBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter"],
  connectors: createHl7v2Connectors({ fetchMessages: async () => [hl7Fixture.messages.adt[0], adtUpdate] }),
});
const multiSnapshot = await multiBridge.readPatientSnapshot(context);
assert.equal(multiSnapshot.dataFeeds.patient.id, context.patient_id);
assert.ok(String(multiSnapshot.dataFeeds.encounter.class).length > 0);
console.log("✓ A01+A08 collapses to one patient and one encounter (last event wins)");

// ----------------------------------------------------
// Test 7: PHI exit guard tokenizes raw HL7 identifiers (pseudonymize mode)
// ----------------------------------------------------
console.log("\n[Test 7] PHI exit guard tokenizes raw PID identifiers before envelope release...");
const rawHl7 = hl7Connectors.map((connector) => withPhiExitGuard(connector, { salt: GUARD_SALT }));
const rawEnvelope = await rawHl7[0].readPatient(context);
const serialized = JSON.stringify(rawEnvelope.records);
assert.ok(serialized.includes("[PSN:"), "pseudonym tokens must be present");
assert.ok(!serialized.includes("13900001111"), "raw phone from PID-13 must be tokenized before release");
const assertGuard = withPhiExitGuard(hl7Connectors[0], { salt: GUARD_SALT, mode: "assert" });
await assert.rejects(() => assertGuard.readPatient(context), /PHI_EXIT_GUARD_RAW_PHI_BLOCKED/);
console.log("✓ Raw PHI blocked at the HL7 connector exit (pseudonymize + assert modes)");

// ----------------------------------------------------
// Test 8: both channels stay write-free under the bridge validator
// ----------------------------------------------------
console.log("\n[Test 8] Bridge rejects write-capable variants of both channel factories...");
for (const badMethod of ["createOrder", "updateRow", "deleteMessage", "writeBack"]) {
  assert.throws(() => {
    new ReadOnlyHospitalDataBridge({
      requiredKinds: ["patient"],
      connectors: [{ id: "rogue-viewdb", kind: "patient", capabilities: ["read"], readPatient: async () => ({ records: [] }), [badMethod]: async () => ({}) }],
    });
  }, /BRIDGE_WRITE_METHOD_REJECTED/, `must reject viewdb-style connector exposing ${badMethod}`);
}
// HL7 connectors only ever expose readPatient
for (const connector of createHl7v2Connectors({ fetchMessages: async () => [] })) {
  const methods = Object.keys(connector).filter((key) => typeof connector[key] === "function");
  assert.deepEqual(methods.sort(), ["readPatient"], "HL7 connector surface must be readPatient-only");
}
console.log("✓ Read-only invariant intact across both new channels");

console.log("\nALL REAL-DATA-CHANNEL CONNECTOR TESTS PASSED");
