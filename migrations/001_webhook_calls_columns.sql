-- Колонки для вебхука: record_url, payload (agreements, chat, metrics)
ALTER TABLE calls ADD COLUMN IF NOT EXISTS record_url TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS payload JSONB;
CREATE INDEX IF NOT EXISTS idx_calls_payload ON calls USING GIN (payload) WHERE payload IS NOT NULL;
