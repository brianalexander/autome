ALTER TABLE instances ADD COLUMN display_summary TEXT;
CREATE INDEX IF NOT EXISTS idx_instances_display_summary ON instances (display_summary) WHERE display_summary IS NOT NULL;
