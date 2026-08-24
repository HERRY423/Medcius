// Test suite for HL7 FHIR CDS Hooks Server endpoints & logic

import assert from "node:assert/strict";
import { CDS_SERVICES, handleCdsHookRequest } from "../plugins/medcius/servers/api/src/cds-hooks.mjs";

console.log("== Testing CDS Hooks 1.0/2.0 Integration ==");

// Test 1: Discovery Catalog
console.log("\n[Test 1] Discovery catalog schema...");
assert.ok(Array.isArray(CDS_SERVICES));
assert.ok(CDS_SERVICES.length >= 2);

const rxService = CDS_SERVICES.find((s) => s.id === "medcius-prescription-review");
assert.ok(rxService, "Must have medcius-prescription-review service");
assert.equal(rxService.hook, "medication-prescribe");
assert.ok(rxService.prefetch.patient);
console.log(`✓ Discovery catalog valid with ${CDS_SERVICES.length} services`);

// Test 2: Medication-prescribe Hook with Drug Interactions / Duplication
console.log("\n[Test 2] Medication-prescribe Hook call with FHIR-like context...");
const hookPayload = {
  hook: "medication-prescribe",
  hookInstance: "d157640c-03d2-4b78-b114-16a75f11ff22",
  user: "Practitioner/dr-li",
  context: {
    patientId: "pat-1001",
    patient: {
      gender: "male",
      age: 65,
      weightKg: 72,
      scrUmolL: 90,
    },
    conditions: [
      { code: { text: "2型糖尿病" } },
      { code: { text: "高血压" } },
    ],
    draftOrders: {
      entry: [
        { resource: { medicationCodeableConcept: { text: "二甲双胍片" } } },
        { resource: { medicationCodeableConcept: { text: "阿托伐他汀钙片" } } },
      ],
    },
    allergies: ["磺胺类"],
  },
};

const hookRes = await handleCdsHookRequest("medcius-prescription-review", hookPayload);
assert.ok(Array.isArray(hookRes.cards), "Response must contain cards array");
assert.ok(hookRes.cards.length > 0, "Should generate at least one CDS Card");

const card = hookRes.cards[0];
console.log(`✓ CDS Card Generated:`);
console.log(`  - Summary: ${card.summary}`);
console.log(`  - Indicator: ${card.indicator}`);
console.log(`  - Source: ${card.source?.label}`);
assert.ok(["info", "warning", "critical"].includes(card.indicator));

// Test 3: Order-sign Hook
console.log("\n[Test 3] Order-sign Hook call with diagnoses & procedures...");
const signPayload = {
  hook: "order-sign",
  user: "Practitioner/dr-li",
  context: {
    patient: { gender: "male", age: 65 },
    diagnoses: ["冠状动脉粥样硬化性心脏病", "2型糖尿病"],
    procedures: ["经皮冠状动脉支架植入术"],
  },
};

const signRes = await handleCdsHookRequest("medcius-order-sign", signPayload);
assert.ok(signRes.cards.length > 0);
console.log(`✓ Order-sign Card: ${signRes.cards[0].summary}`);

console.log("\nALL CDS HOOKS TESTS PASSED!");
