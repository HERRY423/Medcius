// PHI Exit Guard (REG-ACTION-TRACKER R28): moves PHI protection forward from
// "before model context" to "at the connector exit" — 原文仅存于院内进程内存瞬
// 时态，任何离开连接器进程的信封都必须已经假名化。
//
// Wraps any bridge-compliant connector. On every readPatient:
//   1. every string inside envelope.records is pseudonymized with the
//      deployment salt (stable [PSN:<hmac32>] tokens, same domain → same token);
//   2. the sanitized records are re-scanned with the fast raw-PHI detector and
//      the guard FAILS CLOSED if anything still trips it.
//
// mode="assert" skips step 1 and only enforces step 2 — used by strict
// deployments whose upstream already de-identifies, and by tests proving the
// blocking path works.

import { canonicalJson, sha256Hex } from "../../servers/shared/crypto.mjs";
import { pseudonymizeText } from "../../servers/phiguard/src/lib.mjs";
import { sealIdentityRecord, containsRawStructuredPhi } from "../clinical-boundary.mjs";
import { guardPatientSourceInput } from '../patient-source-phi.mjs';
import { requiresProductionPhi } from '../production-phi-policy.mjs';
import { resolvePhiDetector } from '../phi-runtime.mjs';

function requireSalt(salt) {
  if (!salt || typeof salt !== "string" || salt.length < 8) {
    throw new Error("PHI_EXIT_GUARD_SALT_REQUIRED: salt must be a string of >= 8 chars (e.g. CLAUDE_MEDCIUS_PHI_SALT)");
  }
}

function pseudonymizeDeep(value, salt) {
  if (typeof value === "string") return pseudonymizeText(value, { salt }).text;
  if (Array.isArray(value)) return value.map((item) => pseudonymizeDeep(item, salt));
  if (value && typeof value === "object") {
    const sealed = sealIdentityRecord(value, { salt });
    const out = {};
    for (const [key, item] of Object.entries(sealed)) out[key] = pseudonymizeDeep(item, salt);
    return out;
  }
  return value;
}

function assertNoRawPhi(records, connectorId) {
  for (const record of records) {
    const hit = containsRawStructuredPhi(record);
    if (hit.hit) {
      throw new Error(
        `PHI_EXIT_GUARD_RAW_PHI_BLOCKED: ${connectorId} emitted raw ${hit.type}; refusing to release envelope`
      );
    }
  }
}

export function withPhiExitGuard(connector, { salt, mode = "pseudonymize" } = {}) {
  if (!connector || typeof connector.readPatient !== "function") throw new Error("PHI_EXIT_GUARD_CONNECTOR_REQUIRED");
  if (mode !== "pseudonymize" && mode !== "assert") throw new Error("PHI_EXIT_GUARD_MODE_INVALID");
  requireSalt(salt);

  return {
    ...connector,
    readPatient: async (context, { entitySession, localPhiDetector, signal } = {}) => {
      context = structuredClone(context);
      const dual = requiresProductionPhi(context) || !!localPhiDetector;
      if (dual) localPhiDetector = await resolvePhiDetector({ detector: localPhiDetector, context });
      const envelope = await connector.readPatient(context);
      if (dual) {
        if (envelope.patient_id !== context.patient_id || envelope.encounter_id !== context.encounter_id || envelope.tenant_id !== context.tenant_id) throw new Error('PHI_EXIT_GUARD_CONTEXT_MISMATCH');
        const source = { context, patient: connector.kind === 'patient' ? envelope.records[0] : { id: context.patient_id },
          encounter: connector.kind === 'encounter' ? envelope.records[0] : { id: context.encounter_id },
          ...(connector.kind === 'notes' ? { notes: envelope.records } : {}), envelope };
        const result = await guardPatientSourceInput(source, { detector: localPhiDetector, entitySession, signal });
        try {
          if (mode === 'assert' && canonicalJson(result.input.envelope) !== canonicalJson(envelope)) throw new Error('PHI_EXIT_GUARD_RAW_PHI_BLOCKED');
          assertNoRawPhi(result.input.envelope.records, connector.id);
          return { ...result.input.envelope, phi_exit_guard: { applied: true, mode: 'dual_track', ...result.receipt } };
        } finally { if (!entitySession) result.session.dispose(); }
      }
      const records =
        mode === "pseudonymize" ? pseudonymizeDeep(envelope.records, salt) : envelope.records;
      assertNoRawPhi(records, connector.id);
      return {
        ...envelope,
        records,
        phi_exit_guard: {
          applied: true,
          mode,
          salt_fingerprint: sha256Hex(salt).slice(0, 8),
        },
      };
    },
  };
}
