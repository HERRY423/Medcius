// Medcius refresh-token store.
//
// Refresh tokens live only for the lifetime of this process — there is no OS
// keyring and they are never written to disk (the access token's short-lived
// cache is handled by session-file.mjs). A host-provided credential store
// where the host runs OAuth and the server requests tokens per-call, and an OS
// keyring, are follow-ups.

import { createHash } from "node:crypto";

/**
 * @typedef {object} StoredTokens
 * @property {string} iss
 * @property {string} client_id
 * @property {string} scope
 * @property {string} refresh_token
 */

/**
 * @typedef {object} TokenStore
 * @property {string} kind
 * @property {(key: string) => Promise<StoredTokens | null>} get
 * @property {(key: string, t: StoredTokens) => Promise<void>} set
 * @property {(key: string) => Promise<void>} delete
 */

/** @param {string} iss @param {string} [fhirUser] @returns {string} */
export function tokenKey(iss, fhirUser) {
  return createHash("sha256")
    .update(`${iss}|${fhirUser ?? ""}|${process.getuid?.() ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

/** @implements {TokenStore} */
class InMemoryTokens {
  kind = "memory";
  // #private: this map holds refresh tokens, and get/set/delete are the only
  // way in — a plain `private` was compile-time only and did not survive the port
  /** @type {Map<string, StoredTokens>} */
  #entries = new Map();

  /** @param {string} key */
  async get(key) {
    return this.#entries.get(key) ?? null;
  }
  /** @param {string} key @param {StoredTokens} tokens */
  async set(key, tokens) {
    this.#entries.set(key, tokens);
  }
  /** @param {string} key */
  async delete(key) {
    this.#entries.delete(key);
  }
}

// v1: memory only — re-auth each session. The access token survives subprocess
// restarts via session-file.mjs in the meantime.
/** @returns {Promise<TokenStore>} */
export async function pickTokenStore() {
  return new InMemoryTokens();
}
