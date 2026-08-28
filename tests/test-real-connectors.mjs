// Real-System Integration Connector PoC Tests (REG-ACTION-TRACKER R26/R28).
// Positive: synthetic-replay fixtures through the read-only bridge.
// Negative: HTTP failure fail-closed, patient mismatch, non-required degrade,
// PHI exit-guard blocking, write-method rejection through the guard wrapper.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReadOnlyHospitalDataBridge } from "../plugins/medcius/lib/read-only-hospital-data-bridge.mjs";
import { createFhirR4Connectors } from "../plugins/medcius/lib/connectors/fhir-r4-connector.mjs";
import { createCdaDocumentConnector, flattenDocumentToText } from "../plugins/medcius/lib/connectors/cda-document-connector.mjs";
import { withPhiExitGuard } from "../plugins/medcius/lib/connectors/phi-exit-guard.mjs";

const fhirFixture = JSON.parse(readFileSync(fileURLToPath(new URL("../plugins/medcius/fixtures/connectors/fhir-r4-replay.json", import.meta.url)), "utf8"));
const cdaFixture = JSON.parse(readFileSync(fileURLToPath(new URL("../plugins/medcius/fixtures/connectors/cda-replay.json", import.meta.url)), "utf8"));

const context = {
  tenant_id: "sandbox-hospital",
  doctor_id: "doctor-synthetic-1",
  patient_id: "patient-synthetic-1",
  encounter_id: "encounter-synthetic-1",
  time_window: "24h",
};
const GUARD_SALT = "synthetic-exit-guard-salt-0123456789";

console.log("== Testing real-system integration connector PoC (FHIR R4 / CDA / PHI exit guard) ==");

/** Replay fetchImpl: resolves fixture routes by pathname, enforces GET-only. */
function replayFetch(routes, { observed = [], statusOverrides = {} } = {}) {
  return async (url, init) => {
    observed.push({ url, method: init?.method });
    const parsed = new URL(url);
    if (String(init?.method).toUpperCase() !== "GET") {
      throw new Error(`REPLAY_FORBIDDEN_METHOD: ${init.method} ${parsed.pathname}`);
    }
    const overridden = Object.entries(statusOverrides).find(([key]) => parsed.pathname.endsWith(key));
    if (overridden) {
      return { ok: false, status: overridden[1], json: async () => ({}) };
    }
    const payload =
      routes[parsed.pathname]
      || Object.entries(routes).find(([key]) => parsed.pathname.endsWith(key))?.[1];
    if (!payload) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => payload };
  };
}

// ----------------------------------------------------
// Test 1: P1 FHIR R4 replay -> read-only bridge snapshot
// ----------------------------------------------------
console.log("\n[Test 1] FHIR R4 connectors replay synthetic bundle through the bridge...");
const observedRequests = [];
const fhirConnectors = createFhirR4Connectors({
  baseUrl: "https://fhir.sandbox.local/fhir",
  fetchImpl: replayFetch(fhirFixture.routes, { observed: observedRequests }),
  sourceVersion: fhirFixture.source_version,
});
const guardedFhir = fhirConnectors.map((connector) => withPhiExitGuard(connector, { salt: GUARD_SALT }));
const bridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter", "lis", "his"],
  connectors: guardedFhir,
});
const snapshot = await bridge.readPatientSnapshot(context);
assert.equal(snapshot.completeness, "complete_for_configured_connectors");
assert.equal(snapshot.source_manifest.length, 4);
assert.equal(snapshot.dataFeeds.patient.id, context.patient_id);
assert.equal(snapshot.dataFeeds.encounter.status, "in-progress");
assert.equal(snapshot.dataFeeds.lis.length, 2);
const kObservation = snapshot.dataFeeds.lis.find((record) => record.code === "2823-3");
assert.equal(kObservation.is_critical, true, "LL interpretation must map to is_critical");
assert.equal(kObservation.result_value, 2.4);
assert.ok(kObservation._source.read_only === true);
assert.equal(kObservation._source.source_version, "synthetic-fhir-replay-v1");
const medOrder = snapshot.dataFeeds.his_orders.find((record) => record.is_medication);
assert.equal(medOrder.drug_name, "注射用头孢曲松钠（合成）");
assert.equal(medOrder.dosage, "2g");
assert.equal(medOrder.route, "静脉滴注");
assert.ok(observedRequests.length >= 4);
assert.ok(observedRequests.every((request) => request.method === "GET"), "connectors must only ever issue GET");
console.log("✓ FHIR R4 replay produced a complete, provenance-stamped read-only snapshot (GET-only verified)");

