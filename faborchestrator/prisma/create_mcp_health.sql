-- MCP health checks: latest status on the registry row + history table.
-- Idempotent; run once per database (the schema also carries these models).
ALTER TABLE mcp_registry ADD COLUMN IF NOT EXISTS health_status     TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE mcp_registry ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ;
ALTER TABLE mcp_registry ADD COLUMN IF NOT EXISTS health_detail     JSONB;
ALTER TABLE mcp_registry ADD COLUMN IF NOT EXISTS health_probe      JSONB;

CREATE TABLE IF NOT EXISTS mcp_health_checks (
  id          TEXT PRIMARY KEY,
  registry_id TEXT NOT NULL REFERENCES mcp_registry(id) ON DELETE CASCADE,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT NOT NULL,
  stage       INTEGER NOT NULL DEFAULT 0,
  reach_ms    INTEGER,
  tools_ms    INTEGER,
  data_ms     INTEGER,
  tool_used   TEXT,
  error       TEXT,
  source      TEXT NOT NULL DEFAULT 'scheduled'
);
CREATE INDEX IF NOT EXISTS mcp_health_checks_registry_id_checked_at_idx ON mcp_health_checks (registry_id, checked_at);
