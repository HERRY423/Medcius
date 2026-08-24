// Medcius AES-256-GCM Secure Storage Helper
// Used to protect sensitive clinical payloads and audit extracts at rest.
// Zero external dependencies; uses node:crypto via shared/crypto.mjs.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sha256Hex, aesGcmEncrypt, aesGcmDecrypt, canonicalJson, ephemeralSalt } from "./crypto.mjs";

let EPHEMERAL_KEY = null;

export function resolveKeyHex(explicit) {
  if (typeof explicit === "string" && explicit.length === 64 && /^[0-9a-fA-F]+$/.test(explicit)) {
    return explicit;
  }
  if (process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY)) {
    return process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY;
  }
  if (process.env.CLAUDE_MEDCIUS_PHI_SALT) {
    // Derive a stable 32-byte (64 hex) key from the salt
    return sha256Hex(`medcius-encryption-v1:${process.env.CLAUDE_MEDCIUS_PHI_SALT}`);
  }
  if (!EPHEMERAL_KEY) {
    EPHEMERAL_KEY = sha256Hex(`ephemeral-session-key:${ephemeralSalt()}`);
  }
  return EPHEMERAL_KEY;
}

export function encryptPayload(data, keyHex = null) {
  const k = resolveKeyHex(keyHex);
  const jsonStr = canonicalJson(data);
  const encrypted = aesGcmEncrypt(k, jsonStr);
  return {
    encrypted,
    payload_hash: sha256Hex(jsonStr),
    key_derived: Boolean(!keyHex && (process.env.CLAUDE_MEDCIUS_ENCRYPTION_KEY || process.env.CLAUDE_MEDCIUS_PHI_SALT)),
  };
}

export function decryptPayload(envelope, keyHex = null) {
  const k = resolveKeyHex(keyHex);
  const decryptedStr = aesGcmDecrypt(k, envelope);
  return JSON.parse(decryptedStr);
}

export class SecureRecordStore {
  constructor(filePath, keyHex = null) {
    this.filePath = filePath;
    this.keyHex = resolveKeyHex(keyHex);
  }

  save(data) {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const { encrypted, payload_hash } = encryptPayload(data, this.keyHex);
    writeFileSync(this.filePath, JSON.stringify({ version: "v1", payload_hash, data: encrypted }, null, 2), "utf8");
    return { path: this.filePath, payload_hash };
  }

  load() {
    if (!existsSync(this.filePath)) return null;
    const raw = readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.data) {
      return decryptPayload(parsed.data, this.keyHex);
    }
    return null;
  }
}
