// Medcius Verifiable Digital Signature Module
// Cryptographically binds clinical review verdicts and pharmacist sign-offs to clinician public keys.
// Complies with Chinese Electronic Signature Law (电子签名法) & SAMD regulatory traceability.

import { generateKeyPairSync, createSign, createVerify } from "node:crypto";
import { canonicalJson, sha256Hex } from "./crypto.mjs";

const DEFAULT_ALGORITHM = "ECDSA_P256_SHA256";

// In-memory / keystore cache for registered signer public keys (Key ID -> PEM)
const SIGNER_KEYSTORE = new Map();

/**
 * Generate an asymmetric keypair for a healthcare professional (pharmacist/doctor).
 * Default: ECDSA with prime256v1 (NIST P-256).
 */
export function generateKeyPair(signerId = "default-signer") {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const keyId = `key:${signerId}:${sha256Hex(publicKey).slice(0, 12)}`;
  SIGNER_KEYSTORE.set(keyId, {
    keyId,
    signerId,
    publicKey,
    createdAt: new Date().toISOString(),
  });

  return { keyId, signerId, publicKey, privateKey };
}

/**
 * Register an existing public key for verification.
 */
export function registerPublicKey(keyId, signerId, publicKeyPem) {
  SIGNER_KEYSTORE.set(keyId, {
    keyId,
    signerId,
    publicKey: publicKeyPem,
    registeredAt: new Date().toISOString(),
  });
}

/**
 * Get registered public key by key ID.
 */
export function getPublicKey(keyId) {
  return SIGNER_KEYSTORE.get(keyId) || null;
}

/**
 * Compute the canonical digest of a clinical decision or sign-off payload.
 */
export function computeDecisionDigest(payload) {
  const canon = typeof payload === "string" ? payload : canonicalJson(payload);
  return sha256Hex(canon);
}

/**
 * Sign a clinical payload or digest with a private key.
 */
export function signDecision({
  payload,
  privateKeyPem,
  keyId,
  signer,
  role = "pharmacist",
}) {
  if (!privateKeyPem) {
    throw new Error("signDecision: privateKeyPem is required for digital signature");
  }

  const signedHash = computeDecisionDigest(payload);
  const signerStr = `${signer}|${role}|${signedHash}`;

  const signerSign = createSign("SHA256");
  signerSign.update(signerStr);
  signerSign.end();

  const signature = signerSign.sign(privateKeyPem, "base64");

  return {
    signature,
    signature_algorithm: DEFAULT_ALGORITHM,
    key_id: keyId || `key:${signer}:dynamic`,
    signed_hash: signedHash,
    signer,
    role,
    signed_at: new Date().toISOString(),
  };
}

/**
 * Verify a digital signature against the payload and signer's public key.
 */
export function verifyDecisionSignature({
  payload,
  signature,
  publicKeyPem,
  keyId,
  signer,
  role = "pharmacist",
  signedHash,
}) {
  if (!signature) {
    return { valid: false, reason: "Missing signature" };
  }

  let pubKey = publicKeyPem;
  if (!pubKey && keyId) {
    const record = SIGNER_KEYSTORE.get(keyId);
    if (record) pubKey = record.publicKey;
  }

  if (!pubKey) {
    return { valid: false, reason: `Public key not found for key_id: ${keyId}` };
  }

  const expectedHash = payload ? computeDecisionDigest(payload) : signedHash;
  if (signedHash && payload && signedHash !== expectedHash) {
    return { valid: false, reason: "Payload hash mismatch against signed_hash" };
  }

  const signerStr = `${signer}|${role}|${expectedHash}`;

  try {
    const verifier = createVerify("SHA256");
    verifier.update(signerStr);
    verifier.end();

    const valid = verifier.verify(pubKey, signature, "base64");
    return {
      valid,
      key_id: keyId,
      signer,
      role,
      signed_hash: expectedHash,
      reason: valid ? "Signature verified successfully" : "Cryptographic signature verification failed",
    };
  } catch (err) {
    return { valid: false, reason: `Verification error: ${err.message}` };
  }
}
