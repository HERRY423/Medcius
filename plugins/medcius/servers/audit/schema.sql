-- audit: tamper-evident hash-chained decision log. Append-only by trigger.
-- Runs inside tx (db.mjs). user_version set at bottom.

CREATE TABLE IF NOT EXISTS audit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  seq          INTEGER NOT NULL UNIQUE,          -- monotonic, gap-free by construction
  ts           TEXT    NOT NULL DEFAULT (datetime('now')),
  actor        TEXT    NOT NULL,                 -- component/user that produced the decision
  action       TEXT    NOT NULL,                 -- e.g. rx_review_verdict / label_retrieval / export
  subject_ref  TEXT    NOT NULL,                 -- PSEUDONYMIZED reference only (PHI guard enforces)
  payload_json TEXT    NOT NULL,                 -- canonical JSON; must be pre-redacted
  payload_hash TEXT    NOT NULL,                 -- sha256(canonicalJson(payload))
  prev_hash    TEXT    NOT NULL,                 -- chain link ('GENESIS' for seq=1)
  chain_hash   TEXT    NOT NULL,                 -- sha256(prev|seq|payload_hash|ts)
  phi_guard    TEXT    NOT NULL DEFAULT 'enforced' CHECK (phi_guard IN ('enforced','acknowledged'))
);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_events_actor  ON audit_events(actor);
CREATE INDEX IF NOT EXISTS idx_events_subj   ON audit_events(subject_ref);
CREATE INDEX IF NOT EXISTS idx_events_action ON audit_events(action);

-- Append-only: no UPDATE, no DELETE. The chain is the point.
DROP TRIGGER IF EXISTS audit_events_no_update;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events are immutable (append-only hash chain)'); END;
DROP TRIGGER IF EXISTS audit_events_no_delete;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events are immutable (append-only hash chain)'); END;

-- Pharmacist/clinician sign-off on events requiring human disposition.
CREATE TABLE IF NOT EXISTS audit_signoffs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES audit_events(id),
  signer     TEXT    NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('pharmacist','physician','admin')),
  decision   TEXT    NOT NULL CHECK (decision IN ('agree','override','reject')),
  reason     TEXT    NOT NULL,
  signed_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signoffs_event ON audit_signoffs(event_id);

DROP TRIGGER IF EXISTS signoffs_immutable;
CREATE TRIGGER signoffs_immutable BEFORE UPDATE ON audit_signoffs
BEGIN SELECT RAISE(ABORT, 'audit_signoffs are immutable'); END;
DROP TRIGGER IF EXISTS signoffs_no_delete;
CREATE TRIGGER signoffs_no_delete BEFORE DELETE ON audit_signoffs
BEGIN SELECT RAISE(ABORT, 'audit_signoffs are immutable'); END;
-- A signoff must reference an event that exists and is a review verdict.
DROP TRIGGER IF EXISTS signoffs_need_event;
CREATE TRIGGER signoffs_need_event BEFORE INSERT ON audit_signoffs
BEGIN
  SELECT CASE
    WHEN (SELECT action FROM audit_events WHERE id = NEW.event_id) IS NULL
      THEN RAISE(ABORT, 'signoff: unknown event_id')
  END;
END;

PRAGMA user_version = 1;
