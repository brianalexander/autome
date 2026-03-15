-- ACP session tracking for resume via loadSession
CREATE TABLE IF NOT EXISTS acp_sessions (
  key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  process_pid INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
