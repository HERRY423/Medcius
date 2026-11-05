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

import { randomUUID } from "node:crypto";
import { isProductionStoreProfile } from "../servers/shared/secure-store.mjs";
import { sha256Hex } from "../servers/shared/crypto.mjs";
import { generateKeyPair, signDecision, verifyDecisionSignature, computeDecisionDigest } from "../servers/shared/digital-signature.mjs";

export const SIGNATURE_RECORD_SCHEMA = "medcius.clinician-signature-record.v2";

/**
 * Built-in ECDSA P-256 provider. `privateKeys` may be pre-seeded
 * Map<signerId, { privateKeyPem, publicKeyPem, keyId }> for test key reuse.
 * This provider remains test_only even when keys are supplied.
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
    assurance: "test_only",
    async getSigningIdentity({ signerId }) {
      const key = ensureKey(signerId);
      return { key_ref: key.keyId, algorithm: "ECDSA_P256_SHA256", certificate_fingerprint: sha256Hex(key.publicKeyPem) };
    },
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
        certificate_fingerprint: sha256Hex(key.publicKeyPem),
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
 * @param {{ id: string, assurance: string, getSigningIdentity: Function, sign: Function, verify: Function }} [options.provider] - hospital CA SDK adapter.
 * @param {string} [options.providerId]
 * @param {'synthetic'|'hospital'} [options.profile]
 * @param {string|null} [options.requiredAlgorithm] exact deployment-approved algorithm identifier
 */
export function createCaSignatureAdapter({ provider, providerId, profile = "synthetic", requiredAlgorithm = null } = {}) {
  if (!["synthetic", "hospital"].includes(profile)) throw new Error("CA_PROFILE_INVALID");
  const ca = provider ?? internalEcCaProvider();
  if (!ca || typeof ca.sign !== "function" || typeof ca.verify !== "function" || typeof ca.getSigningIdentity !== "function") {
    throw new Error("CA_PROVIDER_INTERFACE_INVALID: provider must implement getSigningIdentity(), sign() and verify()");
  }
  const resolvedProviderId = providerId ?? ca.id ?? "custom-ca";

  function requireContext({ workflow, payload, signerId, role, tenantId }) {
    if (typeof workflow !== "string" || !workflow.trim()) throw new Error("CA_WORKFLOW_REQUIRED");
    if (!payload || typeof payload !== "object") throw new Error("CA_PAYLOAD_REQUIRED");
    if (typeof signerId !== "string" || !signerId.trim()) throw new Error("CA_SIGNER_REQUIRED");
    if (typeof role !== "string" || !role.trim()) throw new Error("CA_ROLE_REQUIRED");
    if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("CA_TENANT_REQUIRED");
  }

  const adapter = {
    provider_id: resolvedProviderId,

    /**
     * Sign a clinician confirmation over a workflow report.
     * Returns a signature record (verifiable, tamper-evident, PHI-free).
     */
    async createSignatureRecord({ workflow, payload, signerId, role, tenantId, signerNote = null }) {
      requireContext({ workflow, payload, signerId, role, tenantId });
      const hospital = profile === "hospital" || isProductionStoreProfile();
      if (hospital && ca.assurance !== "hospital_ca") throw new Error("CA_HOSPITAL_PROVIDER_REQUIRED");
      const payloadDigest = computeDecisionDigest(payload);
      let identity;
      try { identity = await ca.getSigningIdentity({ signerId, role, tenantId }); }
      catch { throw new Error("CA_IDENTITY_LOOKUP_FAILED"); }
      if (!identity?.key_ref || !identity.algorithm || !identity.certificate_fingerprint
          || (requiredAlgorithm && identity.algorithm !== requiredAlgorithm)) throw new Error("CA_SIGNING_IDENTITY_INVALID");
      if (hospital && !/^[a-f0-9]{64}$/i.test(identity.certificate_fingerprint)) throw new Error("CA_CERTIFICATE_FINGERPRINT_REQUIRED");
      const unsigned = {
        schema_version: SIGNATURE_RECORD_SCHEMA, workflow, payload_digest: payloadDigest,
        payload_algorithm: "sha256(canonical-json)",
        signer: { id: signerId, role, tenant_id: tenantId },
        // Retain no arbitrary free text in a signature or audit record.
        signer_note: null,
        signer_note_digest: typeof signerNote === "string" && signerNote.trim() ? sha256Hex(signerNote) : null,
        provider: resolvedProviderId, key_ref: identity.key_ref,
        certificate_fingerprint: identity.certificate_fingerprint, certificate: null,
        algorithm: identity.algorithm, signed_at: new Date().toISOString(), nonce: randomUUID(),
        assurance: hospital ? "hospital_provider_verification_required" : "engineering_only",
        boundary: { is_ehr_writeback: false, note: "签名绑定此资料核对记录；不代表临床任务完成或 EHR 写回。" },
      };
      let signed;
      try { signed = await ca.sign({ payloadDigest: computeDecisionDigest(unsigned), signerId, role, tenantId, keyRef: identity.key_ref }); }
      catch { throw new Error("CA_SIGN_FAILED"); }
      if (typeof signed?.signature !== "string" || !signed.signature) throw new Error("CA_SIGN_FAILED");
      for (const key of ["key_ref", "algorithm", "certificate_fingerprint"]) {
        if (signed[key] != null && signed[key] !== unsigned[key]) throw new Error("CA_IDENTITY_CHANGED_DURING_SIGNING");
      }
      const record = { ...unsigned, signature: signed.signature };
      if (hospital && !(await adapter.verifySignatureRecord({ record, payload })).valid) throw new Error("CA_HOSPITAL_VERIFICATION_FAILED");

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
      if (record.provider !== resolvedProviderId || (requiredAlgorithm && record.algorithm !== requiredAlgorithm)) return { valid: false, reason: "CA_PROVIDER_OR_ALGORITHM_MISMATCH" };
      const { signature, ...unsigned } = record;
      const hospital = profile === "hospital" || isProductionStoreProfile();
      if (hospital && (ca.assurance !== "hospital_ca" || record.assurance !== "hospital_provider_verification_required")) return { valid: false, reason: "CA_HOSPITAL_PROVIDER_REQUIRED" };
      let result;
      try { result = await ca.verify({
        payloadDigest: computeDecisionDigest(unsigned),
        signature: record.signature,
        signerId: record.signer?.id,
        role: record.signer?.role,
        keyRef: record.key_ref, tenantId: record.signer?.tenant_id,
        algorithm: record.algorithm, certificateFingerprint: record.certificate_fingerprint,
        signedAt: record.signed_at,
      }); } catch { return { valid: false, reason: "CA_VERIFY_FAILED" }; }
      if (hospital && (result?.certificate_chain_valid !== true || result.revocation_status !== "good"
          || result.signer_id !== record.signer?.id || result.tenant_id !== record.signer?.tenant_id
          || !Number.isFinite(Date.parse(result.checked_at)) || Math.abs(Date.now() - Date.parse(result.checked_at)) > 300000)) {
        return { valid: false, reason: "CA_TRUST_OR_REVOCATION_UNVERIFIED" };
      }
      return {
        valid: result?.valid === true,
        reason: result?.valid === true ? "CA_ENVELOPE_VERIFIED" : "CA_SIGNATURE_INVALID",
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
  return adapter;
}
