-- china-codes: local NHSA codes + drug catalog
-- Idempotent DDL, runs inside tx in db.mjs. Bump user_version on breaking change.

CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  url         TEXT,
  note        TEXT,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unified codes: diagnosis (ICD-10) + procedure (ICD-9-CM-3-CN). CCHI codes are NOT stored here by design.
CREATE TABLE IF NOT EXISTS nhsa_codes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL,
  code_system     TEXT NOT NULL, -- 医保版ICD-10 | 医保版手术操作分类 | 医保药品目录
  name            TEXT NOT NULL, -- 中文标准名称
  category        TEXT,           -- e.g. 诊断亚目/手术亚目; procedure site/type hints
  code_type       TEXT NOT NULL CHECK (code_type IN ('diagnosis','procedure')),
  full_length     INTEGER NOT NULL DEFAULT 1, -- 1 = full settlement length, 0 = bare category (not billable)
  is_main_diag_allowed INTEGER NOT NULL DEFAULT 1, -- 0 = not allowed as main diagnosis (e.g. some Z-codes)
  data_class      TEXT NOT NULL DEFAULT 'official' CHECK (data_class IN ('official','sample')),
  source_id       INTEGER NOT NULL REFERENCES sources(id),
  code_version    TEXT,
  effective_date  TEXT,
  disclaimer      TEXT,
  ingested_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(code, code_system)
);
CREATE INDEX IF NOT EXISTS idx_codes_system ON nhsa_codes(code_system);
CREATE INDEX IF NOT EXISTS idx_codes_type   ON nhsa_codes(code_type);
CREATE INDEX IF NOT EXISTS idx_codes_name   ON nhsa_codes(name);
CREATE INDEX IF NOT EXISTS idx_codes_code   ON nhsa_codes(code);

CREATE TABLE IF NOT EXISTS code_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id       INTEGER NOT NULL REFERENCES nhsa_codes(id) ON DELETE CASCADE,
  snapshot_hash TEXT NOT NULL,
  code_version  TEXT,
  captured_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_code ON code_snapshots(code_id);

-- Drug catalog (NHSA national formulary): class + payment restriction
CREATE TABLE IF NOT EXISTS nhsa_drug_catalog (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  generic_name      TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN ('甲类','乙类','谈判','未知')),
  payment_restriction TEXT, -- 限定支付范围原文
  spec              TEXT,
  dosage_form       TEXT,
  data_class        TEXT NOT NULL DEFAULT 'official' CHECK (data_class IN ('official','sample')),
  source_id         INTEGER NOT NULL REFERENCES sources(id),
  source_version    TEXT,
  effective_date    TEXT,
  disclaimer        TEXT,
  ingested_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(generic_name)
);
CREATE INDEX IF NOT EXISTS idx_catalog_generic ON nhsa_drug_catalog(generic_name);

CREATE TABLE IF NOT EXISTS provincial_benefits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  province TEXT NOT NULL,
  insurance_type TEXT NOT NULL,
  encounter TEXT NOT NULL,
  deductible REAL,
  reimburse_pct REAL,
  chronic_outpatient TEXT,
  data_class TEXT NOT NULL DEFAULT 'official' CHECK (data_class IN ('official','sample')),
  source_id INTEGER REFERENCES sources(id),
  source_version TEXT,
  effective_date TEXT,
  disclaimer TEXT
);
CREATE INDEX IF NOT EXISTS idx_ben_prov ON provincial_benefits(province);

CREATE TABLE IF NOT EXISTS gender_code_rules (
  code TEXT PRIMARY KEY,
  sex_required TEXT NOT NULL CHECK (sex_required IN ('male','female')),
  note TEXT
);

CREATE TABLE IF NOT EXISTS procedure_dx_hints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  procedure_substr TEXT NOT NULL,
  dx_substr TEXT NOT NULL
);

PRAGMA user_version = 2;
