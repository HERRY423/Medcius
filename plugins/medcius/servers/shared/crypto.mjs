// Medcius shared crypto helpers (node:crypto only, no deps).
// Consumers: phiguard (HMAC pseudonymization), audit (hash chain), future
// field-level at-rest encryption. Everything here is pure/synchronous.

import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/** sha256 hex of a string or Buffer. */
export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic JSON with sorted object keys — the canonical form that
 * payload_hash / snapshot hashes are computed over. Two writes of the same
 * logical content must produce the same hash regardless of key insertion order.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/**
 * Truncated HMAC-SHA256 hex — stable per-key pseudonymization tokens.
 * @param {string} key
 * @param {string} message
 * @param {number} [hexLen=8]
 */
export function hmacHex(key, message, hexLen = 8) {
  return createHmac("sha256", key).update(message).digest("hex").slice(0, hexLen);
}

export function ephemeralSalt() {
  return randomBytes(16).toString("hex");
}

/**
 * AES-256-GCM field-level encryption. Key must be 32 bytes (64 hex chars).
 * Envelope: `v1.<iv12>.<tag16>.<ciphertext>` all hex.
 */
export function aesGcmEncrypt(keyHex, plaintext) {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("aesGcmEncrypt: key must be 64 hex chars (32 bytes)");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `v1.${iv.toString("hex")}.${tag.toString("hex")}.${data.toString("hex")}`;
}

export function aesGcmDecrypt(keyHex, envelope) {
  const key = Buffer.from(keyHex, "hex");
  const [v, ivHex, tagHex, dataHex] = String(envelope).split(".");
  if (v !== "v1" || !ivHex || !tagHex || !dataHex) throw new Error("aesGcmDecrypt: bad envelope");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([d.update(Buffer.from(dataHex, "hex")), d.final()]).toString("utf8");
}
