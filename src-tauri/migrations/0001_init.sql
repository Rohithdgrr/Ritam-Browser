-- Govind Browser — schema v1 (milestone 1)
-- Applied at every startup via CREATE TABLE IF NOT EXISTS; safe to re-run.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '#4A6B5D',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#4A6B5D',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  profile_id TEXT
);

CREATE TABLE IF NOT EXISTS tabs (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url            TEXT NOT NULL DEFAULT 'govind://home',
  title          TEXT NOT NULL DEFAULT 'New Tab',
  favicon_url    TEXT,
  is_pinned      INTEGER NOT NULL DEFAULT 0,
  group_name     TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tabs_workspace ON tabs(workspace_id, sort_order);

CREATE TABLE IF NOT EXISTS bookmarks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL UNIQUE,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  visited_at  INTEGER NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_history_visited ON history(visited_at DESC);

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  filename       TEXT NOT NULL,
  destination    TEXT,
  mime_type      TEXT,
  total_bytes    INTEGER,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_permissions (
  id         TEXT PRIMARY KEY,
  origin     TEXT NOT NULL,
  permission TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK (decision IN ('ask', 'allow', 'deny')),
  updated_at INTEGER NOT NULL,
  UNIQUE (origin, permission)
);

CREATE TABLE IF NOT EXISTS reading_list (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  snapshot_text  TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reading_list_created ON reading_list(created_at DESC);
