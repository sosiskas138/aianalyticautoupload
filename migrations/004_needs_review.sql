ALTER TABLE calls ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_calls_needs_review ON calls (project_id, needs_review) WHERE needs_review = TRUE;
