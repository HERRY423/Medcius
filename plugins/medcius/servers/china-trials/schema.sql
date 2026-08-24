CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT,
  note TEXT,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clinical_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ctr TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  drug_generic TEXT,
  indication TEXT,
  phase TEXT,
  status TEXT,
  sponsor TEXT,
  pi TEXT,
  sites_json TEXT,
  design TEXT,
  sample_size INTEGER,
  primary_endpoint TEXT,
  data_class TEXT NOT NULL DEFAULT 'official' CHECK (data_class IN ('official','sample')),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_version TEXT,
  effective_date TEXT,
  disclaimer TEXT,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trials_ctr ON clinical_trials(ctr);
CREATE INDEX IF NOT EXISTS idx_trials_drug ON clinical_trials(drug_generic);
CREATE INDEX IF NOT EXISTS idx_trials_ind ON clinical_trials(indication);

PRAGMA user_version = 1;
