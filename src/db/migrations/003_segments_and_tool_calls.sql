-- Interleaved segments (text + tool references) per stage run
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 1,
  segment_index INTEGER NOT NULL,
  segment_type TEXT NOT NULL,  -- 'text' or 'tool'
  content TEXT,                -- for text segments
  tool_call_id TEXT,           -- for tool segments
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_segments_lookup
  ON segments(instance_id, stage_id, iteration, segment_index);

-- Structured tool call tracking with two-phase updates
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  kind TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  raw_input TEXT,
  raw_output TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_lookup
  ON tool_calls(instance_id, stage_id, iteration);
