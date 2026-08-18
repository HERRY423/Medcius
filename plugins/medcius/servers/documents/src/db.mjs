// Medcius documents storage: connection, schema lifecycle, transactions, and
// the write-validation allowlists. This module is all side effects at import
// time — by the time any handler runs, the database is open and current.
//
// The data directory follows the plugin-wide convention (plugins/medcius/CLAUDE.md):
// $CLAUDE_MEDCIUS_DATA overrides the parent; this component appends its own
// name. Data that predates the rename from "contracts" is moved over once.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Paths and identifier rules
// ---------------------------------------------------------------------------

const PARENT =
  process.env.CLAUDE_MEDCIUS_DATA ?? join(process.env.HOME ?? ".", ".claude", "data", "medcius");
const LEGACY = join(PARENT, "contracts");

export const DATA = join(PARENT, "documents");
if (existsSync(LEGACY) && !existsSync(DATA)) renameSync(LEGACY, DATA);

export const DB_PATH = join(DATA, "data.sqlite");
export const PARSED = join(DATA, "parsed");

// Identifiers become filesystem path components, so ".." is never allowed.
export const RUN_ID_RE = /^(?!.*\.\.)[A-Za-z0-9_.:-]{1,64}$/;
export const NAME_RE = /^(?!.*\.\.)[A-Za-z0-9_.-]{1,64}$/;
export const SCHEMA_VERSION = 4;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

mkdirSync(DATA, { recursive: true, mode: 0o700 });

// node:sqlite is pulled in lazily so that on old node the failure surfaces as a
// clear message from requirements.mjs instead of an ESM link error.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
export const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA foreign_keys = ON");

// node:sqlite yields extended result codes (261 = SQLITE_BUSY_RECOVERY, ...);
// the primary code is the low byte.
const isBusy = (e) => ((e.errcode ?? 0) & 0xff) === 5;

// First-open WAL conversion bypasses the busy handler, so racers see BUSY
// while the winner converts. WAL is persistent, so only one process ever needs
// this to succeed.
try {
  db.exec("PRAGMA journal_mode = WAL");
} catch (e) {
  if (!isBusy(e)) throw e;
}
db.exec("PRAGMA synchronous = NORMAL");

// ---------------------------------------------------------------------------
// Schema lifecycle
// ---------------------------------------------------------------------------

// Additive-only column additions; a dropped column or moved primary key is a
// breaking change and needs a version bump (delete-and-reingest) instead.
const ADDITIVE_COLUMNS = [
  ["audits", "doc_id", "INTEGER REFERENCES documents(id) ON DELETE CASCADE"],
  ["audits", "start_off", "INTEGER"],
  ["audits", "end_off", "INTEGER"],
];

// schema.sql is applied on every open because every statement in it is
// idempotent — that is the only way a new trigger, a repaired view, or
// runtime-damaged DDL reaches an existing database. user_version gates breaking
// changes that cannot be patched in place.
//
// The probe and apply share one immediate transaction: several server
// processes can open this file within the same millisecond, and unserialized
// DROP/CREATE pairs race.
try {
  tx(() => {
    const current = db.prepare("PRAGMA user_version").get().user_version;
    const seeded = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'")
      .get();
    if (current !== SCHEMA_VERSION && !(current === 0 && !seeded)) {
      const msg =
        `schema version ${current} != ${SCHEMA_VERSION} — the database at ${DB_PATH} is from an older version. ` +
        `Delete ${DB_PATH} (the parsed/ cache can stay) and re-ingest.`;
      process.stderr.write(`mcp-server-documents: ${msg}\n`);
      throw new Error(msg);
    }
    db.exec(schemaSql);
    for (const [table, col, decl] of ADDITIVE_COLUMNS) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
    // Rows written before parse_status existed carry extraction placeholders
    // under a NULL status. Backfill the status so v_coverage_gaps stops
    // counting them as readable. The prefixes mirror ingest.mjs CACHE_MARK
    // verbatim; importing that constant here would create an import cycle.
    db.exec(`UPDATE corpus_documents SET parse_status = 'failed'
      WHERE parse_status IS NULL AND doc_id IN (
        SELECT id FROM documents
        WHERE content LIKE '[extraction failed%'
           OR content LIKE '[no text extracted%'
           OR content LIKE '[image-only%')`);
  });
} catch (e) {
  if (isBusy(e))
    process.stderr.write(
      `mcp-server-documents: database is busy — another session is mid-write (likely a long ingest); retry once it finishes\n`,
    );
  throw e;
}

