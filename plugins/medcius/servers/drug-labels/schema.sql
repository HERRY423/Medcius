-- drug-labels: local NMPA/offline label store.
-- Runs inside a transaction (db.mjs); all DDL here must be idempotent.
-- user_version is set at the bottom after the transaction.

CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  url         TEXT,
  note        TEXT,
  ingested_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drug_labels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  generic_name    TEXT    NOT NULL,
  brand_name      TEXT,
  approval_number TEXT    NOT NULL UNIQUE,
  manufacturer    TEXT,
  dosage_form     TEXT,
  spec            TEXT,
  classification  TEXT    NOT NULL DEFAULT 'unknown' CHECK (classification IN ('rx','otc','unknown')),
  sections_json   TEXT    NOT NULL,         -- JSON object: { "适应症": "...", "药物相互作用": "..." }
  data_class      TEXT    NOT NULL DEFAULT 'official' CHECK (data_class IN ('official','sample')),
  source_id       INTEGER NOT NULL REFERENCES sources(id),
  source_version  TEXT,                     -- e.g. 修订日期/版本
  effective_date  TEXT,                     -- ISO date when supplied
  disclaimer      TEXT,
  ingested_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_labels_generic    ON drug_labels(generic_name);
CREATE INDEX IF NOT EXISTS idx_labels_brand      ON drug_labels(brand_name);
CREATE INDEX IF NOT EXISTS idx_labels_approval   ON drug_labels(approval_number);

CREATE TABLE IF NOT EXISTS label_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id       INTEGER NOT NULL REFERENCES drug_labels(id) ON DELETE CASCADE,
  snapshot_hash  TEXT    NOT NULL,         -- sha256 of canonical payload
  source_version TEXT,
  captured_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_label ON label_snapshots(label_id);

-- Deterministic substring hits recomputed on ingest.
CREATE TABLE IF NOT EXISTS interaction_mentions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id      INTEGER NOT NULL REFERENCES drug_labels(id) ON DELETE CASCADE,
  other_label_id INTEGER NOT NULL REFERENCES drug_labels(id) ON DELETE CASCADE,
  excerpt       TEXT    NOT NULL,
  section_name  TEXT    NOT NULL DEFAULT '药物相互作用',
  UNIQUE(label_id, other_label_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_label ON interaction_mentions(label_id);
CREATE INDEX IF NOT EXISTS idx_mentions_other ON interaction_mentions(other_label_id);

-- CYP / class signals extracted at ingest (not a substitute for a PASS-grade DDI DB).
CREATE TABLE IF NOT EXISTS label_signals (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id  INTEGER NOT NULL REFERENCES drug_labels(id) ON DELETE CASCADE,
  signal    TEXT    NOT NULL,
  excerpt   TEXT,
  UNIQUE(label_id, signal)
);
CREATE INDEX IF NOT EXISTS idx_signals_label ON label_signals(label_id);
CREATE INDEX IF NOT EXISTS idx_signals_name ON label_signals(signal);

-- Bump on any breaking change; db.mjs checks this against SCHEMA_VERSION.
PRAGMA user_version = 2;
