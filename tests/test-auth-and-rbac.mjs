// Test Suite for SMART on FHIR / OIDC Auth, RBAC, Multi-Tenant Isolation & Production Gate

import assert from "node:assert/strict";
import { startServer, createServer } from "../plugins/medcius/servers/api/src/server.mjs";
import { generateToken, verifyToken, ROLES, authorizeRequest, extractAuthContext } from "../plugins/medcius/servers/api/src/auth-middleware.mjs";

console.log("== Testing SMART/OIDC Authentication, RBAC & Multi-Tenant Isolation ==");

// Test 1: JWT Generation, Verification & Issuer/Audience Validation
console.log("\n[Test 1] JWT Generation, Issuer & Audience Validation...");
const token = generateToken({
  sub: "PHARM-8801",
  name: "张药师",
  tenant_id: "hospital_peking_union",
  roles: [ROLES.PHARMACIST],
});

const verified = verifyToken(token);
assert.equal(verified.valid, true, "JWT token must be valid");
assert.equal(verified.payload.sub, "PHARM-8801");
assert.equal(verified.payload.tenant_id, "hospital_peking_union");
assert.deepEqual(verified.payload.roles, [ROLES.PHARMACIST]);

// Test 1b: Reject invalid signature or tampered token
const tamperedToken = token.slice(0, -5) + "abcde";
const badSig = verifyToken(tamperedToken);
assert.equal(badSig.valid, false);
console.log("✓ SMART/OIDC JWT generated, verified, and tampered token rejected");

// Test 2: RBAC Role Authorization Matrix (Default Closed)
console.log("\n[Test 2] RBAC Authorization Matrix & Default Closed Security...");
const unauthContext = { isAuthenticated: false, user: "anonymous", roles: [], tenantId: "default" };
const physicianContext = { isAuthenticated: true, user: "DOC-101", roles: [ROLES.PHYSICIAN], tenantId: "h1" };
const pharmacistContext = { isAuthenticated: true, user: "PHARM-202", roles: [ROLES.PHARMACIST], tenantId: "h1" };
const auditorContext = { isAuthenticated: true, user: "AUDIT-303", roles: [ROLES.AUDITOR], tenantId: "h1" };

// Anonymous caller is strictly denied (401)
const unauthCheck = authorizeRequest(unauthContext, "prescription:review");
assert.equal(unauthCheck.allowed, false);
assert.equal(unauthCheck.status, 401);

// Physician can review prescription but cannot signoff
assert.equal(authorizeRequest(physicianContext, "prescription:review").allowed, true);
assert.equal(authorizeRequest(physicianContext, "audit:signoff").allowed, false);

// Pharmacist can review and signoff
assert.equal(authorizeRequest(pharmacistContext, "prescription:review").allowed, true);
assert.equal(authorizeRequest(pharmacistContext, "audit:signoff").allowed, true);

// Auditor can query audit & verify chain but cannot review prescriptions directly
assert.equal(authorizeRequest(auditorContext, "audit:query").allowed, true);
assert.equal(authorizeRequest(auditorContext, "prescription:review").allowed, false);
console.log("✓ RBAC permissions and default-closed model correctly enforce role boundaries");

// Test 3: Tenant Binding Mismatch Check
console.log("\n[Test 3] Tenant Binding Mismatch Validation...");
const reqMismatch = {
  headers: {
    authorization: `Bearer ${token}`, // token tenant is 'hospital_peking_union'
    "x-tenant-id": "hospital_west_china", // header says different hospital!
  },
};
const ctxMismatch = extractAuthContext(reqMismatch);
assert.equal(ctxMismatch.isAuthenticated, false);
assert.equal(ctxMismatch.tenantMismatch, true);
const authMismatch = authorizeRequest(ctxMismatch, "prescription:review");
assert.equal(authMismatch.allowed, false);
assert.equal(authMismatch.status, 403);
console.log("✓ Tenant mismatch between token claim and X-Tenant-ID header strictly blocked (403 Forbidden)");

// Test 4: Integration with Live API Server
console.log("\n[Test 4] Testing Live Server with Auth, Multi-Tenancy & Production Gate...");
const { server, port, host } = await startServer(0, "127.0.0.1");
const baseUrl = `http://${host}:${port}`;

try {
  // Test 4a: Unauthenticated call to review prescription -> Must return 401
  console.log("\n  [4a] Unauthenticated request rejection (401)...");
  const unauthRes = await fetch(`${baseUrl}/api/v1/prescription/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patient: { age: 50, sex_cn: "男" },
      diagnoses: ["高血压"],
      drugs: ["氨氯地平片"],
    }),
  });
  assert.equal(unauthRes.status, 401, "Unauthenticated request must be rejected with 401");
  console.log("  ✓ Unauthenticated request rejected with HTTP 401");

  // Test 4b: Call with token but without include_samples (Production Gate Block)
  console.log("\n  [4b] Production Gate enforcement (default include_samples=false)...");
  const gateRes = await fetch(`${baseUrl}/api/v1/prescription/review`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "X-Tenant-ID": "hospital_peking_union",
    },
    body: JSON.stringify({
      patient: { age: 50, sex_cn: "男" },
      diagnoses: ["高血压"],
      drugs: ["氨氯地平片"],
    }),
  });
  // Official drug labels is 0 in test environment -> Must return 428 Precondition Required
  assert.equal(gateRes.status, 428, "Must halt with 428 when official corpus is missing and include_samples=false");
  const gateJson = await gateRes.json();
  assert.equal(gateJson.error, "PRODUCTION_GATE_HALT");
  console.log("  ✓ Production Gate halted invalid production review when official corpus is empty");

  // Test 4c: Explicit development test with include_samples=true & Bearer token
  console.log("\n  [4c] Review with explicit include_samples=true & Bearer token...");
  const authRes = await fetch(`${baseUrl}/api/v1/prescription/review`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "X-Tenant-ID": "hospital_peking_union",
    },
    body: JSON.stringify({
      patient: { age: 50, sex_cn: "男", weightKg: 70 },
      diagnoses: ["2型糖尿病"],
      drugs: ["二甲双胍片"],
      include_samples: true,
    }),
  });
  assert.equal(authRes.status, 200);
  const authJson = await authRes.json();
  assert.ok(authJson.verdict);
  assert.equal(authJson.audit?.event?.tenant_id, "hospital_peking_union", "Tenant ID must be propagated to audit trail");
  console.log(`  ✓ Review completed with tenant isolation [hospital_peking_union], verdict: ${authJson.verdict}`);

  // Test 4d: Multi-tenant isolated event querying
  console.log("\n  [4d] Querying tenant-isolated audit logs...");
  const queryRes = await fetch(`${baseUrl}/api/v1/audit/events?tenant_id=hospital_peking_union`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(queryRes.status, 200);
  const queryJson = await queryRes.json();
  assert.ok(queryJson.events.every((e) => e.tenant_id === "hospital_peking_union" || !e.tenant_id));
  console.log(`  ✓ Tenant audit query returned ${queryJson.events.length} scoped events`);

  console.log("\nALL AUTH, RBAC, TENANT BINDING & PRODUCTION GATE TESTS PASSED!");
} finally {
  server.close();
}
