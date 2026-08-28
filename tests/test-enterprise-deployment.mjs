// Test Suite: Enterprise Deployment & Identity / mTLS / Skill Catalog Governance
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { IdpJwksVerifier } from "../plugins/medcius/lib/idp-jwks-verifier.mjs";
import { MtlsGatewayGuard } from "../plugins/medcius/lib/mtls-gateway-guard.mjs";
import { ClinicalSkillCatalog } from "../plugins/medcius/lib/clinical-skill-catalog.mjs";

console.log("================================================================================");
console.log(" Medcius Enterprise Deployment & Edge Security Integration Tests");
console.log("================================================================================\n");

// --- 1. Test IdpJwksVerifier ---
console.log("▶ [Group 1] Enterprise IdP / JWKS Token Verification Tests...");

// Generate RSA key pair for testing
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const verifier = new IdpJwksVerifier({
  allowedAudiences: ["medcius-plugin"],
  allowedTenants: ["hospital-alpha", "hospital-beta"],
});

const ISSUER_URL = "https://idp.hospital-alpha.org/oauth2";
verifier.registerTrustedIssuer(ISSUER_URL, {
  staticKeys: {
    "key-2026-01": publicKey,
  },
  tenantId: "hospital-alpha",
});

function createTestJwt(payloadOverrides = {}, headerOverrides = {}) {
  const header = { alg: "RS256", typ: "JWT", kid: "key-2026-01", ...headerOverrides };
  const payload = {
    iss: ISSUER_URL,
    aud: "medcius-plugin",
    sub: "PRACTITIONER-007",
    name: "Dr. Zhang",
    tenant_id: "hospital-alpha",
    roles: ["physician", "inpatient:read"],
    exp: Math.floor(Date.now() / 1000) + 3600, // +1 hour
    nbf: Math.floor(Date.now() / 1000) - 60,
    ...payloadOverrides,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signedData = `${headerB64}.${payloadB64}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signedData);
  const signature = signer.sign(privateKey).toString("base64url");

  return `${signedData}.${signature}`;
}

// 1.1 Valid Token
const validToken = createTestJwt();
const validRes = verifier.verifyToken(validToken, { expectedTenant: "hospital-alpha", requiredRole: "physician" });
assert.equal(validRes.isValid, true, `Valid token should pass: ${validRes.error}`);
assert.equal(validRes.claims.sub, "PRACTITIONER-007");
assert.equal(validRes.claims.tenant_id, "hospital-alpha");
console.log("  ✓ Test 1.1: Valid enterprise IdP JWT verified successfully with RS256.");

// 1.2 Expired Token Fail-Closed
const expiredToken = createTestJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
const expiredRes = verifier.verifyToken(expiredToken);
assert.equal(expiredRes.isValid, false);
assert.match(expiredRes.error, /expired/i);
console.log("  ✓ Test 1.2: Expired token correctly rejected.");

// 1.3 Untrusted Issuer Fail-Closed
const untrustedIssuerToken = createTestJwt({ iss: "https://evil-idp.com" });
const untrustedRes = verifier.verifyToken(untrustedIssuerToken);
assert.equal(untrustedRes.isValid, false);
assert.match(untrustedRes.error, /Untrusted or unregistered/i);
console.log("  ✓ Test 1.3: Untrusted IdP issuer correctly rejected.");

// 1.4 Tenant Isolation Violation Fail-Closed
const tenantRes = verifier.verifyToken(validToken, { expectedTenant: "hospital-beta" });
assert.equal(tenantRes.isValid, false);
assert.match(tenantRes.error, /Tenant isolation violation/i);
console.log("  ✓ Test 1.4: Cross-tenant unauthorized access correctly blocked.");

// 1.5 Missing Required Role Fail-Closed
const roleRes = verifier.verifyToken(validToken, { requiredRole: "admin:super" });
assert.equal(roleRes.isValid, false);
assert.match(roleRes.error, /Missing required role/i);
console.log("  ✓ Test 1.5: Insufficient RBAC role correctly rejected.");


// --- 2. Test MtlsGatewayGuard ---
console.log("\n▶ [Group 2] On-Premises mTLS Zero-Trust Gateway Guard Tests...");

const gatewayGuard = new MtlsGatewayGuard({
  approvedFingerprints: ["AA11BB22CC33DD44EE55FF66"],
  approvedOrganizations: ["National Cardiovascular Center"],
});

// 2.1 Valid Client Certificate
const validTlsContext = {
  authorized: true,
  peerCertificate: {
    fingerprint256: "AA:11:BB:22:CC:33:DD:44:EE:55:FF:66",
    valid_from: "2026-01-01T00:00:00Z",
    valid_to: "2027-01-01T00:00:00Z",
    serialNumber: "SN-998877",
    subject: {
      CN: "cardiology-edge-gateway-01",
      O: "National Cardiovascular Center",
      OU: "Inpatient Ward 2",
    },
  },
};

const mtlsRes = gatewayGuard.verifyClientTls(validTlsContext, { expectedTenant: "Ward 2" });
assert.equal(mtlsRes.isAuthorized, true, `Valid mTLS cert should pass: ${mtlsRes.error}`);
assert.equal(mtlsRes.clientContext.common_name, "cardiology-edge-gateway-01");
console.log("  ✓ Test 2.1: Valid hospital mTLS client certificate verified.");

// 2.2 Unapproved Fingerprint Fail-Closed
const unapprovedFpTlsContext = {
  authorized: true,
  peerCertificate: {
    fingerprint256: "00:11:22:33:44:55:66:77:88:99:AA:BB",
    subject: { O: "National Cardiovascular Center" },
  },
};
const unapprovedFpRes = gatewayGuard.verifyClientTls(unapprovedFpTlsContext);
assert.equal(unapprovedFpRes.isAuthorized, false);
assert.match(unapprovedFpRes.error, /fingerprint/i);
console.log("  ✓ Test 2.2: Unapproved certificate fingerprint rejected.");

// 2.3 Expired Certificate Fail-Closed
const expiredTlsContext = {
  authorized: true,
  peerCertificate: {
    fingerprint256: "AA:11:BB:22:CC:33:DD:44:EE:55:FF:66",
    valid_from: "2025-01-01T00:00:00Z",
    valid_to: "2025-12-31T23:59:59Z", // Expired
    subject: { O: "National Cardiovascular Center" },
  },
};
const expiredMtlsRes = gatewayGuard.verifyClientTls(expiredTlsContext);
assert.equal(expiredMtlsRes.isAuthorized, false);
assert.match(expiredMtlsRes.error, /expired/i);
console.log("  ✓ Test 2.3: Expired mTLS certificate rejected.");


// --- 3. Test ClinicalSkillCatalog Governance ---
console.log("\n▶ [Group 3] Clinical Skill Catalog Governance & Kill-Switch Tests...");

const catalog = new ClinicalSkillCatalog({
  catalog_id: "test-ward-catalog",
  hospital_scope: "Ward 2",
  version: "1.0.0",
  skills: [
    {
      skill_id: "patient-evolution-summary",
      version: "1.0.0",
      status: "approved",
      approval_metadata: { approved_by: "Dr. Zhang", approval_role: "Chief", committee: "QA", approval_date: "2026-08-25", content_hash: "hash" },
    },
    {
      skill_id: "experimental-research-skill",
      version: "0.5.0",
      status: "candidate",
      approval_metadata: { approved_by: "", approval_role: "", committee: "", approval_date: "", content_hash: "" },
    },
  ],
});

// 3.1 Approved Skill in Production
const approvedCheck = catalog.isSkillApproved("patient-evolution-summary", "production");
assert.equal(approvedCheck.isEligible, true);
console.log("  ✓ Test 3.1: Approved skill passes in production mode.");

// 3.2 Candidate Skill in Production Fail-Closed
const candidateCheck = catalog.isSkillApproved("experimental-research-skill", "production");
assert.equal(candidateCheck.isEligible, false);
console.log("  ✓ Test 3.2: Candidate skill blocked in production mode.");

// 3.3 Emergency Kill-Switch
catalog.disableSkill("patient-evolution-summary", "Urgent clinical safety advisory");
const disabledCheck = catalog.isSkillApproved("patient-evolution-summary", "production");
assert.equal(disabledCheck.isEligible, false);
assert.match(disabledCheck.reason, /administratively disabled/i);
console.log("  ✓ Test 3.3: Emergency kill-switch immediately disables skill.");

// 3.4 Re-enable Skill
catalog.enableSkill("patient-evolution-summary");
const reenabledCheck = catalog.isSkillApproved("patient-evolution-summary", "production");
assert.equal(reenabledCheck.isEligible, true);
console.log("  ✓ Test 3.4: Re-enabling skill restores production eligibility.");

console.log("\n================================================================================");
console.log("🎉 ALL ENTERPRISE DEPLOYMENT & EDGE GOVERNANCE TESTS PASSED!");
console.log("================================================================================\n");
