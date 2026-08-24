// audit storage: connection + schema lifecycle + chain helpers.
// Honors CLAUDE_MEDCIUS_DATA (set BEFORE import in probes/tests) so eval runs
// never pollute a real audit store.

import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

const PARENT =
  process.env.CLAUDE_MEDCIUS_DATA ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? homedir() ?? ".", ".claude", "data", "medcius");

export const DATA = join(PARENT, "audit");
export const DB_PATH = join(DATA, "audit.sqlite");
export const SCHEMA_VERSION = 1;
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
    if (cur !== SCHEMA_VERSION && !(cur === 0 && !seeded)) {
      const msg = `schema version ${cur} != ${SCHEMA_VERSION} — audit stores are append-only; do NOT delete. Escalate instead.`;
      process.stderr.write(`mcp-server-audit: ${msg}\n`);
      throw new Error(msg);
    }
    db.exec(schemaSql);
  });
} catch (e) {
  if (!isBusy(e)) throw e;
}

/** All statements in fn commit together or not at all. */
export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

/** Chain hash for one event: sha256(prev | seq | payload_hash | ts). */
export function chainHash(prevHash, seq, payloadHash, ts) {
  return createHashSha(prevHash, seq, payloadHash, ts);
}
import { createHash } from "node:crypto";
function createHashSha(prev, seq, ph, ts) {
  return createHash("sha256").update(`${prev}|${seq}|${ph}|${ts}`).digest("hex");
}
