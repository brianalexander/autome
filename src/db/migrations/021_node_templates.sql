CREATE TABLE node_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  node_type TEXT NOT NULL,
  icon TEXT,
  category TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  exposed TEXT DEFAULT '[]',
  locked TEXT DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_node_templates_node_type ON node_templates(node_type);
CREATE INDEX idx_node_templates_source ON node_templates(source);
