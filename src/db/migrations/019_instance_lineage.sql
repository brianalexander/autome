ALTER TABLE instances ADD COLUMN initiated_by TEXT NOT NULL DEFAULT 'user';
ALTER TABLE instances ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflows ADD COLUMN parent_workflow_id TEXT;
CREATE INDEX idx_instances_initiated_by ON instances(initiated_by);
CREATE INDEX idx_workflows_parent ON workflows(parent_workflow_id);
UPDATE instances SET initiated_by = 'author' WHERE is_test = 1;
