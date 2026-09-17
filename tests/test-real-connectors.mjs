// Real-System Integration Connector PoC Tests (REG-ACTION-TRACKER R26/R28).
// Positive: synthetic-replay fixtures through the read-only bridge.
// Negative: HTTP failure fail-closed, patient mismatch, non-required degrade,
// PHI exit-guard blocking, write-method rejection through the guard wrapper.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReadOnlyHospitalDataBridge } from "../plugins/medcius/lib/read-only-hospital-data-bridge.mjs";
import { createFhirR4Connectors, assertHttpsBaseUrl } from "../plugins/medcius/lib/connectors/fhir-r4-connector.mjs";
import { createCdaDocumentConnector, flattenDocumentToText } from "../plugins/medcius/lib/connectors/cda-document-connector.mjs";
import { createViewLibraryConnectors } from "../plugins/medcius/lib/connectors/view-library-connector.mjs";
import { createHl7v2Connectors, parseHl7v2MessageType } from "../plugins/medcius/lib/connectors/hl7v2-connector.mjs";
import { createSiteBridge } from "../plugins/medcius/lib/connectors/site-connector-factory.mjs";
import { withPhiExitGuard } from "../plugins/medcius/lib/connectors/phi-exit-guard.mjs";

const fhirFixture = JSON.parse(readFileSync(fileURLToPath(new URL("../plugins/medcius/fixtures/connectors/fhir-r4-replay.json", import.meta.url)), "utf8"));
const cdaFixture = JSON.parse(readFileSync(fileURLToPath(new URL("../plugins/medcius/fixtures/connectors/cda-replay.json", import.meta.url)), "utf8"));
const viewLibraryFixture = JSON.parse(readFileSync(fileURLToPath(new URL("../plugins/medcius/fixtures/connectors/view-library-replay.json", import.meta.url)), "utf8"));
const hl7v2Fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../plugins/medcius/fixtures/connectors/hl7v2-replay.json", import.meta.url)), "utf8"));

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

// ----------------------------------------------------
// Test 11: P3 view-library NIS+LIS+HIS replay
// ----------------------------------------------------
console.log("\n[Test 11] P3 view-library connectors replay NIS/LIS/HIS through the bridge...");
const viewObserved = [];
const viewConnectors = createViewLibraryConnectors({
  baseUrl: "https://views.sandbox.local/",
  fetchImpl: replayFetch(viewLibraryFixture.routes, { observed: viewObserved }),
  sourceVersion: viewLibraryFixture.source_version,
});
assert.equal(viewConnectors.length, 5);
const viewBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter", "nis", "lis", "his"],
  connectors: viewConnectors,
});
const viewSnapshot = await viewBridge.readPatientSnapshot(context);
assert.equal(viewSnapshot.completeness, "complete_for_configured_connectors");
assert.equal(viewSnapshot.dataFeeds.patient.id, context.patient_id);
assert.equal(viewSnapshot.dataFeeds.nis.length, 1);
assert.equal(viewSnapshot.dataFeeds.lis[0].result_value, 2.4);
assert.equal(viewSnapshot.dataFeeds.lis[0].is_critical, true);
assert.equal(viewSnapshot.dataFeeds.his_orders[0].drug_name, "注射用头孢曲松钠（合成）");
assert.ok(viewObserved.every((request) => request.method === "GET"));
console.log("✓ P3 view-library replay produced a complete NIS+LIS+HIS snapshot (GET-only)");

console.log("\n[Test 12] P3 view names that look like writes are rejected...");
assert.throws(
  () => createViewLibraryConnectors({
    queryView: async () => [],
    viewNames: { patient: "insert_patient" },
  }),
  /CONNECTOR_VIEW_NAME_WRITE_REJECTED/,
);
console.log("✓ Mutating view names fail closed at construction");
assert.throws(
  () => createViewLibraryConnectors({
    queryView: async () => [],
    viewNames: { lis: "v_medcius_lis_results; DROP TABLE t" },
  }),
  /CONNECTOR_VIEW_NAME_WRITE_REJECTED/,
);
assert.throws(
  () => createViewLibraryConnectors({
    queryView: async () => [],
    viewNames: { nis: "select * from v_medcius_nis_vitals" },
  }),
  /CONNECTOR_VIEW_NAME_WRITE_REJECTED/,
);
console.log("✓ Smuggled SQL in view names fail closed at construction");

