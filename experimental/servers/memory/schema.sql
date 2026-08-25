-- Schema for Agent Memory and Adaptive Learning Store
CREATE TABLE IF NOT EXISTS agent_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL, -- 'hospital', 'department', 'doctor', 'workflow', 'general'
  scope_id TEXT,       -- e.g. doctorId or department name
  key TEXT NOT NULL,
  content TEXT NOT NULL, -- JSON string or natural language memory
  tags TEXT,           -- comma-separated tags
  source_ref TEXT,     -- reference audit event or document
  confidence REAL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_scope ON agent_memories(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_memories_key ON agent_memories(key);

CREATE TABLE IF NOT EXISTS agent_learning_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL, -- 'override', 'reject', 'agree', 'rule_suggestion'
  audit_seq INTEGER,
  doctor_id TEXT,
  department TEXT,
  original_verdict TEXT,
  pharmacist_verdict TEXT,
  rationale TEXT NOT NULL,
  rule_affected TEXT,
  suggested_action TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learning_audit ON agent_learning_logs(audit_seq);
CREATE INDEX IF NOT EXISTS idx_learning_doctor ON agent_learning_logs(doctor_id);
