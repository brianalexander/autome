CREATE TABLE IF NOT EXISTS transcript_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 1,
  event_type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (instance_id) REFERENCES instances(id)
);

CREATE INDEX IF NOT EXISTS idx_transcript_instance_stage
  ON transcript_events(instance_id, stage_id, iteration);
