-- Projects hold the whole timeline document as JSON. `version` increments on
-- every save and is used for optimistic concurrency between editors.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  edit_key_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  doc TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  duration REAL,
  width INTEGER,
  height INTEGER,
  r2_key TEXT NOT NULL,
  upload_id TEXT,
  has_thumb INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX assets_project ON assets(project_id);

CREATE TABLE renders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  timeline_id TEXT NOT NULL,
  timeline_name TEXT NOT NULL,
  preset TEXT NOT NULL,
  doc_version INTEGER NOT NULL,
  doc TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  worker TEXT,
  output_key TEXT,
  output_size INTEGER,
  upload_id TEXT,
  error TEXT,
  auto_publish INTEGER NOT NULL DEFAULT 0,
  -- Published renders get a public watch page at /w/<id>.
  published_at INTEGER,
  publish_title TEXT,
  publish_description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX renders_project ON renders(project_id);
CREATE INDEX renders_status ON renders(status, created_at);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  frame INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_project ON comments(project_id);
