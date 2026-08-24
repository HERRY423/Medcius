import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

const PARENT =
  process.env.CLAUDE_MEDCIUS_DATA ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? homedir() ?? ".", ".claude", "data", "medcius");

export const DATA = join(PARENT, "china-codes");
export const DB_PATH = join(DATA, "data.sqlite");
export const SCHEMA_VERSION = 2;

import { mkdirSync } from "node:fs";
mkdirSync(DATA, { recursive: true, mode: 0o700 });

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA foreign_keys = ON");
const isBusy = (e) => ((e.errcode ?? 0) & 0xff) === 5;
try { db.exec("PRAGMA journal_mode = WAL"); } catch (e) { if (!isBusy(e)) throw e; }
db.exec("PRAGMA synchronous = NORMAL");

try {
  tx(() => {
    const cur = db.prepare("PRAGMA user_version").get().user_version;
    const seeded = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nhsa_codes'").get();
    if (cur === 1 && SCHEMA_VERSION === 2) {
      db.exec(schemaSql);
      db.exec("PRAGMA user_version = 2");
    } else if (cur !== SCHEMA_VERSION && !(cur === 0 && !seeded)) {
      const msg = `schema version ${cur} != ${SCHEMA_VERSION} — delete ${DB_PATH} and re-ingest.`;
      process.stderr.write(`mcp-server-china-codes: ${msg}\n`);
      throw new Error(msg);
    } else {
      db.exec(schemaSql);
    }
  });
} catch (e) {
  if (isBusy(e)) process.stderr.write(`mcp-server-china-codes: database busy — retry\n`);
  throw e;
}
{
  let jm = "unreadable (locked)";
  try { jm = db.prepare("PRAGMA journal_mode").get().journal_mode; } catch (e) { if (!isBusy(e)) throw e; }
  if (jm !== "wal") process.stderr.write(`mcp-server-china-codes: journal_mode=${jm} not wal\n`);
}

export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

export function snapshotHash(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}
