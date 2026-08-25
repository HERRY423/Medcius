// Test suite for HL7 FHIR CDS Hooks Server endpoints & logic
// Tests: patient-view (Flagship Inpatient Pre-Round Evolution Summary) & Fail-Closed validation

import assert from "node:assert/strict";
import { CDS_SERVICES, handleCdsHookRequest } from "../plugins/medcius/servers/api/src/cds-hooks.mjs";

console.log("== Testing CDS Hooks 1.0/2.0 Flagship Integration ==");

// Test 1: Discovery Catalog
console.log("\n[Test 1] Discovery catalog schema...");
assert.ok(Array.isArray(CDS_SERVICES));
const evoService = CDS_SERVICES.find((s) => s.id === "medcius-patient-evolution");
assert.ok(evoService, "Must publish flagship medcius-patient-evolution service");
assert.equal(evoService.hook, "patient-view");
assert.ok(evoService.prefetch.patient);
console.log(`✓ Discovery catalog valid: ${evoService.title}`);

// Test 2: Fail-Closed on Missing User and Patient Context
console.log("\n[Test 2] Testing Fail-Closed on missing user and patient context...");

// 2a. Missing userId
const noUserPayload = {
  hook: "patient-view",
  hookInstance: "inst-nouser-001",
  context: { patientId: "pat-8890" },
};
const noUserRes = await handleCdsHookRequest("medcius-patient-evolution", noUserPayload);
assert.ok(noUserRes.cards[0].summary.includes("未检出操作医师身份上下文"), "Must fail-closed when userId is missing");
console.log(`✓ Fail-Closed on missing user: returned '${noUserRes.cards[0].summary}'`);

// 2b. Missing patientId
const emptyPayload = {
  hook: "patient-view",
  hookInstance: "inst-empty-001",
  user: "Practitioner/dr-lin",
  context: { userId: "Practitioner/dr-lin" }, // missing patientId and patient
};
const emptyRes = await handleCdsHookRequest("medcius-patient-evolution", emptyPayload);
assert.ok(Array.isArray(emptyRes.cards));
assert.equal(emptyRes.cards.length, 1);
assert.ok(emptyRes.cards[0].summary.includes("未检出有效患者上下文"), "Must fail-closed when patient ID is missing");
console.log(`✓ Fail-Closed on missing patient: returned '${emptyRes.cards[0].summary}' without fabricating synthetic data`);

// Test 3: Patient-view Hook with Real FHIR Observations (Dynamic LIS Ranges) & Medications
console.log("\n[Test 3] Patient-view Hook call with FHIR-like context and dynamic LIS ranges...");
const validPayload = {
  hook: "patient-view",
  hookInstance: "inst-valid-002",
  user: "Practitioner/dr-lin",
  context: {
    patientId: "pat-8890",
    patient: {
      id: "pat-8890",
      name: "李** (脱敏)",
      gender: "male",
      age: 62,
      bed_number: "08床",
      primary_diagnosis: "急性冠脉综合征，高血压3级",
      weight_kg: 68,
    },
    observations: [
      {
        id: "obs-01",
        name: "血肌酐 (Scr)",
        code: "scr",
        value: 135,
        unit: "μmol/L",
        referenceRange: [{ low: { value: 59, unit: "μmol/L" }, high: { value: 104, unit: "μmol/L" } }],
        effective_time: new Date().toISOString(),
      },
      {
        id: "obs-02",
        name: "血肌酐 (Scr)",
        code: "scr",
        value: 82,
        unit: "μmol/L",
        referenceRange: [{ low: { value: 59, unit: "μmol/L" }, high: { value: 104, unit: "μmol/L" } }],
        effective_time: new Date(Date.now() - 48 * 3600000).toISOString(),
      },
    ],
    medications: [
      {
        id: "med-01",
        drug_name: "阿司匹林肠溶片",
        dosage: "100mg",
        route: "po",
        frequency: "qd",
        change_type: "added",
        authored_on: new Date().toISOString(),
      },
    ],
    diagnosticReports: [
      { id: "rep-01", name: "冠脉 CTA", status: "preliminary", ordered_at: new Date().toISOString() },
    ],
    orders: [
      { id: "ord-01", title: "心电监护", status: "active", scheduled_time: "持续监护" },
    ],
    allergies: ["青霉素"],
  },
};

const evoRes = await handleCdsHookRequest("medcius-patient-evolution", validPayload);
assert.ok(Array.isArray(evoRes.cards), "Response must contain cards array");
assert.equal(evoRes.cards.length, 1);

const card = evoRes.cards[0];
console.log(`✓ CDS Card Generated:`);
console.log(`  - Summary: ${card.summary}`);
console.log(`  - Indicator: ${card.indicator}`);
console.log(`  - Link: ${card.links[0]?.url}`);
assert.ok(card.summary.includes("08床"));
assert.ok(card.detail.includes("血肌酐"));
assert.ok(card.links[0]?.url.includes("/sidebar?patient_id=pat-8890"));

console.log("\nALL CDS HOOKS TESTS PASSED!");