// ----------------------------------------------------
// Test 2: required source HTTP failure -> whole workflow fails closed
// ----------------------------------------------------
console.log("\n[Test 2] Required LIS source failing closed on upstream error...");
const failingBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter", "lis"],
  connectors: createFhirR4Connectors({
    baseUrl: "https://fhir.sandbox.local/fhir",
    fetchImpl: replayFetch(fhirFixture.routes, { statusOverrides: { "/Observation": 500 } }),
  }),
});
await assert.rejects(
  () => failingBridge.readPatientSnapshot(context),
  /BRIDGE_REQUIRED_SOURCE_UNAVAILABLE.*CONNECTOR_FHIR_HTTP_ERROR/
);
console.log("✓ Required-source failure propagated as BRIDGE_REQUIRED_SOURCE_UNAVAILABLE (fail-closed)");

// ----------------------------------------------------
// Test 3: non-required source degrades to explicit unavailable_sources
// ----------------------------------------------------
console.log("\n[Test 3] Non-required source degradation keeps the workflow usable...");
const degradedBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter"],
  connectors: createFhirR4Connectors({
    baseUrl: "https://fhir.sandbox.local/fhir",
    fetchImpl: replayFetch({ ...fhirFixture.routes, "/Observation": null, "/MedicationRequest": null }, {}),
  }),
});
const degraded = await degradedBridge.readPatientSnapshot(context);
assert.equal(degraded.completeness, "partial_with_explicit_unavailable_sources");
assert.ok(degraded.unavailable_sources.some((source) => source.kind === "lis"));
console.log("✓ Non-required LIS/HIS outage surfaced as unavailable_sources without blocking");

// ----------------------------------------------------
// Test 4: wrong-patient reply rejected before entering feeds
// ----------------------------------------------------
console.log("\n[Test 4] Patient identity mismatch fails closed...");
const wrongPatientRoutes = {
  ...fhirFixture.routes,
  "/Patient/patient-synthetic-1": { ...fhirFixture.routes["/Patient/patient-synthetic-1"], id: "someone-else" },
};
const mismatchBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient"],
  connectors: createFhirR4Connectors({
    baseUrl: "https://fhir.sandbox.local/fhir",
    fetchImpl: replayFetch(wrongPatientRoutes),
  }),
});
await assert.rejects(
  () => mismatchBridge.readPatientSnapshot(context),
  /BRIDGE_PATIENT_CARDINALITY_OR_ID_MISMATCH/
);
console.log("✓ Cross-patient contamination blocked at the bridge boundary");

// ----------------------------------------------------
// Test 5: P2 CDA document channel -> notes records with preserved text
// ----------------------------------------------------
console.log("\n[Test 5] CDA document channel flattens narrative while preserving reading order...");
const cdaConnector = createCdaDocumentConnector({
  listDocuments: async () => cdaFixture.documents.map(({ body, ...meta }) => meta),
  loadDocument: async (_context, docMeta) => cdaFixture.documents.find((doc) => doc.id === docMeta.id).body,
  sourceVersion: cdaFixture.source_version,
});
const notesEnvelope = await cdaConnector.readPatient(context);
assert.equal(notesEnvelope.records.length, 2);
assert.equal(notesEnvelope.records[0].title, "出院记录（合成）");
assert.ok(notesEnvelope.records[0].text.includes("患者因胸闷气促入院"));
assert.ok(notesEnvelope.records[0].text.includes("复查血钾 2.4 mmol/L"), "narrative order preserved for span binding");
assert.ok(notesEnvelope.records[0].text.includes("出院医嘱"));
const flatText = flattenDocumentToText(cdaFixture.documents[0].body);
assert.ok(!flatText.includes("<paragraph>"), "markup must be stripped from narrative");
console.log("✓ CDA narrative flattened to span-bindable plain text (2 documents)");


