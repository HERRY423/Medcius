// Integration & Unit Tests for the Doctor Workstation (医生端内网工作台 · 缺口三):
// directory authentication (LDAP adapter + RBAC + lockout), governance-stage-aware
// workflow reports, CA signature signoff/verify (tamper evidence), and the
// workstation HTML surface. Complements test-api-routes.mjs (thin REST layer).

import assert from "node:assert/strict";
import { startServer } from "../plugins/medcius/servers/api/src/server.mjs";
import { generateToken, ROLES } from "../plugins/medcius/servers/api/src/auth-middleware.mjs";
import {
  createClinicianDirectoryAuth,
  createSyntheticClinicianDirectory,
} from "../plugins/medcius/lib/clinician-directory-auth.mjs";
import {
  createCaSignatureAdapter,
  internalEcCaProvider,
  SIGNATURE_RECORD_SCHEMA,
} from "../plugins/medcius/lib/ca-signature-adapter.mjs";
import { GovernanceStateManager } from "../plugins/medcius/lib/governance-mode.mjs";
import {
  setWorkstationDirectoryAuth,
  setWorkstationGovernance,
} from "../plugins/medcius/servers/api/src/workstation-routes.mjs";

console.log("== Testing Doctor Workstation (directory auth / CA signoff / governance gating) ==");

// ----------------------------------------------------
// Unit 1: clinician directory authentication
// ----------------------------------------------------
console.log("\n[Unit 1] Directory auth: role mapping, lockout, fail-closed paths...");
const directory = createSyntheticClinicianDirectory({
  clinicians: [
    { username: "8021", password: "synthetic-pass-1", employeeId: "EMP-8021", displayName: "林德明（合成）", department: "心血管内科", title: "主治医师" },
    { username: "3001", password: "synthetic-pass-2", employeeId: "EMP-3001", displayName: "王药师（合成）", department: "药剂科", title: "主管药师" },
    { username: "9001", password: "synthetic-pass-3", employeeId: "EMP-9001", displayName: "实习账号（合成）", department: "信息科", title: "工程师" },
  ],
});
const auth0 = createClinicianDirectoryAuth({
  directory,
  roleAssignments: [
    { match: { department: "心血管内科" }, roles: [ROLES.PHYSICIAN] },
    { match: { department: "药剂科" }, roles: [ROLES.PHARMACIST] },
  ],
  maxFailedAttempts: 3,
  lockoutSec: 120,
});

const physicianLogin = await auth0.login({ username: "8021", password: "synthetic-pass-1", tenantId: "sandbox-hospital" });
assert.deepEqual(physicianLogin.session.clinician.roles, [ROLES.PHYSICIAN]);
assert.equal(physicianLogin.session.clinician.tenantBoundRoleMapping ?? undefined, undefined);
const physicianSession = auth0.verifySession(physicianLogin.session.token);
assert.equal(physicianSession.valid, true);
assert.equal(physicianSession.session.clinician.id, "EMP-8021");

const pharmacistLogin = await auth0.login({ username: "3001", password: "synthetic-pass-2" });
assert.deepEqual(pharmacistLogin.session.clinician.roles, [ROLES.PHARMACIST]);

// no role mapped -> fail-closed (no implicit privileges)
await assert.rejects(() => auth0.login({ username: "9001", password: "synthetic-pass-3" }), /AUTH_NO_ROLE_MAPPED/);

// wrong password -> AUTH_INVALID_CREDENTIALS, repeated -> lockout
for (let i = 0; i < 3; i++) {
  await assert.rejects(() => auth0.login({ username: "8021", password: "wrong" }), /AUTH_INVALID_CREDENTIALS/);
}
await assert.rejects(() => auth0.login({ username: "8021", password: "synthetic-pass-1" }), /AUTH_LOCKED/);

// logout revokes the exact session token
auth0.logout(physicianLogin.session.token);
assert.equal(auth0.verifySession(physicianLogin.session.token).valid, false);

// directory transport outage -> distinct fail-closed code, no credential counting
const brokenAuth = createClinicianDirectoryAuth({
  directory: { id: "broken", async authenticate() { throw new Error("ldap down"); } },
  roleAssignments: [{ match: { department: "内科" }, roles: [ROLES.PHYSICIAN] }],
});
await assert.rejects(() => brokenAuth.login({ username: "8021", password: "x" }), /AUTH_DIRECTORY_UNAVAILABLE/);
console.log("✓ Directory auth: mapping, lockout, revocation, no-role fail-closed, outage code");

