-- 006_unify_chat.sql
-- Unify author chat and runtime agent chat into the segments+tool_calls tables.
-- Author chat now uses instance_id='author', stage_id=<workflowId>, iteration=1.
-- Drop the now-unused author_messages and transcript_events tables.
-- Add rendered_prompts table for storing the rendered prompt sent to each stage.

-- Create rendered_prompts table
CREATE TABLE IF NOT EXISTS rendered_prompts (
  instance_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 1,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (instance_id, stage_id, iteration)
);

-- Migrate existing rendered_prompt events from transcript_events (if any)
INSERT OR IGNORE INTO rendered_prompts (instance_id, stage_id, iteration, prompt, created_at)
SELECT
  instance_id,
  stage_id,
  iteration,
  json_extract(data, '$.prompt'),
  created_at
FROM transcript_events
WHERE event_type = 'rendered_prompt'
  AND json_extract(data, '$.prompt') IS NOT NULL;

-- Drop old tables
DROP TABLE IF EXISTS author_messages;
DROP TABLE IF EXISTS transcript_events;
