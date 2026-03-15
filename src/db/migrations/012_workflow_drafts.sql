CREATE TABLE IF NOT EXISTS workflow_drafts (
  workflow_id TEXT PRIMARY KEY,
  draft JSON NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
