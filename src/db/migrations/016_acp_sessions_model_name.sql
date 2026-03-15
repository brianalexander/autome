-- Add model_name column to acp_sessions for persisting detected model
ALTER TABLE acp_sessions ADD COLUMN model_name TEXT;