// ----------------------------------------------------
// Unit 2: CA signature adapter (internal provider + tamper evidence)
// ----------------------------------------------------
console.log("\n[Unit 2] CA adapter: sign/verify roundtrip, tamper detection, context fail-closed...");
const ca = createCaSignatureAdapter(); // internal-ec-p256 by default
const payload = { workflow_note: "合成报告", findings: ["血钾 2.4 mmol/L（LL，危急）"], gaps: [] };
const signed = await ca.createSignatureRecord({
  workflow: "evolution",
  payload,
  signerId: "EMP-8021",
  role: ROLES.PHYSICIAN,
  tenantId: "sandbox-hospital",
  signerNote: "已核对证据 span",
});
assert.equal(signed.signature_record.schema_version, SIGNATURE_RECORD_SCHEMA);
assert.equal(signed.signature_record.provider, "internal-ec-p256");
assert.equal(signed.signature_record.boundary.is_ehr_writeback, false, "signature record must never claim EHR writeback");

const verified = await ca.verifySignatureRecord({ record: signed.signature_record, payload });
assert.equal(verified.valid, true);

const tampered = await ca.verifySignatureRecord({ record: signed.signature_record, payload: { ...payload, findings: ["被篡改"] } });
assert.equal(tampered.valid, false);
assert.match(tampered.reason, /CA_PAYLOAD_DIGEST_MISMATCH/);

const unsignedRecord = JSON.parse(JSON.stringify(signed.signature_record));
unsignedRecord.signature = "tampered-signature";
const forged = await ca.verifySignatureRecord({ record: unsignedRecord, payload });
assert.equal(forged.valid, false);

await assert.rejects(() => ca.createSignatureRecord({ workflow: "evolution", payload, signerId: "x" }), /CA_(ROLE|TENANT)_REQUIRED/);

// hospital CA SDK contract (injected provider, e.g. CFCA P7/CMS adapter)
let verifyCalls = 0;
const hospitalCa = createCaSignatureAdapter({
  providerId: "hospital-ca-sdk",
  provider: {
    id: "hospital-ca-sdk",
    async sign({ payloadDigest }) {
      return { signature: `P7:${payloadDigest.slice(0, 12)}`, key_ref: "cert:sn=2026-0830", algorithm: "SM2_WITH_SM3", certificate_fingerprint: "fingerprint-hospital-ca" };
    },
    async verify({ signature }) {
      verifyCalls += 1;
      return { valid: signature?.startsWith("P7:"), reason: signature?.startsWith("P7:") ? "ok" : "bad cms" };
    },
  },
});
const hospitalSigned = await hospitalCa.createSignatureRecord({ workflow: "record-quality", payload: { ok: true }, signerId: "EMP-3001", role: ROLES.PHARMACIST, tenantId: "sandbox-hospital" });
assert.equal(hospitalSigned.signature_record.provider, "hospital-ca-sdk");
const hospitalVerified = await hospitalCa.verifySignatureRecord({ record: hospitalSigned.signature_record });
assert.equal(hospitalVerified.valid, true);
assert.equal(verifyCalls, 1);
console.log("✓ CA adapter: internal + hospital provider contract, tamper evidence, context fail-closed");

// ----------------------------------------------------
// HTTP: workstation surface end-to-end
// ----------------------------------------------------
console.log("\n[HTTP] Booting ephemeral server...");
const { server, port, host } = await startServer(0, "127.0.0.1");
const baseUrl = `http://${host}:${port}`;
const authHeadersFor = (token) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

