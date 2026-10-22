-- Version history: a snapshot of the document per save, coalesced to at most
-- one row per 30 seconds of continuous editing and capped per project.
CREATE TABLE project_versions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  doc TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, version)
);
CREATE INDEX project_versions_recent ON project_versions(project_id, updated_at);

-- Soft delete: deleted projects go to the trash and can be restored.
ALTER TABLE projects ADD COLUMN deleted_at INTEGER;

-- Existing documents become the first history entry.
INSERT INTO project_versions (project_id, version, doc, source, created_at, updated_at)
  SELECT id, version, doc, 'import', updated_at, updated_at FROM projects;
