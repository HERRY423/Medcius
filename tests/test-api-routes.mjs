// Integration test for Medcius HTTP / REST & CDS Hooks Flagship API

import assert from "node:assert/strict";
import { startServer } from "../plugins/medcius/servers/api/src/server.mjs";
import { generateToken, ROLES } from "../plugins/medcius/servers/api/src/auth-middleware.mjs";

console.log("== Testing RESTful & CDS Hooks Flagship Server Endpoints ==");

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
  assert.equal(healthJson.version, "0.2.0-pilot");
  assert.ok(healthJson.production_gate);
  console.log(`✓ /health responded 200 OK (version: ${healthJson.version})`);

  // Test 2: GET /sidebar (Flagship UI HTML)
  console.log("\n[Test 2] GET /sidebar...");
  const sidebarRes = await fetch(`${baseUrl}/sidebar`);
  assert.equal(sidebarRes.status, 200);
  const sidebarHtml = await sidebarRes.text();
  assert.ok(sidebarHtml.includes("发生了什么变化"));
  assert.ok(sidebarHtml.includes("今天仍待处理什么"));
  assert.ok(sidebarHtml.includes("哪些资料不足"));
  assert.ok(sidebarHtml.includes("查看原始证据"));
  console.log(`✓ /sidebar served 4-block one-screen EHR sidebar UI`);

  // Test 3: GET /cds-services (Discovery)
  console.log("\n[Test 3] GET /cds-services (Discovery)...");
  const cdsRes = await fetch(`${baseUrl}/cds-services`);
  assert.equal(cdsRes.status, 200);
  const cdsJson = await cdsRes.json();
  assert.ok(Array.isArray(cdsJson.services));
  assert.equal(cdsJson.services.length, 1);
  assert.equal(cdsJson.services[0].id, "medcius-patient-evolution");
  console.log(`✓ /cds-services returned ${cdsJson.services.length} flagship service: ${cdsJson.services[0].title}`);

  // Test 4: POST /cds-services/medcius-patient-evolution
  console.log("\n[Test 4] POST /cds-services/medcius-patient-evolution...");
  const hookRes = await fetch(`${baseUrl}/cds-services/medcius-patient-evolution`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      hook: "patient-view",
      context: {
        patientId: "P-1001",
        patient: { id: "P-1001", age: 60, gender: "male", name: "王**", bed_number: "03床" },
        observations: [{ name: "Scr", code: "scr", value: 92, unit: "μmol/L" }],
      },
    }),
  });
  assert.equal(hookRes.status, 200);
  const hookJson = await hookRes.json();
  assert.ok(Array.isArray(hookJson.cards));
  console.log(`✓ CDS Hook returned card: ${hookJson.cards[0]?.summary}`);

  // Test 5: GET /api/v1/patient/evolution-summary
  console.log("\n[Test 5] GET /api/v1/patient/evolution-summary...");
  const sumRes = await fetch(`${baseUrl}/api/v1/patient/evolution-summary?time_window=24h&patient_id=P-1001`, {
    headers: authHeaders,
  });
  assert.equal(sumRes.status, 200);
  const sumJson = await sumRes.json();
  assert.ok(sumJson.blocks.what_changed);
  assert.ok(sumJson.blocks.whats_pending);
  assert.ok(sumJson.blocks.data_gaps);
  assert.ok(sumJson.blocks.evidence);
  console.log(`✓ /api/v1/patient/evolution-summary returned ${sumJson.total_items_count} items`);

  // Test 6: POST /api/v1/patient/progress-note-draft
  console.log("\n[Test 6] POST /api/v1/patient/progress-note-draft...");
  const draftRes = await fetch(`${baseUrl}/api/v1/patient/progress-note-draft`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      summaryData: sumJson,
      selectedItemIds: sumJson.selectable_items.slice(0, 3).map((i) => i.id),
      doctorId: "DOC-TEST-001",
      doctorName: "测试医师",
    }),
  });
  assert.equal(draftRes.status, 200);
  const draftJson = await draftRes.json();
  assert.ok(draftJson.draft_text);
  console.log(`✓ /api/v1/patient/progress-note-draft generated physician-attributed draft`);

  // Test 7: GET /api/v1/audit/verify
  console.log("\n[Test 7] GET /api/v1/audit/verify...");
  const verifyRes = await fetch(`${baseUrl}/api/v1/audit/verify`, {
    headers: authHeaders,
  });
  assert.equal(verifyRes.status, 200);
  const verifyJson = await verifyRes.json();
  assert.equal(verifyJson.chain_intact, true);
  console.log(`✓ /api/v1/audit/verify: chain intact`);

  console.log("\nALL REST & CDS HOOKS ENDPOINT TESTS PASSED!");
} finally {
  server.close();
}