try {
  // UI served
  const uiRes = await fetch(`${baseUrl}/workstation`);
  assert.equal(uiRes.status, 200);
  const uiHtml = await uiRes.text();
  assert.ok(uiHtml.includes("医生工作台"));
  assert.ok(uiHtml.includes("治理"));

  // login without directory -> explicit 501 (fail-closed, no demo backdoor)
  const noDirRes = await fetch(`${baseUrl}/workstation/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "x", password: "y" }) });
  assert.equal(noDirRes.status, 501);
  const noDirJson = await noDirRes.json();
  assert.match(noDirJson.error, /WORKSTATION_DIRECTORY_NOT_CONFIGURED/);

  // inject deployment directory adapter
  const deployed = createClinicianDirectoryAuth({
    directory,
    roleAssignments: [
      { match: { department: "心血管内科" }, roles: [ROLES.PHYSICIAN] },
      { match: { department: "药剂科" }, roles: [ROLES.PHARMACIST] },
    ],
  });
  setWorkstationDirectoryAuth(deployed);

  const loginRes = await fetch(`${baseUrl}/workstation/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "8021", password: "synthetic-pass-1", tenant_id: "sandbox-hospital" }) });
  assert.equal(loginRes.status, 200);
  const loginJson = await loginRes.json();
  assert.equal(loginJson.clinician.roles[0], ROLES.PHYSICIAN);
  const sessionToken = loginJson.token;

  // session introspection: default governance stage = retrospective (level 1)
  const sessionRes = await fetch(`${baseUrl}/workstation/session`, { headers: authHeadersFor(sessionToken) });
  assert.equal(sessionRes.status, 200);
  const sessionJson = await sessionRes.json();
  assert.equal(sessionJson.governance.stage_id, "retrospective_study");
  assert.equal(sessionJson.governance.can_sign_reports, false);

  // unauthenticated access rejected (default-closed)
  const anonSession = await fetch(`${baseUrl}/workstation/session`);
  assert.equal(anonSession.status, 401);

  // workflow: demo ward (synthetic sandbox, non-production only)
  const evolutionRes = await fetch(`${baseUrl}/workstation/evolution`, { method: "POST", headers: authHeadersFor(sessionToken), body: JSON.stringify({ demo_ward: true, time_window: "24h" }) });
  assert.equal(evolutionRes.status, 200);
  const evolutionJson = await evolutionRes.json();
  assert.equal(evolutionJson.workflow, "evolution");
  assert.ok(evolutionJson.payload_digest);
  assert.ok(evolutionJson.payload, "engine payload must be present");

  // record quality workflow
  const rqRes = await fetch(`${baseUrl}/workstation/record-quality`, { method: "POST", headers: authHeadersFor(sessionToken), body: JSON.stringify({ note_text: "出院记录\n性别：男 年龄：67岁\n入院日期：2024-08-01 出院日期：2024-08-10\n住院天数：3天\n离院方式：7\n出院诊断：新生儿肺炎" }) });
  assert.equal(rqRes.status, 200);
  const rqJson = await rqRes.json();
  assert.equal(rqJson.workflow, "record-quality");
  assert.ok(rqJson.payload.legality_conflicts.length >= 2, "illegal discharge method + neonatal conflict expected");

  // signoff blocked at level 1 with explicit stage name
  const signoffBlocked = await fetch(`${baseUrl}/workstation/signoff`, { method: "POST", headers: authHeadersFor(sessionToken), body: JSON.stringify({ workflow: "record-quality", payload: rqJson.payload, payload_digest: rqJson.payload_digest }) });
  assert.equal(signoffBlocked.status, 403);
  const blockedJson = await signoffBlocked.json();
  assert.equal(blockedJson.code, "STAGE_FORBIDDEN");
  assert.match(blockedJson.error, /回顾性研究/);

  // digest mismatch guard
  setWorkstationGovernance(new GovernanceStateManager("advisory_mode"));
  const digestGuard = await fetch(`${baseUrl}/workstation/signoff`, { method: "POST", headers: authHeadersFor(sessionToken), body: JSON.stringify({ workflow: "record-quality", payload: rqJson.payload, payload_digest: "0".repeat(64) }) });
  assert.equal(digestGuard.status, 400);
  assert.equal((await digestGuard.json()).code, "PAYLOAD_DIGEST_MISMATCH");

  // signoff succeeds at advisory mode (level 3)
  const signoffRes = await fetch(`${baseUrl}/workstation/signoff`, { method: "POST", headers: authHeadersFor(sessionToken), body: JSON.stringify({ workflow: "record-quality", payload: rqJson.payload, payload_digest: rqJson.payload_digest, signer_note: "已复核" }) });
  assert.equal(signoffRes.status, 200);
  const signatureRecord = await signoffRes.json();
  assert.equal(signatureRecord.schema_version, SIGNATURE_RECORD_SCHEMA);

  // verify roundtrip + tamper through the HTTP surface
  const verifyOk = await fetch(`${baseUrl}/workstation/signoff/verify`, { method: "POST", headers: authHeadersFor(sessionToken), body: JSON.stringify({ signature_record: signatureRecord, payload: rqJson.payload }) });
  assert.equal((await verifyOk.json()).valid, true);
  const verifyBad = await fetch(`${baseUrl}/workstation/signoff/verify`, { method: "POST", headers: authHeadersFor(sessionToken), body: JSON.stringify({ signature_record: signatureRecord, payload: { ...rqJson.payload, note_type: "changed" } }) });
  const badJson = await verifyBad.json();
  assert.equal(badJson.valid, false);
  assert.match(badJson.reason, /CA_PAYLOAD_DIGEST_MISMATCH/);

  // logout revokes the session on the server side
  await fetch(`${baseUrl}/workstation/logout`, { method: "POST", headers: authHeadersFor(sessionToken) });
  const afterLogout = await fetch(`${baseUrl}/workstation/session`, { headers: authHeadersFor(sessionToken) });
  assert.equal(afterLogout.status, 401);

  console.log("✓ Workstation HTTP surface: login/session/workflows/signoff-gating/verify/revocation");
} finally {
  // restore module-level deployment injections so other suites see defaults
  setWorkstationDirectoryAuth(null);
  setWorkstationGovernance(null);
  server.close();
}

console.log("\nALL DOCTOR WORKSTATION TESTS PASSED");
