-- Mark test-run workflows so they can be filtered from listings
ALTER TABLE workflows ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_workflows_is_test ON workflows(is_test);
