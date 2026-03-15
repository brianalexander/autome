-- Author chat message persistence
CREATE TABLE IF NOT EXISTS author_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- 'user' or 'assistant'
  content TEXT NOT NULL,        -- text content or JSON segments
  message_type TEXT NOT NULL DEFAULT 'text',  -- 'text', 'segments'
  metadata TEXT,                -- JSON: tool calls, context usage, etc.
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

CREATE INDEX IF NOT EXISTS idx_author_messages_workflow
  ON author_messages(workflow_id, id);
