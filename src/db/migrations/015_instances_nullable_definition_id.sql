-- Allow instances to survive workflow deletion by making definition_id nullable.
-- SQLite does not support ALTER COLUMN, so we recreate the table.

CREATE TABLE IF NOT EXISTS instances_new (
  id TEXT PRIMARY KEY,
  definition_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  trigger_event TEXT NOT NULL,
  context TEXT NOT NULL,
  current_stage_ids TEXT,
  restate_workflow_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  definition_snapshot TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  definition_version INTEGER,
  FOREIGN KEY (definition_id) REFERENCES workflows(id)
);

-- Copy data, NULLing out orphaned definition_id references (workflows may have been deleted)
INSERT INTO instances_new
  SELECT id,
         CASE WHEN definition_id IN (SELECT id FROM workflows) THEN definition_id ELSE NULL END,
         status, trigger_event, context, current_stage_ids, restate_workflow_id,
         created_at, updated_at, completed_at, definition_snapshot, is_test, definition_version
  FROM instances;
DROP TABLE instances;
ALTER TABLE instances_new RENAME TO instances;

CREATE INDEX IF NOT EXISTS idx_instances_definition ON instances(definition_id);
CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);
CREATE INDEX IF NOT EXISTS idx_instances_created_at ON instances(created_at DESC);
