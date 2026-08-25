// Memory storage: connection + schema lifecycle
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

const PARENT =
  process.env.CLAUDE_MEDCIUS_DATA ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? homedir() ?? ".", ".claude", "data", "medcius");

export const DATA = join(PARENT, "memory");
export const DB_PATH = join(DATA, "memory.sqlite");

mkdirSync(DATA, { recursive: true, mode: 0o700 });

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA foreign_keys = ON");
const isBusy = (e) => ((e.errcode ?? 0) & 0xff) === 5;
try { db.exec("PRAGMA journal_mode = WAL"); } catch (e) { if (!isBusy(e)) throw e; }
db.exec("PRAGMA synchronous = NORMAL");

try {
  db.exec(schemaSql);
} catch (e) {
  if (!isBusy(e)) throw e;
}

export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}
