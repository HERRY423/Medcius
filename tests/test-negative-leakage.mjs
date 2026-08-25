// Negative Data Leakage & Security Robustness Test Suite
// Verifies that raw PHI (ID cards, mobile phones, bank cards, fixed phones) CANNOT bypass PHI Guard
// under any circumstance (including attempts with deprecated acknowledged flags or deeply nested JSON).

import assert from "node:assert/strict";
import { HANDLERS as auditHandlers } from "../plugins/medcius/servers/audit/src/tools.mjs";
import { scanText, redactText, pseudonymizeText, containsRawPhi } from "../plugins/medcius/servers/phiguard/src/lib.mjs";
import {
  generateKeyPair,
  signDecision,
  verifyDecisionSignature,
  registerPublicKey,
} from "../plugins/medcius/servers/shared/digital-signature.mjs";

console.log("== Running Negative PHI Leakage & Security Injection Tests ==");

// Test 1: Direct Injection of 18-digit ID Card in subject_ref
console.log("\n[Test 1] Attempting raw ID card in subject_ref...");
assert.throws(
  () => {
    auditHandlers.record_event({
      actor: "test:attacker",
      action: "malicious_probe",
      subject_ref: "110101199003072378",
      payload: { note: "clean payload" },
    });
  },
  /PHI guard/,
  "Must throw PHI guard error when raw 18-digit ID card is used in subject_ref",
);
console.log("✓ Raw ID card in subject_ref strictly blocked");

// Test 2: Direct Injection of Mobile Phone in payload
console.log("\n[Test 2] Attempting raw mobile phone in payload...");
assert.throws(
  () => {
    auditHandlers.record_event({
      actor: "test:attacker",
      action: "malicious_probe",
      subject_ref: "[PSN:valid-pseudo]",
      payload: { contact: "13812345678", comment: "doctor callback" },
    });
  },
  /PHI guard/,
  "Must throw PHI guard error when raw CN mobile phone number is in payload",
);
console.log("✓ Raw mobile phone in payload strictly blocked");

// Test 3: Attempting bypass via deprecated phi_guard='acknowledged'
console.log("\n[Test 3] Attempting bypass via phi_guard='acknowledged' with raw PHI...");
assert.throws(
  () => {
    auditHandlers.record_event({
      actor: "test:attacker",
      action: "malicious_probe",
      subject_ref: "[PSN:valid-pseudo]",
      phi_guard: "acknowledged",
      payload: { id_card: "110101199003072378" },
    });
  },
  /PHI guard/,
  "Must reject raw PHI even when phi_guard='acknowledged' is supplied",
);
console.log("✓ Acknowledged bypass loophole is completely eliminated");

// Test 4: Deeply Nested JSON PHI Injection
console.log("\n[Test 4] Attempting deeply nested JSON PHI injection...");
assert.throws(
  () => {
    auditHandlers.record_event({
      actor: "test:attacker",
      action: "nested_probe",
      subject_ref: "[PSN:valid-pseudo]",
      payload: {
        layer1: {
          layer2: {
            layer3: [
              { meta: "info" },
              { secret_card: "6222021234567890123" }, // Bank card
            ],
          },
        },
      },
    });
  },
  /PHI guard/,
  "Must detect and block bank card nested deep in JSON tree",
);
console.log("✓ Deeply nested JSON PHI strictly blocked");

// Test 5: Verified Pseudonymization & Redaction Path
console.log("\n[Test 5] Validating sanitized flow with proper pseudonymization...");
const rawClinical = "患者：李四  身份证：110101199003072378  电话：13900001111  诊断：高血压";
const safeSalt = "secure-random-test-salt-2026";
const psn = pseudonymizeText(rawClinical, { salt: safeSalt });

// Verify no raw PHI remains
assert.equal(containsRawPhi(psn.text).hit, false, "Pseudonymized text must contain zero raw PHI");
assert.ok(!psn.text.includes("110101199003072378"), "ID card must be tokenized");
assert.ok(!psn.text.includes("13900001111"), "Phone must be tokenized");

// Now record_event should succeed
const auditOk = auditHandlers.record_event({
  actor: "pharmacist:zhang",
  action: "clinical_review",
  subject_ref: "[PSN:verified-token]",
  payload: { summary: psn.text },
  tenant_id: "hospital_north_01",
});
assert.ok(auditOk.event_id > 0, "Properly sanitized payload must record successfully");
assert.equal(auditOk.tenant_id, "hospital_north_01", "Tenant ID must be stored");
console.log(`✓ Sanitized audit record stored: event_id=${auditOk.event_id}, seq=${auditOk.seq}`);

// Test 6: Digital Signature & Tamper Resistance
console.log("\n[Test 6] Testing digital signature creation & tamper resistance...");
const { keyId, privateKey, publicKey } = generateKeyPair("PHARM-007");
registerPublicKey(keyId, "PHARM-007", publicKey);

const clinicalVerdict = {
  prescriptionId: "RX-2026-9999",
  verdict: "FLAG",
  issues: ["CYP3A4 strong inhibitor combined with Simvastatin 40mg"],
  pharmacistAction: "Recommend switching to Rosuvastatin 10mg",
};

// Sign decision
const sig = signDecision({
  payload: clinicalVerdict,
  privateKeyPem: privateKey,
  keyId,
  signer: "PHARM-007",
  role: "pharmacist",
});
assert.ok(sig.signature, "Signature must be generated");

// Verify valid signature
const validRes = verifyDecisionSignature({
  payload: clinicalVerdict,
  signature: sig.signature,
  keyId,
  signer: "PHARM-007",
  role: "pharmacist",
  signedHash: sig.signed_hash,
});
assert.equal(validRes.valid, true, "Signature verification must succeed for untampered payload");

// Tamper test: modify payload
const tamperedVerdict = { ...clinicalVerdict, verdict: "PASS" };
const tamperedRes = verifyDecisionSignature({
  payload: tamperedVerdict,
  signature: sig.signature,
  keyId,
  signer: "PHARM-007",
  role: "pharmacist",
  signedHash: sig.signed_hash,
});
assert.equal(tamperedRes.valid, false, "Signature verification MUST fail when payload is tampered");
console.log("✓ Digital signature verified and tampering successfully detected");

// Test 7: Pharmacist Signoff with Digital Signature into Audit Chain
console.log("\n[Test 7] Testing signoff with verified digital signature...");
const ev7 = auditHandlers.get_event({ event_id: auditOk.event_id });
const sig7 = signDecision({
  payload: ev7.payload,
  privateKeyPem: privateKey,
  keyId,
  signer: "PHARM-007",
  role: "pharmacist",
});

const signoffRes = auditHandlers.signoff({
  event_id: auditOk.event_id,
  signer: "PHARM-007",
  role: "pharmacist",
  decision: "override",
  reason: "临床专科评估，患者肝肾功能及肌酸激酶正常，密切监护下维持方案",
  signature: sig7.signature,
  signature_algorithm: sig7.signature_algorithm,
  key_id: keyId,
  signed_hash: sig7.signed_hash,
  tenant_id: "hospital_north_01",
});
assert.equal(signoffRes.signature_verified, true, "Signoff signature must be cryptographically verified");
console.log(`✓ Signed signoff recorded: signoff_id=${signoffRes.signoff_id}`);

console.log("\nALL NEGATIVE LEAKAGE & SECURITY INJECTION TESTS PASSED!");
