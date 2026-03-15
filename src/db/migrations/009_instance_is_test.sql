-- Mark test-run instances directly so filtering works even after test workflows are deleted
ALTER TABLE instances ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

-- Backfill: mark existing instances whose definition_id points to a test workflow
UPDATE instances SET is_test = 1
  WHERE definition_id IN (SELECT id FROM workflows WHERE is_test = 1);