// ----------------------------------------------------
// Test 13: FHIR numeric reference ranges + Bundle pagination + plaintext guard
// ----------------------------------------------------
console.log("\n[Test 13] FHIR keeps numeric reference bounds and follows Bundle.next...");
let observationCalls = 0;
const pagedFetch = async (url, init) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/Observation")) {
    observationCalls++;
    if (observationCalls === 1) {
      return {
        ok: true, status: 200,
        json: async () => ({
          resourceType: "Bundle", type: "searchset",
          entry: [{
            resource: {
              resourceType: "Observation", id: "obs-page-1", status: "final",
              code: { coding: [{ code: "2160-0", display: "Creatinine" }], text: "血肌酐" },
              effectiveDateTime: "2026-08-25T06:00:00Z",
              valueQuantity: { value: 145, unit: "umol/L" },
              referenceRange: [{ text: "57 - 111 umol/L", low: { value: 57, unit: "umol/L" }, high: { value: 111, unit: "umol/L" } }],
            },
          }],
          link: [{ relation: "next", url: `${parsed.origin}${parsed.pathname}?page=2` }],
        }),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        resourceType: "Bundle", type: "searchset",
        entry: [{
          resource: {
            resourceType: "Observation", id: "obs-page-2", status: "final",
            code: { coding: [{ code: "2823-3", display: "Potassium" }], text: "血钾测定" },
            effectiveDateTime: "2026-08-25T07:00:00Z",
            valueQuantity: { value: 2.4, unit: "mmol/L" },
            referenceRange: [{ text: "3.5 - 5.3 mmol/L", low: { value: 3.5, unit: "mmol/L" }, high: { value: 5.3, unit: "mmol/L" } }],
          },
        }],
      }),
    };
  }
  return replayFetch(fhirFixture.routes)(url, init);
};
const pagedConnectors = createFhirR4Connectors({ baseUrl: "https://fhir.sandbox.local/fhir", fetchImpl: pagedFetch });
const pagedBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter", "lis"],
  connectors: pagedConnectors,
});
const pagedSnapshot = await pagedBridge.readPatientSnapshot(context);
assert.equal(pagedSnapshot.dataFeeds.lis.length, 2, "both Bundle pages must be collected");
const scrRecord = pagedSnapshot.dataFeeds.lis.find((record) => record.code === "2160-0");
assert.equal(scrRecord.ref_low, 57, "numeric reference low must survive the connector");
assert.equal(scrRecord.ref_high, 111, "numeric reference high must survive the connector");
assert.ok(Array.isArray(scrRecord.referenceRange), "FHIR referenceRange array must be preserved");
assert.throws(
  () => createFhirR4Connectors({ baseUrl: "http://ehr.example.com/fhir", fetchImpl: pagedFetch }),
  /CONNECTOR_HTTP_PLAINTEXT_REJECTED/,
);
assert.throws(() => assertHttpsBaseUrl("not-a-url"), /CONNECTOR_BASE_URL_INVALID/);
console.log("✓ Pagination collected 2 pages; numeric bounds kept; plaintext http refused");

