// Integration test for Medcius HTTP / REST & CDS Hooks API

import assert from "node:assert/strict";
import { startServer } from "../plugins/medcius/servers/api/src/server.mjs";

console.log("== Testing RESTful & CDS Hooks Server Endpoints ==");

// Start ephemeral server on random port
const { server, port, host } = await startServer(0, "127.0.0.1");
const baseUrl = `http://${host}:${port}`;

try {
  // Test 1: GET /health
  console.log("\n[Test 1] GET /health...");
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.status, "ok");
  assert.ok(healthJson.production_gate);
  console.log(`✓ /health responded 200 OK`);

  // Test 2: GET /cds-services
  console.log("\n[Test 2] GET /cds-services (Discovery)...");
  const cdsRes = await fetch(`${baseUrl}/cds-services`);
  assert.equal(cdsRes.status, 200);
  const cdsJson = await cdsRes.json();
  assert.ok(Array.isArray(cdsJson.services));
  assert.ok(cdsJson.services.length >= 2);
  console.log(`✓ /cds-services returned ${cdsJson.services.length} services`);

  // Test 3: POST /cds-services/medcius-prescription-review
  console.log("\n[Test 3] POST /cds-services/medcius-prescription-review...");
  const hookRes = await fetch(`${baseUrl}/cds-services/medcius-prescription-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hook: "medication-prescribe",
      context: {
        patient: { age: 60, gender: "male", scrUmolL: 92 },
        diagnoses: ["高脂血症", "高血压"],
        drugs: ["阿托伐他汀钙片", "氨氯地平片"],
      },
    }),
  });
  assert.equal(hookRes.status, 200);
  const hookJson = await hookRes.json();
  assert.ok(Array.isArray(hookJson.cards));
  console.log(`✓ CDS Hook returned card: ${hookJson.cards[0]?.summary}`);

  // Test 4: POST /api/v1/prescription/review
  console.log("\n[Test 4] POST /api/v1/prescription/review...");
  const rxRes = await fetch(`${baseUrl}/api/v1/prescription/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patient: { age: 45, sex_cn: "男", weightKg: 68 },
      diagnoses: ["2型糖尿病"],
      drugs: ["二甲双胍片"],
      include_samples: true,
    }),
  });
  assert.equal(rxRes.status, 200);
  const rxJson = await rxRes.json();
  assert.ok(rxJson.verdict);
  console.log(`✓ /api/v1/prescription/review verdict: ${rxJson.verdict}`);

  // Test 5: POST /api/v1/coding/resolve
  console.log("\n[Test 5] POST /api/v1/coding/resolve...");
  const codeRes = await fetch(`${baseUrl}/api/v1/coding/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      diagnoses: ["2型糖尿病", "原发性高血压"],
      procedures: ["经皮冠状动脉介入治疗"],
      include_samples: true,
    }),
  });
  assert.equal(codeRes.status, 200);
  const codeJson = await codeRes.json();
  assert.ok(codeJson.items.length >= 2);
  console.log(`✓ /api/v1/coding/resolve resolved ${codeJson.items.length} items`);

  // Test 6: POST /api/v1/encounter/process
  console.log("\n[Test 6] POST /api/v1/encounter/process...");
  const encRes = await fetch(`${baseUrl}/api/v1/encounter/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      noteText: "出院记录\n性别：女  年龄：65岁\n出院诊断：\n1. 2型糖尿病\n手术操作：无",
      drugs: ["二甲双胍片"],
      includeSamples: true,
    }),
  });
  assert.equal(encRes.status, 200);
  const encJson = await encRes.json();
  assert.equal(encJson.status, "completed");
  assert.ok(encJson.summary);
  console.log(`✓ /api/v1/encounter/process completed in ${encJson.total_duration_ms}ms`);

  // Test 7: GET /api/v1/audit/verify
  console.log("\n[Test 7] GET /api/v1/audit/verify...");
  const auditRes = await fetch(`${baseUrl}/api/v1/audit/verify`);
  assert.equal(auditRes.status, 200);
  const auditJson = await auditRes.json();
  assert.equal(auditJson.ok, true);
  console.log(`✓ /api/v1/audit/verify chain verified: ${auditJson.checked} records checked`);

  console.log("\nALL REST & CDS HOOKS ENDPOINT TESTS PASSED!");
} finally {
  server.close();
}