// ----------------------------------------------------
// Test 6: PHI exit guard pseudonymizes raw identifiers at connector exit
// ----------------------------------------------------
console.log("\n[Test 6] PHI exit guard tokenizes raw identifiers before envelope release...");
const guardedCda = withPhiExitGuard(cdaConnector, { salt: GUARD_SALT });
const guardedEnvelope = await guardedCda.readPatient(context);
const serialized = JSON.stringify(guardedEnvelope.records);
assert.ok(serialized.includes("[PSN:"), "pseudonym tokens must be present");
assert.ok(!serialized.includes("110101199003072378"), "raw ID card must never leave the connector process");
assert.ok(!serialized.includes("13900001111"), "raw phone number must never leave the connector process");
assert.ok(!serialized.includes("张三丰"), "labeled patient name must be tokenized");
assert.equal(guardedEnvelope.phi_exit_guard.applied, true);
assert.equal(guardedEnvelope.phi_exit_guard.mode, "pseudonymize");
// Stability: same salt domain maps the same identifier to the same token.
const secondPass = await guardedCda.readPatient(context);
assert.equal(JSON.stringify(secondPass.records), serialized, "pseudonymization must be deterministic within one salt domain");
console.log("✓ Exit-guard released only [PSN:*]-tokenized records; stable across reads in one salt domain");

// ----------------------------------------------------
// Test 7: PHI exit guard assert-mode blocks raw PHI (fail-closed)
// ----------------------------------------------------
console.log("\n[Test 7] Assert mode blocks any envelope still carrying raw PHI...");
const assertGuard = withPhiExitGuard(cdaConnector, { salt: GUARD_SALT, mode: "assert" });
await assert.rejects(() => assertGuard.readPatient(context), /PHI_EXIT_GUARD_RAW_PHI_BLOCKED/);
console.log("✓ Raw-PHI envelope refused with PHI_EXIT_GUARD_RAW_PHI_BLOCKED");

// ----------------------------------------------------
// Test 8: salt policy
// ----------------------------------------------------
console.log("\n[Test 8] Guard refuses to start without a deployment salt...");
assert.throws(() => withPhiExitGuard(cdaConnector, { salt: "short" }), /PHI_EXIT_GUARD_SALT_REQUIRED/);
assert.throws(() => withPhiExitGuard(cdaConnector, {}), /PHI_EXIT_GUARD_SALT_REQUIRED/);
assert.throws(() => withPhiExitGuard(cdaConnector, { salt: GUARD_SALT, mode: "yolo" }), /PHI_EXIT_GUARD_MODE_INVALID/);
console.log("✓ Salt length and mode policy enforced at construction time");

// ----------------------------------------------------
// Test 9: write methods stay rejected even under the guard wrapper
// ----------------------------------------------------
console.log("\n[Test 9] Bridge still rejects write-capable connectors after wrapping...");
assert.throws(() => {
  new ReadOnlyHospitalDataBridge({
    requiredKinds: ["patient"],
    connectors: [{ id: "rogue", kind: "patient", capabilities: ["read"], readPatient: async () => ({}), updateResource: async () => ({}) }].map(
      (connector) => withPhiExitGuard(connector, { salt: GUARD_SALT })
    ),
  });
}, /BRIDGE_WRITE_METHOD_REJECTED/);
console.log("✓ Write-method detection survives the exit-guard wrapper (read-only invariant intact)");

// ----------------------------------------------------
// Test 10: Complete write method & capability blacklist rejection
// ----------------------------------------------------
console.log("\n[Test 10] Bridge rejects create_resource / delete_resource / write_back / update methods at init...");

const writeMethodNames = ["create_resource", "update_resource", "delete_resource", "write_back", "deletePatient", "patchOrder"];
for (const badMethod of writeMethodNames) {
  assert.throws(
    () => {
      new ReadOnlyHospitalDataBridge({
        requiredKinds: ["patient"],
        connectors: [{ id: `rogue-${badMethod}`, kind: "patient", capabilities: ["read"], readPatient: async () => ({}), [badMethod]: async () => ({}) }],
      });
    },
    /BRIDGE_WRITE_METHOD_REJECTED/,
    `Must reject connector exposing '${badMethod}'`
  );
}

// Capability blacklist test
const badCapabilities = ["write", "create", "update", "delete", "create_resource", "update_resource", "write_back"];
for (const badCap of badCapabilities) {
  assert.throws(
    () => {
      new ReadOnlyHospitalDataBridge({
        requiredKinds: ["patient"],
        connectors: [{ id: `rogue-cap-${badCap}`, kind: "patient", capabilities: ["read", badCap], readPatient: async () => ({}) }],
      });
    },
    /BRIDGE_READ_ONLY_CAPABILITY_REQUIRED/,
    `Must reject connector with capability '${badCap}'`
  );
}
console.log(`✓ All ${writeMethodNames.length} write methods and ${badCapabilities.length} write capabilities rejected at initialization time`);

console.log("\nALL REAL-SYSTEM INTEGRATION CONNECTOR TESTS PASSED!\n");


