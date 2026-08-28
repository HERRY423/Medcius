// Test Suite: Cross-Hospital Migration & Heterogeneous Data Dialect Compatibility
// Validates: Zero-code kernel migration between Hospital Alpha (FHIR R4) and Hospital Beta (CDA / HL7 Document).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReadOnlyHospitalDataBridge } from "../plugins/medcius/lib/read-only-hospital-data-bridge.mjs";
import { createFhirR4Connectors } from "../plugins/medcius/lib/connectors/fhir-r4-connector.mjs";
import { createCdaDocumentConnector } from "../plugins/medcius/lib/connectors/cda-document-connector.mjs";
import { PatientEvolutionEngine } from "../plugins/medcius/lib/patient-evolution-engine.mjs";

console.log("================================================================================");
console.log(" Medcius Cross-Hospital Migration & Multi-Dialect Compatibility Tests");
console.log(" Goal: Verify contract-equivalence across distinct hospital data architectures");
console.log("================================================================================\n");

const fhirFixture = JSON.parse(readFileSync(fileURLToPath(new URL("../plugins/medcius/fixtures/connectors/fhir-r4-replay.json", import.meta.url)), "utf8"));
const cdaFixture = JSON.parse(readFileSync(fileURLToPath(new URL("../plugins/medcius/fixtures/connectors/cda-replay.json", import.meta.url)), "utf8"));

function replayFetch(routes) {
  return async (url, init) => {
    const parsed = new URL(url);
    const payload = routes[parsed.pathname] || Object.entries(routes).find(([key]) => parsed.pathname.endsWith(key))?.[1];
    if (!payload) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => payload };
  };
}

// --- Scenario 1: Hospital Alpha (Standard FHIR R4 Pipeline) ---
console.log("▶ [Scenario 1] Hospital Alpha (Standard FHIR R4 Architecture)...");

const contextAlpha = {
  tenant_id: "hospital-alpha",
  doctor_id: "doc-alpha-1",
  patient_id: "patient-synthetic-1",
  encounter_id: "encounter-synthetic-1",
  time_window: "24h",
};

const fhirConnectors = createFhirR4Connectors({
  baseUrl: "https://fhir.hospital-alpha.org/r4",
  fetchImpl: replayFetch(fhirFixture.routes),
  sourceVersion: fhirFixture.source_version,
});

const bridgeAlpha = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["patient", "encounter", "lis", "his"],
  connectors: fhirConnectors,
});

const alphaSnapshot = await bridgeAlpha.readPatientSnapshot(contextAlpha);
assert.equal(alphaSnapshot.context.tenant_id, "hospital-alpha");
assert.ok(alphaSnapshot.dataFeeds.patient);
assert.ok(alphaSnapshot.dataFeeds.lis.length >= 2);

const summaryAlpha = PatientEvolutionEngine.analyzePatientEvolution({
  patient: { id: contextAlpha.patient_id, name: alphaSnapshot.dataFeeds.patient.name || "患者-Alpha", bed_number: "Card-01" },
  timeWindow: "24h",
  notes: [{ id: "N-A-01", text: "患者病情稳定，心肌标志物复查提示演变。", timestamp: "2026-08-27T08:00:00Z" }],
  observations: alphaSnapshot.dataFeeds.lis.map((r) => ({
    id: r.id,
    code: r.name || r.code,
    value: r.result_value,
    unit: r.unit,
    effectiveDateTime: r.collected_at || "2026-08-27T08:00:00Z",
    referenceRange: { low: 57, high: 111 },
  })),
  medications: alphaSnapshot.dataFeeds.his_orders.map((r) => ({
    id: r.id,
    medication: r.medication_name,
    status: r.status,
    start_time: r.start_time,
  })),
  diagnosticReports: [],
  orders: [],
  allergies: [],
});

assert.ok(summaryAlpha.blocks.what_changed);
console.log("  ✓ Hospital Alpha: FHIR R4 bridge extracted and normalized successfully.");


// --- Scenario 2: Hospital Beta (Heterogeneous CDA Document Channel) ---
console.log("\n▶ [Scenario 2] Hospital Beta (Heterogeneous CDA / HL7 Narrative Pipeline)...");

const contextBeta = {
  tenant_id: "hospital-beta",
  doctor_id: "doc-beta-1",
  patient_id: "patient-synthetic-1",
  encounter_id: "encounter-synthetic-1",
  time_window: "24h",
};

const cdaConnector = createCdaDocumentConnector({
  id: "cda-channel-beta",
  sourceVersion: cdaFixture.source_version,
  async listDocuments(ctx) {
    return cdaFixture.documents.map((d) => ({ id: d.id, title: d.title, content_type: d.content_type }));
  },
  async loadDocument(ctx, doc) {
    const matched = cdaFixture.documents.find((d) => d.id === doc.id);
    return matched?.body || "";
  },
});

const bridgeBeta = new ReadOnlyHospitalDataBridge({
  requiredKinds: ["notes"],
  connectors: [cdaConnector],
});

const betaSnapshot = await bridgeBeta.readPatientSnapshot(contextBeta);
assert.equal(betaSnapshot.context.tenant_id, "hospital-beta");
assert.ok(betaSnapshot.dataFeeds.notes.length >= 1);

const summaryBeta = PatientEvolutionEngine.analyzePatientEvolution({
  patient: { id: contextBeta.patient_id, name: "患者-Beta", bed_number: "Card-08" },
  timeWindow: "24h",
  notes: betaSnapshot.dataFeeds.notes.map((r) => ({ id: r.id, text: r.text, timestamp: "2026-08-27T08:00:00Z" })),
  observations: [],
  medications: [],
  diagnosticReports: [],
  orders: [],
  allergies: [],
});

assert.ok(summaryBeta.blocks.what_changed);
console.log("  ✓ Hospital Beta: CDA document bridge extracted and normalized successfully.");


// --- Scenario 3: Zero-Code Migration & Contract Invariance ---
console.log("\n▶ [Scenario 3] Contract Invariance & Schema Uniformity Check...");

const alphaKeys = Object.keys(summaryAlpha.blocks).sort();
const betaKeys = Object.keys(summaryBeta.blocks).sort();
assert.deepEqual(alphaKeys, betaKeys, "Output contract blocks must be strictly invariant across hospitals");
assert.equal(summaryAlpha.contract_version, summaryBeta.contract_version);

console.log(`  ✓ Both hospital architectures emit identical contract blocks: [${alphaKeys.join(", ")}]`);
console.log("  ✓ Zero code modifications required in core clinical workflow engine for cross-hospital migration.");

console.log("\n================================================================================");
console.log("🎉 ALL CROSS-HOSPITAL MIGRATION & COMPATIBILITY TESTS PASSED!");
console.log("================================================================================\n");
