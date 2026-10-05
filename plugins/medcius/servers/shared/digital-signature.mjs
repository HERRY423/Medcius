// Medcius Verifiable Digital Signature Module
// Cryptographically binds clinical review verdicts and pharmacist sign-offs to clinician public keys.
// Cryptographic integrity only; identity enrollment and legal validity require a trusted deployment.

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
  const previous = SIGNER_KEYSTORE.get(keyId);
  if (previous && (previous.signerId !== signerId || previous.publicKey !== publicKeyPem)) throw new Error("SIGNER_KEY_ALREADY_REGISTERED");
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

export const SIGNOFF_ENVELOPE_SCHEMA = "medcius.signoff-envelope.v1";
const SIGNOFF_FIELDS = ["schema", "event_id", "event_digest", "tenant_id", "signer", "role", "decision", "reason_digest", "signed_at", "replay_id"];

export function validateSignoffEnvelope(envelope) {
  if (!envelope || envelope.schema !== SIGNOFF_ENVELOPE_SCHEMA || Object.keys(envelope).some((key) => !SIGNOFF_FIELDS.includes(key))
    || SIGNOFF_FIELDS.some((key) => envelope[key] == null)
    || !Number.isSafeInteger(envelope.event_id) || envelope.event_id < 1
    || !/^[a-f0-9]{64}$/.test(envelope.event_digest) || !/^[a-f0-9]{64}$/.test(envelope.reason_digest)
    || !["pharmacist", "physician", "admin", "auditor"].includes(envelope.role)
    || !["agree", "override", "reject"].includes(envelope.decision)
    || ["tenant_id", "signer", "replay_id"].some((key) => typeof envelope[key] !== "string" || !envelope[key].trim())
    || typeof envelope.signed_at !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(envelope.signed_at) || !Number.isFinite(Date.parse(envelope.signed_at))) {
    throw new Error("SIGNOFF_ENVELOPE_INCOMPLETE");
  }
  return envelope;
}

/**
 * Canonical signoff envelope. A payload-only signature cannot verify as this.
 * signed_at and replay_id come from the signer; the server does not invent them.
 */
export function buildSignoffEnvelope({
  eventId,
  eventDigest,
  tenantId,
  signer,
  role,
  decision,
  reason = "",
  signedAt,
  replayId,
} = {}) {
  if (!eventId || !eventDigest || !tenantId || !signer || !role || !decision || !signedAt || !replayId) {
    throw new Error("SIGNOFF_ENVELOPE_INCOMPLETE");
  }
  const reasonDigest = sha256Hex(String(reason));
  const envelope = {
    schema: SIGNOFF_ENVELOPE_SCHEMA,
    event_id: Number(eventId),
    event_digest: eventDigest,
    tenant_id: tenantId,
    signer,
    role,
    decision,
    reason_digest: reasonDigest,
    signed_at: signedAt,
    replay_id: replayId,
  };
  validateSignoffEnvelope(envelope);
  return {
    envelope,
    reason_digest: reasonDigest,
    envelope_hash: sha256Hex(canonicalJson(envelope)),
  };
}

export function signSignoffEnvelope({ envelope, privateKeyPem, keyId, signer, role }) {
  validateSignoffEnvelope(envelope);
  if ((signer != null && signer !== envelope.signer) || (role != null && role !== envelope.role)) throw new Error("SIGNOFF_SIGNER_MISMATCH");
  if (!privateKeyPem) throw new Error("signSignoffEnvelope: privateKeyPem is required");
  const envelopeHash = sha256Hex(canonicalJson(envelope));
  const signedText = `${SIGNOFF_ENVELOPE_SCHEMA}|${envelopeHash}`;
  const signerSign = createSign("SHA256");
  signerSign.update(signedText);
  signerSign.end();
  return {
    signature: signerSign.sign(privateKeyPem, "base64"),
    signature_algorithm: DEFAULT_ALGORITHM,
    key_id: keyId || `key:${signer}:dynamic`,
    signed_hash: envelopeHash,
    envelope_hash: envelopeHash,
    signer: signer || envelope.signer,
    role: role || envelope.role,
    signed_at: envelope.signed_at,
    replay_id: envelope.replay_id,
  };
}

export function verifySignoffEnvelope({ envelope, signature, publicKeyPem, keyId }) {
  try { validateSignoffEnvelope(envelope); } catch (error) { return { valid: false, reason: error.message }; }
  if (!signature) return { valid: false, reason: "Missing signature" };
  let pubKey = publicKeyPem;
  if (keyId) {
    const registered = SIGNER_KEYSTORE.get(keyId);
    if (!registered || registered.signerId !== envelope.signer || (pubKey && pubKey !== registered.publicKey)) return { valid: false, reason: "SIGNOFF_UNTRUSTED_SIGNER_KEY" };
    pubKey = registered.publicKey;
  }
  if (!pubKey) return { valid: false, reason: `Public key not found for key_id: ${keyId}` };
  const envelopeHash = sha256Hex(canonicalJson(envelope));
  const signedText = `${SIGNOFF_ENVELOPE_SCHEMA}|${envelopeHash}`;
  try {
    const verifier = createVerify("SHA256");
    verifier.update(signedText);
    verifier.end();
    const valid = verifier.verify(pubKey, signature, "base64");
    return {
      valid,
      reason: valid ? "Signoff envelope verified" : "Cryptographic signature verification failed",
      envelope_hash: envelopeHash,
    };
  } catch (err) {
    return { valid: false, reason: `Verification error: ${err.message}` };
  }
}