// ----------------------------------------------------
// Test 14: P3 field minimization + opt-in pacs/notes + transient retry
// ----------------------------------------------------
console.log("\n[Test 14] View-library strips unknown columns and serves opt-in pacs/notes...");
const leakingRows = {
  "/views/v_medcius_patient": [{ id: "patient-synthetic-1", name: "合成", id_card: "110101199003072378", age: 67 }],
  "/views/v_medcius_encounter": [{ id: "encounter-synthetic-1", status: "in-progress" }],
  "/views/v_medcius_nis_vitals": [],
  "/views/v_medcius_lis_results": [],
  "/views/v_medcius_his_orders": [],
  "/views/v_medcius_pacs_reports": viewLibraryFixture.routes["/views/v_medcius_pacs_reports"],
  "/views/v_medcius_notes": viewLibraryFixture.routes["/views/v_medcius_notes"],
};
const strictConnectors = createViewLibraryConnectors({
  baseUrl: "https://views.sandbox.local/",
  fetchImpl: replayFetch(leakingRows),
  extraViews: ["pacs", "notes"],
});
assert.equal(strictConnectors.length, 7);
const strictBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter"],
  connectors: strictConnectors,
});
const strictSnapshot = await strictBridge.readPatientSnapshot(context);
assert.ok(!JSON.stringify(strictSnapshot.dataFeeds.patient).includes("110101199003072378"), "non-allowlisted columns must never enter the envelope");
assert.equal(strictSnapshot.dataFeeds.pacs.length, 1);
assert.equal(strictSnapshot.dataFeeds.notes.length, 1);
assert.equal(strictSnapshot.dataFeeds.pacs[0].status, "preliminary");
assert.throws(
  () => createViewLibraryConnectors({ queryView: async () => [], extraViews: ["pacs", "pacs"] }),
  /CONNECTOR_VIEW_EXTRA_DUPLICATE/,
);
assert.throws(
  () => createViewLibraryConnectors({ queryView: async () => [], extraViews: ["billing"] }),
  /CONNECTOR_VIEW_EXTRA_UNKNOWN/,
);
let lisAttempts = 0;
const flakyFetch = async (url, init) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("v_medcius_lis_results")) {
    lisAttempts++;
    if (lisAttempts === 1) return { ok: false, status: 503, json: async () => ({}) };
  }
  return replayFetch(viewLibraryFixture.routes)(url, init);
};
const flakyBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter", "lis"],
  connectors: createViewLibraryConnectors({ baseUrl: "https://views.sandbox.local/", fetchImpl: flakyFetch }),
});
const flakySnapshot = await flakyBridge.readPatientSnapshot(context);
assert.equal(flakySnapshot.dataFeeds.lis.length, 2, "transient 503 must be retried once");
console.log("✓ Field allowlist held; pacs/notes opt-in served; 503 retried");

// ----------------------------------------------------
// Test 15: P4 HL7v2 subscription replay through the bridge
// ----------------------------------------------------
console.log("\n[Test 15] P4 HL7v2 ADT/ORU/RDE replay through the bridge...");
assert.equal(parseHl7v2MessageType(hl7v2Fixture.adt), "ADT^A01");
assert.equal(parseHl7v2MessageType(hl7v2Fixture.oru), "ORU^R01");
assert.equal(parseHl7v2MessageType(hl7v2Fixture.rde), "RDE^O11");
const hl7Bodies = { "msg-adt-1": hl7v2Fixture.adt, "msg-oru-1": hl7v2Fixture.oru, "msg-rde-1": hl7v2Fixture.rde };
const hl7Adt = createHl7v2Connectors({
  listMessages: async () => [{ id: "msg-adt-1" }],
  loadMessage: async (_context, entry) => hl7Bodies[entry.id],
  sourceVersion: hl7v2Fixture.source_version,
}).filter((connector) => connector.kind === "patient" || connector.kind === "encounter");
const hl7Or = createHl7v2Connectors({
  listMessages: async () => [{ id: "msg-oru-1" }],
  loadMessage: async (_context, entry) => hl7Bodies[entry.id],
  sourceVersion: hl7v2Fixture.source_version,
}).filter((connector) => connector.kind === "lis");
const hl7Rx = createHl7v2Connectors({
  listMessages: async () => [{ id: "msg-rde-1" }],
  loadMessage: async (_context, entry) => hl7Bodies[entry.id],
  sourceVersion: hl7v2Fixture.source_version,
}).filter((connector) => connector.kind === "his");
const hl7Bridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter", "lis", "his"],
  connectors: [...hl7Adt, ...hl7Or, ...hl7Rx],
});
const hl7Snapshot = await hl7Bridge.readPatientSnapshot(context);
assert.equal(hl7Snapshot.dataFeeds.patient.id, "patient-synthetic-1");
assert.equal(hl7Snapshot.dataFeeds.encounter.id, "encounter-synthetic-1");
const hl7K = hl7Snapshot.dataFeeds.lis.find((record) => record.code === "2823-3");
assert.equal(hl7K.result_value, 2.4);
assert.equal(hl7K.is_critical, true, "OBX LL flag must map to is_critical");
assert.ok(hl7Snapshot.dataFeeds.his_orders.some((record) => record.drug_name === "注射用头孢曲松钠（合成）"));
const wrongAdtBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient"],
  connectors: createHl7v2Connectors({
    listMessages: async () => [{ id: "msg-adt-1" }],
    loadMessage: async () => hl7v2Fixture.adt.replaceAll("patient-synthetic-1", "someone-else"),
  }).filter((connector) => connector.kind === "patient"),
});
await assert.rejects(() => wrongAdtBridge.readPatientSnapshot(context), /BRIDGE_PATIENT_MISMATCH/);
const badTypeBridge = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["lis"],
  connectors: createHl7v2Connectors({
    listMessages: async () => [{ id: "msg-adt-1" }],
    loadMessage: async () => hl7v2Fixture.adt,
  }).filter((connector) => connector.kind === "lis"),
});
await assert.rejects(() => badTypeBridge.readPatientSnapshot(context), /CONNECTOR_HL7V2_TYPE_UNSUPPORTED/);
assert.throws(() => parseHl7v2MessageType("PID|1||x"), /CONNECTOR_HL7V2_MSH_REQUIRED/);
console.log("✓ HL7v2 ADT/ORU/RDE parsed to bridge envelopes; mismatches fail closed");

