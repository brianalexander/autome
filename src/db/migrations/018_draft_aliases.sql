CREATE TABLE IF NOT EXISTS draft_aliases (
  from_id TEXT PRIMARY KEY,
  to_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
