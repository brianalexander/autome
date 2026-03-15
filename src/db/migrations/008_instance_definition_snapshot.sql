-- Add definition_snapshot column to instances table.
-- Stores the full workflow definition JSON at the time the instance was created,
-- making instances self-contained and immutable even if the source workflow is
-- later modified or deleted.
-- Nullable for backward compatibility with existing rows.
--
-- Note: The FK constraint on definition_id from 001_initial.sql is no longer
-- enforced (foreign_keys = OFF) so instances survive workflow deletion.
ALTER TABLE instances ADD COLUMN definition_snapshot TEXT;
