import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const PARENT =
  process.env.CLAUDE_MEDCIUS_DATA ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? homedir() ?? ".", ".claude", "data", "medcius");
export const DATA = join(PARENT, "china-trials");
export const DB_PATH = join(DATA, "data.sqlite");
export const SCHEMA_VERSION = 1;
mkdirSync(DATA, { recursive: true, mode: 0o700 });
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA foreign_keys = ON");
try { db.exec("PRAGMA journal_mode = WAL"); } catch { /* busy */ }
db.exec("PRAGMA synchronous = NORMAL");
export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
}
tx(() => {
  const cur = db.prepare("PRAGMA user_version").get().user_version;
  const seeded = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='clinical_trials'").get();
  if (cur !== SCHEMA_VERSION && !(cur === 0 && !seeded)) {
    throw new Error(`schema version ${cur} != ${SCHEMA_VERSION} — delete ${DB_PATH} and re-ingest`);
  }
  db.exec(schemaSql);
});
