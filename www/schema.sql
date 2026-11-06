CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, title TEXT, date TEXT, type TEXT,
  body_markdown TEXT, body_version INTEGER, body_updated_at TEXT,
  body_flags TEXT, created_at TEXT, updated_at TEXT, archived INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT, done INTEGER, due_date TEXT,
  priority TEXT, project TEXT, place TEXT,
  body_markdown TEXT, body_version INTEGER, body_updated_at TEXT,
  body_flags TEXT, created_at TEXT, updated_at TEXT, archived INTEGER,
  subtasks TEXT, recurrence TEXT, recurrence_group TEXT
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, title TEXT, role TEXT,
  body_markdown TEXT, body_version INTEGER, body_updated_at TEXT,
  body_flags TEXT, created_at TEXT, updated_at TEXT, archived INTEGER
);
CREATE TABLE IF NOT EXISTS reading_items (
  id TEXT PRIMARY KEY, title TEXT, url TEXT, status TEXT, source TEXT, added TEXT,
  body_markdown TEXT, body_version INTEGER, body_updated_at TEXT,
  body_flags TEXT, created_at TEXT, updated_at TEXT, archived INTEGER
);
CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY, title TEXT, noted TEXT,
  body_markdown TEXT, body_version INTEGER, body_updated_at TEXT,
  body_flags TEXT, created_at TEXT, updated_at TEXT, archived INTEGER
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, title TEXT, category TEXT, status TEXT,
  body_markdown TEXT, body_version INTEGER, body_updated_at TEXT,
  body_flags TEXT, created_at TEXT, updated_at TEXT, archived INTEGER,
  subtasks TEXT
);
CREATE TABLE IF NOT EXISTS custom_objects (
  id TEXT PRIMARY KEY, type TEXT, title TEXT, fields_json TEXT,
  archived INTEGER, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS custom_object_types (
  slug TEXT PRIMARY KEY, name TEXT, fields_json TEXT, has_tab INTEGER,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_type TEXT, from_id TEXT, to_type TEXT, to_id TEXT, relation_name TEXT,
  UNIQUE (from_type, from_id, to_type, to_id, relation_name)
);
CREATE TABLE IF NOT EXISTS object_tags (
  object_type TEXT, object_id TEXT, tag TEXT,
  PRIMARY KEY (object_type, object_id, tag)
);
CREATE TABLE IF NOT EXISTS tag_vocab (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, name TEXT,
  UNIQUE (scope, name)
);
CREATE TABLE IF NOT EXISTS field_values (
  object_type TEXT, field TEXT, value TEXT,
  PRIMARY KEY (object_type, field, value)
);
CREATE TABLE IF NOT EXISTS ui_prefs (
  key TEXT PRIMARY KEY, value TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  client_change_id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL,
  base_updated_at TEXT, row_json TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_change_id TEXT, table_name TEXT, row_id TEXT,
  server_row_json TEXT, local_row_json TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  name TEXT,
  created_at TEXT,
  updated_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_type, owner_id);

-- Recovery history (feature batch, local-only; also created at
-- runtime by SyncEngine.ensureHistorySchema for existing DBs).
CREATE TABLE IF NOT EXISTS row_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL,
  row_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_row_history_row ON row_history(table_name, row_id);
