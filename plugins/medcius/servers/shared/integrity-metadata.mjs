// Cryptographic representation classification, NOT authenticity/authorization.
// Exact field names + exact encoding only. Never exempt free text, identifier
// fields, arbitrary *hash names, or objects nested beneath a metadata key.
import { createPublicKey } from 'node:crypto';

const SHA256_FIELDS = new Set([
  'sha256', 'approval_sha256', 'data_agreement_sha256', 'content_sha256', 'doc_sha256',
  'dossier_sha256', 'envelope_sha256', 'expected_sha256', 'file_sha256', 'input_sha256',
  'output_sha256', 'packet_sha256', 'payload_sha256', 'record_sha256', 'replay_input_sha256',
  'row_sha256', 'source_sha256', 'sources_sha256', 'summary_sha256',
  'chain_hash', 'content_hash', 'context_hash', 'envelope_hash', 'evidence_hash', 'head_hash',
  'item_hash', 'payload_hash', 'prev_hash', 'provenance_hash', 'signed_hash', 'signoff_head_hash', 'snapshot_hash',
  'config_digest', 'document_snapshot_digest', 'event_digest', 'event_history_digest', 'fluid_digest',
  'history_digest', 'output_digest', 'packet_digest', 'payload_digest', 'reason_digest', 'record_digest',
  'row_digest', 'snapshot_digest', 'vitals_digest',
]);
const PUBLIC_KEY_FIELDS = new Set(['public_key', 'publicKey', 'public_key_pem', 'signer_public_key']);

function p256DerSignature(value) {
  if (!/^[A-Za-z0-9+/]{8,96}={0,2}$/.test(value)) return false;
  const b = Buffer.from(value, 'base64');
  if (b.toString('base64') !== value || b.length < 8 || b.length > 72 || b[0] !== 0x30 || b[1] !== b.length - 2) return false;
  let pos = 2;
  for (let n = 0; n < 2; n++) {
    if (b[pos++] !== 0x02) return false;
    const length = b[pos++];
    if (!length || length > 33 || pos + length > b.length || b[pos] >= 128) return false;
    if (length > 1 && b[pos] === 0 && b[pos + 1] < 128) return false;
    if (length === 33 && b[pos] !== 0) return false;
    pos += length;
  }
  return pos === b.length;
}

export function isIntegrityMetadata(key, value, record = {}) {
  if (typeof value !== 'string') return false;
  if (SHA256_FIELDS.has(key)) return /^[a-fA-F0-9]{64}$/.test(value);
  if (key === 'signature' && record.signature_algorithm === 'HMAC_SHA256') return /^[a-fA-F0-9]{64}$/.test(value);
  if (key === 'signature' && record.signature_algorithm === 'ECDSA_P256_SHA256') return p256DerSignature(value);
  if (PUBLIC_KEY_FIELDS.has(key) && value.length <= 8192 && /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(value)) {
    try { createPublicKey(value); return true; } catch { return false; }
  }
  return false;
}
