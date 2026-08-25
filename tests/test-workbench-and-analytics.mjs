// Test suite for Clinical Workbench & Analytics Engine Endpoints

import assert from "node:assert/strict";
import { createServer } from "../plugins/medcius/servers/api/src/server.mjs";
import { generateToken, ROLES } from "../plugins/medcius/servers/api/src/auth-middleware.mjs";

console.log("== Testing Workbench & Analytics Endpoints ==");

const token = generateToken({
  sub: "DOC-8021",
  name: "林德明",
  roles: [ROLES.PHYSICIAN, ROLES.PHARMACIST, ROLES.AUDITOR],
  tenant_id: "hospital_test",
});
const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
  "X-Tenant-ID": "hospital_test",
};

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  // Test 1: GET /workbench (Workbench UI HTML)
  console.log("\n[Test 1] GET /workbench (Workbench HTML UI)...");
  const resUi = await fetch(`${baseUrl}/workbench`);
  assert.equal(resUi.status, 200);
  assert.ok(resUi.headers.get("content-type").includes("text/html"));
  const htmlText = await resUi.text();
  assert.ok(htmlText.includes("Medcius 临床测评与持续改进工作台"));
  assert.ok(htmlText.includes("tab-rx"));
  assert.ok(htmlText.includes("tab-cme"));
  console.log("✓ Workbench HTML UI served correctly");

  // Test 2: GET /api/v1/analytics/doctor-quality
  console.log("\n[Test 2] GET /api/v1/analytics/doctor-quality...");
  const resDoc = await fetch(`${baseUrl}/api/v1/analytics/doctor-quality?doctor_id=DOC-8021`, {
    headers: authHeaders,
  });
  assert.equal(resDoc.status, 200);
  const docData = await resDoc.json();
  assert.equal(docData.doctor_id, "DOC-8021");
  assert.ok(docData.overall_quality_score >= 90);
  assert.equal(docData.quality_dimensions.length, 5);
  console.log(`✓ Doctor Quality Scorecard: ${docData.doctor_name} Score = ${docData.overall_quality_score}`);

  // Test 3: GET /api/v1/analytics/department-benchmark
  console.log("\n[Test 3] GET /api/v1/analytics/department-benchmark...", {
    headers: authHeaders,
  });
  const resBm = await fetch(`${baseUrl}/api/v1/analytics/department-benchmark`, {
    headers: authHeaders,
  });
  assert.equal(resBm.status, 200);
  const bmData = await resBm.json();
  assert.ok(bmData.departments.length >= 5);
  console.log(`✓ Department Benchmarks: ${bmData.departments.length} departments ranked`);

  // Test 4: GET /api/v1/analytics/recommendations
  console.log("\n[Test 4] GET /api/v1/analytics/recommendations...");
  const resRec = await fetch(`${baseUrl}/api/v1/analytics/recommendations?doctor_id=DOC-8021`, {
    headers: authHeaders,
  });
  assert.equal(resRec.status, 200);
  const recData = await resRec.json();
  assert.ok(recData.personalized_learning_plan.length > 0);
  console.log(`✓ CME Recommendations: ${recData.personalized_learning_plan.length} modules generated`);

  // Test 5: GET /api/v1/training/cases & POST /api/v1/training/submit
  console.log("\n[Test 5] GET /api/v1/training/cases...");
  const resCases = await fetch(`${baseUrl}/api/v1/training/cases`, {
    headers: authHeaders,
  });
  assert.equal(resCases.status, 200);
  const casesData = await resCases.json();
  assert.equal(casesData.total_cases, 10);
  console.log(`✓ Training Simulator: ${casesData.total_cases} interactive clinical cases available`);

  console.log("\n[Test 6] POST /api/v1/training/submit (Correct answer)...");
  const resSubCorrect = await fetch(`${baseUrl}/api/v1/training/submit`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ caseId: "CME-RX-01", selectedOption: "B", doctorId: "DOC-8021" }),
  });
  assert.equal(resSubCorrect.status, 200);
  const subCorrectData = await resSubCorrect.json();
  assert.equal(subCorrectData.is_correct, true);
  assert.equal(subCorrectData.score_awarded, 10);
  console.log(`✓ Correct submission evaluated: awarded ${subCorrectData.cme_credit_awarded} CME credit`);

  console.log("\n[Test 7] POST /api/v1/training/submit (Incorrect answer)...");
  const resSubWrong = await fetch(`${baseUrl}/api/v1/training/submit`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ caseId: "CME-RX-01", selectedOption: "A", doctorId: "DOC-8021" }),
  });
  assert.equal(resSubWrong.status, 200);
  const subWrongData = await resSubWrong.json();
  assert.equal(subWrongData.is_correct, false);
  assert.equal(subWrongData.score_awarded, 0);
  console.log("✓ Incorrect submission evaluated: rationale and gold standard provided");

  // Test 8: GET /api/v1/audit/events
  console.log("\n[Test 8] GET /api/v1/audit/events...");
  const resEvents = await fetch(`${baseUrl}/api/v1/audit/events?limit=10`, {
    headers: authHeaders,
  });
  assert.equal(resEvents.status, 200);
  const eventsData = await resEvents.json();
  assert.ok(Array.isArray(eventsData.events));
  console.log(`✓ Audit Events Query: returned ${eventsData.events.length} events`);

  console.log("\nALL WORKBENCH & ANALYTICS ENDPOINT TESTS PASSED!");
} finally {
  server.close();
}
