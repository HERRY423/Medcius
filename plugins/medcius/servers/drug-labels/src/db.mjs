// drug-labels storage: connection + schema lifecycle + helpers.
// Follows documents/src/db.mjs posture exactly (parent dir convention, WAL, user_version gating).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const PARENT =
  process.env.CLAUDE_MEDCIUS_DATA ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? homedir() ?? ".", ".claude", "data", "medcius");

export const DATA = join(PARENT, "drug-labels");
export const DB_PATH = join(DATA, "data.sqlite");
export const SCHEMA_VERSION = 2;

mkdirSync(DATA, { recursive: true, mode: 0o700 });

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
export const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA foreign_keys = ON");

const isBusy = (e) => ((e.errcode ?? 0) & 0xff) === 5;

try {
  db.exec("PRAGMA journal_mode = WAL");
} catch (e) {
  if (!isBusy(e)) throw e;
}
db.exec("PRAGMA synchronous = NORMAL");

// ---------------------------------------------------------------------------
// Schema lifecycle
// ---------------------------------------------------------------------------
try {
  tx(() => {
    const current = db.prepare("PRAGMA user_version").get().user_version;
    const seeded = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='drug_labels'")
      .get();
    if (current === 1 && SCHEMA_VERSION === 2) {
      db.exec(schemaSql);
      db.exec("PRAGMA user_version = 2");
    } else if (current !== SCHEMA_VERSION && !(current === 0 && !seeded)) {
      const msg =
        `schema version ${current} != ${SCHEMA_VERSION} — the database at ${DB_PATH} is from an older version. ` +
        `Delete ${DB_PATH} and re-ingest.`;
      process.stderr.write(`mcp-server-drug-labels: ${msg}\n`);
      throw new Error(msg);
    } else {
      db.exec(schemaSql);
    }
  });
} catch (e) {
  if (isBusy(e))
    process.stderr.write(
      `mcp-server-drug-labels: database is busy — another session is mid-write; retry once it finishes\n`,
    );
  throw e;
}

{
  let journal_mode = "unreadable (locked)";
  try {
    journal_mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
  } catch (e) {
    if (!isBusy(e)) throw e;
  }
  if (journal_mode !== "wal")
    process.stderr.write(
      `mcp-server-drug-labels: journal_mode is "${journal_mode}", not "wal" — concurrent sessions will contend until a restart with no other sessions running converts it\n`,
    );
}

// ---------------------------------------------------------------------------
// Transactions & helpers
// ---------------------------------------------------------------------------

/** All statements in fn commit together or not at all. */
export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw e;
  }
}

/**
 * Canonical snapshot hash for change detection: sha256 over a stable JSON of
 * the parts that matter for "has the label changed?".
 * @param {Record<string, unknown>} sections
 * @param {string} generic
 * @param {string} approval
 * @param {string | null | undefined} sourceVersion
 * @param {string | null | undefined} effectiveDate
 * @returns {string}
 */
export function snapshotHash(sections, generic, approval, sourceVersion, effectiveDate) {
  const payload = JSON.stringify({
    generic_name: generic,
    approval_number: approval,
    source_version: sourceVersion ?? null,
    effective_date: effectiveDate ?? null,
    sections,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Normalize a drug name for substring detection.
 * @param {string} s
 * @returns {string}
 */
export function normName(s) {
  return s.replace(/\s+/g, "").trim();
}

// Query helpers shared by tools.mjs + ingest.mjs

export const RE_IMPURITY = /[\u0000-\u001f]/g;

/** @param {string} s - section text */
export function sectionContains(sectionText, needle) {
  if (!sectionText || !needle) return false;
  const hay = sectionText.replace(RE_IMPURITY, "");
  const q = normName(needle);
  if (q.length < 2) return false;
  return hay.includes(q) || hay.includes(needle);
}

/** Extract the interaction section text from a label's sections_json. */
export function interactionSection(sections) {
  if (!sections || typeof sections !== "object") return "";
  for (const [k, v] of Object.entries(sections)) {
    if (k.includes("相互作用") && typeof v === "string" && v.trim()) return v;
  }
  return "";
}
