// audit storage: connection + schema lifecycle + chain helpers.
// Honors CLAUDE_MEDCIUS_DATA (set BEFORE import in probes/tests) so eval runs
// never pollute a real audit store.

import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../../shared/crypto.mjs";

const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

const PARENT =
  process.env.CLAUDE_MEDCIUS_DATA ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? homedir() ?? ".", ".claude", "data", "medcius");

export const DATA = join(PARENT, "audit");
export const DB_PATH = join(DATA, "audit.sqlite");
export const SCHEMA_VERSION = 2;
export const GENESIS = "GENESIS";

mkdirSync(DATA, { recursive: true, mode: 0o700 });

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA foreign_keys = ON");
const isBusy = (e) => ((e.errcode ?? 0) & 0xff) === 5;
try { db.exec("PRAGMA journal_mode = WAL"); } catch (e) { if (!isBusy(e)) throw e; }
db.exec("PRAGMA synchronous = FULL"); // audit trail: durability over speed

try {
  tx(() => {
    const cur = db.prepare("PRAGMA user_version").get().user_version;
    const seeded = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_events'").get();
    if (![1, SCHEMA_VERSION].includes(cur) && !(cur === 0 && !seeded)) {
      const msg = `schema version ${cur} != ${SCHEMA_VERSION} — audit stores are append-only; do NOT delete. Escalate instead.`;
      process.stderr.write(`mcp-server-audit: ${msg}\n`);
      throw new Error(msg);
    }
    // Add columns only. Historical hashes/signatures are never rewritten or upgraded.
    if (seeded) {
      const additions = {
        audit_events: { tenant_id: "TEXT NOT NULL DEFAULT 'default'", event_digest: "TEXT", chain_version: "INTEGER NOT NULL DEFAULT 1" },
        audit_signoffs: {
          tenant_id: "TEXT NOT NULL DEFAULT 'default'", signature: "TEXT", signature_algorithm: "TEXT DEFAULT 'ECDSA_P256_SHA256'",
          key_id: "TEXT", signed_hash: "TEXT", reason_digest: "TEXT", event_digest: "TEXT", replay_id: "TEXT", envelope_hash: "TEXT",
          envelope_json: "TEXT", signer_public_key: "TEXT", chain_version: "INTEGER NOT NULL DEFAULT 1", signoff_seq: "INTEGER", prev_hash: "TEXT", content_hash: "TEXT", chain_hash: "TEXT",
        },
      };
      for (const [table, columns] of Object.entries(additions)) {
        const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
        for (const [name, definition] of Object.entries(columns)) if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
    db.exec(schemaSql);
  });
} catch (e) {
  // A timed-out schema transaction must not expose a partially initialized store.
  throw e;
}

/** All statements in fn commit together or not at all. */
export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

/** v1 used payload_hash; v2 passes the full canonical event/signoff digest. */
export function chainHash(prevHash, seq, payloadHash, ts) {
  return createHashSha(prevHash, seq, payloadHash, ts);
}

export function eventDigest(row) {
  return sha256Hex(canonicalJson({ schema: "medcius.audit-event.v2", id: row.id, seq: row.seq, tenant_id: row.tenant_id, ts: row.ts,
    actor: row.actor, action: row.action, subject_ref: row.subject_ref, payload_hash: row.payload_hash, phi_guard: row.phi_guard }));
}

export function signoffDigest(row) {
  const fields = ["id", "signoff_seq", "event_id", "tenant_id", "signer", "role", "decision", "reason", "signature", "signature_algorithm", "key_id", "signed_hash", "reason_digest", "event_digest", "replay_id", "envelope_hash", "envelope_json", "signer_public_key", "signed_at"];
  return sha256Hex(canonicalJson({ schema: "medcius.audit-signoff.v2", ...Object.fromEntries(fields.map((key) => [key, row[key] ?? null])) }));
}
import { createHash } from "node:crypto";
function createHashSha(prev, seq, ph, ts) {
  return createHash("sha256").update(`${prev}|${seq}|${ph}|${ts}`).digest("hex");
}
