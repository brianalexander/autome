-- Add version tracking to workflows and instances
ALTER TABLE workflows ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE instances ADD COLUMN definition_version INTEGER;
