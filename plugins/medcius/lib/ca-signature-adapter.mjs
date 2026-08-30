// Clinician CA Signature Adapter (CA 电子签名适配层 · 缺口三).
//
// Binds clinician confirmation of workstation reports to verifiable digital
// signatures, per 《中华人民共和国电子签名法》 and the D6 ladder
// (SAMD-PATHWAY §3.3): 认证签核写回 requires verifiable signatures.
//
// Architecture:
//   - `provider` interface = the hospital CA integration point. Hospitals plug
//     their CA SDK (CFCA/BJCA style, P7/CMS detached signatures) in via
//     `createCaSignatureAdapter({ provider })`; the adapter is CA-agnostic.
//   - `internalEcCaProvider()` is the built-in ECDSA P-256 provider (shared
//     digital-signature module). It is explicitly labelled
//     provider="internal-ec-p256": keys are generated in-process and are NOT
//     hospital-CA-issued certificates. Deployments must swap in the hospital
//     provider before any legally effective signoff (上线前检查清单项).
//   - A signature record binds { workflow, payload digest, signer, role,
//     tenant, provider, key/cert fingerprint, timestamp } — never the payload
//     itself, so no PHI enters the audit chain through signatures.
//
// Fail-closed: missing context (workflow/payload/signer/tenant) is rejected;
// any payload byte change invalidates the record (tamper evidence).

import { canonicalJson, sha256Hex } from "../servers/shared/crypto.mjs";
import { generateKeyPair, signDecision, verifyDecisionSignature, computeDecisionDigest } from "../servers/shared/digital-signature.mjs";

export const SIGNATURE_RECORD_SCHEMA = "medcius.clinician-signature-record.v1";

/**
 * Built-in ECDSA P-256 provider. `privateKeys` may be pre-seeded
 * { [signerId]: privateKeyPem } for deterministic tests / KMS-backed deployment.
 */
export function internalEcCaProvider({ privateKeys = new Map(), signerIds = [] } = {}) {
  const keys = new Map(privateKeys);
  const ensureKey = (signerId) => {
    if (!keys.has(signerId)) {
      const generated = generateKeyPair(signerId);
      keys.set(signerId, { privateKeyPem: generated.privateKey, publicKeyPem: generated.publicKey, keyId: generated.keyId });
    }
    return keys.get(signerId);
  };
  for (const signerId of signerIds) ensureKey(signerId);

  return {
    id: "internal-ec-p256",
    async sign({ payloadDigest, signerId, role }) {
      const key = ensureKey(signerId);
      const signed = signDecision({
        payload: payloadDigest,
        privateKeyPem: key.privateKeyPem,
        keyId: key.keyId,
        signer: signerId,
        role,
      });
      return {
        signature: signed.signature,
        key_ref: key.keyId,
        algorithm: signed.signature_algorithm,
        certificate_fingerprint: sha256Hex(key.publicKeyPem).slice(0, 16),
        // internal provider issues no X.509 certificate — explicit, not hidden
        certificate: null,
      };
    },
    async verify({ payloadDigest, signature, signerId, role, keyRef }) {
      const key = keys.get(signerId);
      const result = verifyDecisionSignature({
        payload: payloadDigest,
        signature,
        publicKeyPem: key?.publicKeyPem,
        keyId: keyRef,
        signer: signerId,
        role,
      });
      return { valid: result.valid === true, reason: result.reason };
    },
  };
}

/**
 * Create the CA signature adapter.
 *
 * @param {object} options
 * @param {{ id: string, sign: Function, verify: Function }} [options.provider] - hospital CA SDK adapter.
 * @param {string} [options.providerId]
 */
export function createCaSignatureAdapter({ provider, providerId } = {}) {
  const ca = provider ?? internalEcCaProvider();
  if (!ca || typeof ca.sign !== "function" || typeof ca.verify !== "function") {
    throw new Error("CA_PROVIDER_INTERFACE_INVALID: provider must implement sign() and verify()");
  }
  const resolvedProviderId = providerId ?? ca.id ?? "custom-ca";

  function requireContext({ workflow, payload, signerId, role, tenantId }) {
    if (typeof workflow !== "string" || !workflow.trim()) throw new Error("CA_WORKFLOW_REQUIRED");
    if (!payload || typeof payload !== "object") throw new Error("CA_PAYLOAD_REQUIRED");
    if (typeof signerId !== "string" || !signerId.trim()) throw new Error("CA_SIGNER_REQUIRED");
    if (typeof role !== "string" || !role.trim()) throw new Error("CA_ROLE_REQUIRED");
    if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("CA_TENANT_REQUIRED");
  }

  return {
    provider_id: resolvedProviderId,

    /**
     * Sign a clinician confirmation over a workflow report.
     * Returns a signature record (verifiable, tamper-evident, PHI-free).
     */
    async createSignatureRecord({ workflow, payload, signerId, role, tenantId, signerNote = null }) {
      requireContext({ workflow, payload, signerId, role, tenantId });
      const payloadDigest = computeDecisionDigest(payload);
      const signed = await ca.sign({ payloadDigest, signerId, role });
      if (!signed?.signature) throw new Error("CA_SIGN_FAILED");
      const record = {
        schema_version: SIGNATURE_RECORD_SCHEMA,
        workflow,
        payload_digest: payloadDigest,
        payload_algorithm: "sha256(canonical-json)",
        signer: { id: signerId, role, tenant_id: tenantId },
        signer_note: typeof signerNote === "string" && signerNote.trim() ? signerNote.trim() : null,
        provider: resolvedProviderId,
        key_ref: signed.key_ref ?? null,
        certificate_fingerprint: signed.certificate_fingerprint ?? null,
        certificate: signed.certificate ?? null,
        algorithm: signed.algorithm ?? "unknown",
        signature: signed.signature,
        signed_at: new Date().toISOString(),
        boundary: {
          is_ehr_writeback: false,
          note: "签名仅确认「报告内容由签名人核对确认」，不构成 EHR 写回；写回仍受治理阶梯 Level 4 与医院 CA 证书体系约束。",
        },
      };
      return {
        signature_record: record,
        audit_event: {
          action: "workstation_signoff",
          subject_ref: `PSN-SIGN-${sha256Hex(`${tenantId}|${signerId}`).slice(0, 12)}`,
          payload: { workflow, payload_digest: payloadDigest, provider: resolvedProviderId, key_ref: record.key_ref },
        },
      };
    },

    /**
     * Verify a signature record against (optionally) the payload.
     * With payload: digest mismatch fails first (tamper evidence), then signature.
     */
    async verifySignatureRecord({ record, payload = null }) {
      if (!record || record.schema_version !== SIGNATURE_RECORD_SCHEMA) {
        return { valid: false, reason: "CA_RECORD_SCHEMA_INVALID" };
      }
      if (payload != null) {
        const digest = computeDecisionDigest(payload);
        if (digest !== record.payload_digest) {
          return { valid: false, reason: "CA_PAYLOAD_DIGEST_MISMATCH: payload changed after signing (tamper evidence)" };
        }
      }
      const result = await ca.verify({
        payloadDigest: record.payload_digest,
        signature: record.signature,
        signerId: record.signer?.id,
        role: record.signer?.role,
        keyRef: record.key_ref,
      });
      return {
        valid: result.valid === true,
        reason: result.reason,
        record: {
          workflow: record.workflow,
          signer: record.signer,
          provider: record.provider,
          certificate_fingerprint: record.certificate_fingerprint,
          signed_at: record.signed_at,
        },
      };
    },
  };
}
