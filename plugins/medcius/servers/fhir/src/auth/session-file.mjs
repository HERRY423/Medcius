// Medcius session persistence.
//
// The connection (base URL + access token) is cached on disk so it survives a
// host restarting this stdio subprocess between turns. The cache lives in a
// per-uid temp directory and every path under it is ownership-asserted: an
// entry that exists but is not a regular file/dir owned by us is treated as
// tampering — an active-attack signal, never an ordinary I/O hiccup. Only the
// access token is written (≤1h TTL); the refresh token never leaves memory.

import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @typedef {import("../fhir-client.mjs").FhirSession} FhirSession */

/**
 * @typedef {object} Persisted
 * @property {string} baseUrl
 * @property {string | null} token
 * @property {number | null} expiresAt
 */

/** Thrown when a path under our tmpdir is not the regular, self-owned entry
 *  we created. Callers must not swallow it with ordinary I/O errors. */
export class OwnershipError extends Error {}

// uid checks are a no-op on Windows (getuid is undefined there).
const uid = process.getuid?.() ?? -1;

/** @param {string} path @param {boolean} wantDir @returns {void} */
export function assertOwned(path, wantDir) {
  const st = lstatSync(path);
  if (wantDir ? !st.isDirectory() : !st.isFile())
    throw new OwnershipError(`not a regular path: ${path}`);
  if (uid >= 0 && st.uid !== uid) throw new OwnershipError(`owned by another user: ${path}`);
}

// Per-uid so that on shared /tmp another user owning the fixed name is an
// attack signal, not the normal case.
/** @param {string} prefix @returns {string} */
export function perUidTmpDir(prefix) {
  return join(tmpdir(), `${prefix}-${uid >= 0 ? uid : "u"}`);
}

// Create-or-adopt an owned 0700 dir. mkdir's mode only applies at creation,
// so a pre-existing dir is re-asserted and re-tightened.
/** @param {string} path @returns {void} */
export function ensureOwnedDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertOwned(path, true);
  chmodSync(path, 0o700);
}

const dir = perUidTmpDir("mcp-server-fhir");
const file = join(dir, "session.json");

/** @param {FhirSession} s @param {number} [expiresIn] @returns {void} */
export function persistSession(s, expiresIn) {
  try {
    ensureOwnedDir(dir);
    /** @type {Persisted} */
    const record = {
      baseUrl: s.baseUrl.href,
      token: s.token,
      expiresAt: expiresIn ? Date.now() + (expiresIn - 60) * 1000 : null,
    };
    writeFileSync(file, JSON.stringify(record), { mode: 0o600, flag: "w" });
    assertOwned(file, false);
    chmodSync(file, 0o600);
  } catch (e) {
    // ownership failures are an attack signal and must surface; ordinary
    // persistence errors (read-only tmp, ENOSPC) stay best-effort
    if (e instanceof OwnershipError) throw e;
  }
}

/** @returns {FhirSession | null} */
export function restoreSession() {
  try {
    assertOwned(file, false);
    /** @type {Persisted} */
    const record = /** @type {Persisted} */ (JSON.parse(readFileSync(file, "utf-8")));
    if (record.expiresAt && record.expiresAt < Date.now()) return null;
    const baseUrl = new URL(record.baseUrl);
    let token = record.token;
    // A session persisted before the env token was origin-bound (see
    // resolveEnvBearerToken in tools.mjs) may carry the FHIR_BEARER_TOKEN
    // credential against a non-configured origin. Re-apply the binding on
    // restore: if the persisted token IS the env credential and the persisted
    // origin is not FHIR_BASE_URL's origin, drop the token. The session itself
    // survives, unauthenticated; the file is left as-is and is overwritten by
    // the next successful connect.
    const envToken = process.env.FHIR_BEARER_TOKEN;
    if (token && envToken && token === envToken) {
      /** @type {string | null} */
      let configuredOrigin = null;
      try {
        configuredOrigin = process.env.FHIR_BASE_URL
          ? new URL(process.env.FHIR_BASE_URL).origin
          : null;
      } catch {
        configuredOrigin = null;
      }
      if (configuredOrigin !== baseUrl.origin) {
        token = null;
        process.stderr.write(
          `mcp-server-fhir: restored session for ${baseUrl.origin} carried the FHIR_BEARER_TOKEN env credential, which is bound to ${configuredOrigin ?? "no configured server (FHIR_BASE_URL unset)"} — token dropped from the restored session\n`,
        );
      }
    }
    return { baseUrl, token };
  } catch (e) {
    // can't rethrow here (module load would crash), but the signal must not
    // vanish — the write path throws, so the read path at least reports
    if (e instanceof OwnershipError)
      process.stderr.write(`mcp-server-fhir: ignoring session file: ${e.message}\n`);
    return null;
  }
}

/** @returns {void} */
export function clearSession() {
  try {
    rmSync(file);
  } catch {}
}
