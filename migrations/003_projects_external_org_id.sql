-- Поиск проекта по UUID организации из внешней системы
ALTER TABLE projects ADD COLUMN IF NOT EXISTS external_organization_id UUID UNIQUE;
CREATE INDEX IF NOT EXISTS idx_projects_external_organization_id ON projects(external_organization_id) WHERE external_organization_id IS NOT NULL;
