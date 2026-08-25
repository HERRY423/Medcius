// Integration test for Medcius HTTP / REST & CDS Hooks API

import assert from "node:assert/strict";
import { startServer } from "../plugins/medcius/servers/api/src/server.mjs";
import { generateToken, ROLES } from "../plugins/medcius/servers/api/src/auth-middleware.mjs";

console.log("== Testing RESTful & CDS Hooks Server Endpoints ==");

// Generate valid client bearer token for authenticated requests
const token = generateToken({
  sub: "DOC-TEST-001",
  name: "测试医师",
  roles: [ROLES.PHYSICIAN, ROLES.PHARMACIST, ROLES.AUDITOR],
  tenant_id: "test_hospital",
});
const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
  "X-Tenant-ID": "test_hospital",
};

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
  assert.ok(cdsJson.services.length >= 1);
  console.log(`✓ /cds-services returned ${cdsJson.services.length} services`);

  // Test 3: POST /cds-services/medcius-patient-evolution
  console.log("\n[Test 3] POST /cds-services/medcius-patient-evolution...");
  const hookRes = await fetch(`${baseUrl}/cds-services/medcius-patient-evolution`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      hook: "patient-view",
      context: {
        patientId: "P-1001",
        patient: { age: 60, gender: "male", name: "王**" },
        observations: [{ name: "Scr", code: "scr", value: 92, unit: "μmol/L" }],
      },
    }),
  });
  assert.equal(hookRes.status, 200);
  const hookJson = await hookRes.json();
  assert.ok(Array.isArray(hookJson.cards));
  console.log(`✓ CDS Hook returned card: ${hookJson.cards[0]?.summary}`);
  assert.ok(Array.isArray(hookJson.cards));
  console.log(`✓ CDS Hook returned card: ${hookJson.cards[0]?.summary}`);

  // Test 4: POST /api/v1/prescription/review
  console.log("\n[Test 4] POST /api/v1/prescription/review...");
  const rxRes = await fetch(`${baseUrl}/api/v1/prescription/review`, {
    method: "POST",
    headers: authHeaders,
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
    headers: authHeaders,
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
    headers: authHeaders,
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
  const verifyRes = await fetch(`${baseUrl}/api/v1/audit/verify`, {
    headers: authHeaders,
  });
  assert.equal(verifyRes.status, 200);
  const verifyJson = await verifyRes.json();
  assert.equal(verifyJson.ok, true);
  console.log(`✓ /api/v1/audit/verify: chain intact`);

  console.log("\nALL REST & CDS HOOKS ENDPOINT TESTS PASSED!");
} finally {
  server.close();
}
