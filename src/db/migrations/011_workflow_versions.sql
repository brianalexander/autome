-- Create workflow_versions table to track version history.
-- Each time a workflow definition changes, the new version is stored here.
-- Instances reference a version number instead of carrying a snapshot blob.
CREATE TABLE IF NOT EXISTS workflow_versions (
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workflow_id, version)
);

-- Backfill: insert the current definition of every workflow as its current version.
INSERT INTO workflow_versions (workflow_id, version, definition, created_at)
  SELECT id, version, definition, COALESCE(updated_at, datetime('now'))
  FROM workflows
  WHERE NOT EXISTS (
    SELECT 1 FROM workflow_versions WHERE workflow_id = workflows.id AND version = workflows.version
  );

-- Note: The definition_snapshot column on instances is intentionally left in place
-- (SQLite cannot drop columns easily). We simply stop reading/writing it.
-- Pre-migration instances that have a snapshot but no workflow_versions entry
-- will fall back to fetching the current workflow definition.
