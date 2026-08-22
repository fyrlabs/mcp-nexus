export interface Migration {
  version: number;
  up: string;
}

const V1_INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  config_hash TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'stdio',
  status TEXT NOT NULL DEFAULT 'registered',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_started_at INTEGER,
  last_connected_at INTEGER
);

CREATE TABLE IF NOT EXISTS capabilities (
  capability_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  tool_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  input_schema_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  schema_hash TEXT NOT NULL DEFAULT '',
  risk_level TEXT NOT NULL DEFAULT 'unknown',
  embedding_ref TEXT,
  availability TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capabilities_server ON capabilities(server_id);
CREATE INDEX IF NOT EXISTS idx_capabilities_tool ON capabilities(server_id, tool_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_capabilities_server_tool ON capabilities(server_id, tool_name);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  session_id TEXT,
  server_id TEXT,
  capability_id TEXT,
  event_type TEXT NOT NULL,
  latency_ms INTEGER,
  success INTEGER,
  source TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_events_capability ON usage_events(capability_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events(event_type);

CREATE TABLE IF NOT EXISTS routing_stats (
  capability_id TEXT PRIMARY KEY REFERENCES capabilities(capability_id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_scope TEXT NOT NULL DEFAULT 'default',
  project_scope TEXT NOT NULL DEFAULT 'default',
  usage_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0,
  avg_latency_ms REAL NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  prediction_score REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routing_stats_usage ON routing_stats(usage_count DESC);

CREATE TABLE IF NOT EXISTS tool_sequences (
  previous_capability_id TEXT NOT NULL,
  next_capability_id TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  probability REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (previous_capability_id, next_capability_id)
);

CREATE INDEX IF NOT EXISTS idx_sequences_prev ON tool_sequences(previous_capability_id, occurrences DESC);
`;

export const MIGRATIONS: Migration[] = [{ version: 1, up: V1_INITIAL_SCHEMA }];