// With the schema transaction done, journal mode is settled. A non-WAL value
// here is real degradation worth surfacing.
{
  let journal_mode = "unreadable (locked)";
  try {
    journal_mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
  } catch (e) {
    if (!isBusy(e)) throw e;
  }
  if (journal_mode !== "wal")
    process.stderr.write(
      `mcp-server-documents: journal_mode is "${journal_mode}", not "wal" — concurrent sessions will contend until a restart with no other sessions running converts it\n`,
    );
}

// ---------------------------------------------------------------------------
// Transactions
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

// ---------------------------------------------------------------------------
// Write validation
// ---------------------------------------------------------------------------

/** Tables that allow in-place updates, and which columns may be set. */
export const setSchemas = {
  runs: { pk: "run_id", cols: ["status", "round", "session_id"] },
  briefs: { pk: "id", cols: ["status"] },
  queue_items: { pk: "id", cols: ["status", "answer", "answered_by", "answered_at"] },
  knowledge: { pk: "id", cols: ["status", "ratified_by"] },
};

/** Insert validation per table; the key set is also the insert allowlist.
 *  Plain JSON Schema, checked by shared/validate.mjs — the same grammar as the
 *  tool schemas, one validator for everything. `nullable` columns use type
 *  arrays (internal only; nothing here is emitted on the wire). */
const str = { type: "string" };
const int = { type: "integer" };
const nstr = { type: ["string", "null"] };
const nint = { type: ["integer", "null"] };
const row = (required, properties) => ({ type: "object", required, properties });

export const writeSchemas = {
  runs: row(["run_id", "question", "corpus"], {
    run_id: { type: "string", pattern: RUN_ID_RE.source },
    question: str,
    corpus: str,
    status: str,
    round: int,
    session_id: nstr,
  }),
  briefs: row(["run_id", "version", "rubric", "assumptions", "done_criteria", "scope_intent"], {
    run_id: str,
    version: int,
    rubric: str,
    assumptions: str,
    done_criteria: str,
    scope_intent: str,
    status: str,
  }),
  scopes: row(["run_id", "brief_id", "predicate", "terms", "rationale"], {
    run_id: str,
    brief_id: int,
    predicate: str,
    terms: str,
    cap: nint,
    excluded_count: int,
    rationale: str,
  }),
  shard_coverage: row(["scope_id", "doc_id", "worker", "status"], {
    scope_id: int,
    doc_id: int,
    worker: str,
    status: { type: "string", enum: ["read", "error"] },
    note: nstr,
  }),
  scope_documents: row(["scope_id", "doc_id", "rank"], { scope_id: int, doc_id: int, rank: int }),
  findings: row(["run_id", "brief_id", "round", "worker", "kind", "claim"], {
    run_id: str,
    brief_id: int,
    round: int,
    worker: str,
    kind: { type: "string", enum: ["finding", "unknown"] },
    claim: str,
  }),
  finding_citations: row(["finding_id", "citation_id"], { finding_id: int, citation_id: int }),
  queue_items: row(["run_id", "brief_id", "round", "question"], {
    run_id: str,
    brief_id: int,
    round: int,
    question: str,
    context: str,
    blocking: { type: "integer", minimum: 0, maximum: 1 },
    status: str,
    answer: nstr,
    answered_by: nstr,
    answered_at: nstr,
  }),
  queue_citations: row(["queue_item_id", "citation_id"], { queue_item_id: int, citation_id: int }),
  knowledge: row(["corpus", "fact"], {
    corpus: str,
    fact: str,
    status: str,
    ratified_by: nstr,
    source_run_id: nstr,
    source_queue_item_id: nint,
  }),
  knowledge_citations: row(["knowledge_id", "citation_id"], {
    knowledge_id: int,
    citation_id: int,
  }),
  audits: row(["kind", "result"], {
    doc_id: int,
    start_off: int,
    end_off: int,
    run_id: nstr,
    corpus: nstr,
    kind: {
      type: "string",
      enum: ["mechanical", "semantic_sample", "recall_sample", "citation_judge", "preprocess"],
    },
    sample_n: int,
    result: str,
  }),
};
