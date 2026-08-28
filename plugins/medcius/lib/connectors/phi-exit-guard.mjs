// PHI Exit Guard (REG-ACTION-TRACKER R28): moves PHI protection forward from
// "before model context" to "at the connector exit" — 原文仅存于院内进程内存瞬
// 时态，任何离开连接器进程的信封都必须已经假名化。
//
// Wraps any bridge-compliant connector. On every readPatient:
//   1. every string inside envelope.records is pseudonymized with the
//      deployment salt (stable [PSN:<hmac8>] tokens, same domain → same token);
//   2. the sanitized records are re-scanned with the fast raw-PHI detector and
//      the guard FAILS CLOSED if anything still trips it.
//
// mode="assert" skips step 1 and only enforces step 2 — used by strict
// deployments whose upstream already de-identifies, and by tests proving the
// blocking path works.

import { canonicalJson, sha256Hex } from "../../servers/shared/crypto.mjs";
import { containsRawPhi, pseudonymizeText } from "../../servers/phiguard/src/lib.mjs";

function requireSalt(salt) {
  if (!salt || typeof salt !== "string" || salt.length < 8) {
    throw new Error("PHI_EXIT_GUARD_SALT_REQUIRED: salt must be a string of >= 8 chars (e.g. CLAUDE_MEDCIUS_PHI_SALT)");
  }
}

function pseudonymizeDeep(value, salt) {
  if (typeof value === "string") return pseudonymizeText(value, { salt }).text;
  if (Array.isArray(value)) return value.map((item) => pseudonymizeDeep(item, salt));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = pseudonymizeDeep(item, salt);
    return out;
  }
  return value;
}

function assertNoRawPhi(records, connectorId) {
  for (const record of records) {
    const hit = containsRawPhi(canonicalJson(record));
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
    readPatient: async (context) => {
      const envelope = await connector.readPatient(context);
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
