-- Маппинг organizationId из вебхука -> project_id
CREATE TABLE IF NOT EXISTS webhook_project_mapping (
  organization_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_project_mapping_project ON webhook_project_mapping(project_id);
