-- Add index for instances ordered by created_at (used by listInstances)
CREATE INDEX IF NOT EXISTS idx_instances_created_at ON instances(created_at DESC);