// ----------------------------------------------------
// Test 16: site connector factory assembles guarded bridges
// ----------------------------------------------------
console.log("\n[Test 16] Site factory binds activation to guarded connectors...");
const siteActivation = {
  hospital_id: "HOSP-001",
  tenant_id: "sandbox-hospital",
  ward_id: "cardio-2",
  irb_protocol_id: "IRB-2026-001",
  data_agreement_sha256: "b".repeat(64),
  clinical_surface: "his_embed",
  governance_stage: "silent_pilot",
  readonly_account: { username: "medcius_readonly", capabilities: ["read"], system: "view_library" },
};
const { bridge: siteBridge, channel: siteChannel, connectors: siteConnectors } = createSiteBridge(siteActivation, {
  channel: "view-library",
  baseUrl: "https://views.sandbox.local/",
  fetchImpl: replayFetch(viewLibraryFixture.routes),
  salt: GUARD_SALT,
});
assert.equal(siteChannel, "view-library");
const siteSnapshot = await siteBridge.readPatientSnapshot(context);
assert.equal(siteSnapshot.completeness, "complete_for_configured_connectors");
// Exit guard proof: read one connector directly — the envelope must carry the guard stamp.
const directEnvelope = await siteConnectors[0].readPatient(context);
assert.equal(directEnvelope.phi_exit_guard?.applied, true);
assert.equal(directEnvelope.phi_exit_guard?.mode, "pseudonymize");
assert.throws(
  () => createSiteBridge(siteActivation, { channel: "hl7-fhir-x", salt: GUARD_SALT }),
  /SITE_FACTORY_CHANNEL_UNKNOWN/,
);
assert.throws(
  () => createSiteBridge({ ...siteActivation, irb_protocol_id: "" }, { channel: "view-library", salt: GUARD_SALT }),
  /SITE_ACTIVATION_IRB_PROTOCOL_ID_REQUIRED/,
);
assert.throws(
  () => createSiteBridge(siteActivation, { channel: "fhir-r4", baseUrl: "http://ehr.example.com/fhir", salt: GUARD_SALT }),
  /CONNECTOR_HTTP_PLAINTEXT_REJECTED/,
);
console.log("✓ Factory produced an exit-guarded bridge; bad activation/channel/baseUrl rejected");

console.log("\nALL REAL-SYSTEM INTEGRATION CONNECTOR TESTS PASSED!\n");


