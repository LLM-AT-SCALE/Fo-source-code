-- On-the-Fly MCP — control-plane table for admin-created MCP data sources.
-- Additive, idempotent. Safe to run repeatedly against the shared DB.
-- The target credential VALUE is never stored here — only the Secrets Manager
-- ARN + non-secret metadata. Consumption reuses mcp_registry + mcp_connections.
--
--   psql "$DATABASE_URL" -f prisma/create_mcp_data_sources.sql

-- ── enum ──
DO $$ BEGIN
  CREATE TYPE "mcp_data_source_status" AS ENUM
    ('DRAFT', 'CONNECTED', 'GENERATED', 'DEPLOYING', 'ACTIVE', 'FAILED', 'RETIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── mcp_data_sources ──
CREATE TABLE IF NOT EXISTS "mcp_data_sources" (
  "id"                       TEXT PRIMARY KEY,
  "name"                     TEXT NOT NULL,
  "engine"                   TEXT NOT NULL DEFAULT 'postgres',
  "status"                   "mcp_data_source_status" NOT NULL DEFAULT 'DRAFT',
  "host"                     TEXT,
  "port"                     INTEGER,
  "database"                 TEXT,
  "schemas_json"             JSONB NOT NULL DEFAULT '[]',
  "secret_arn"               TEXT,
  "discovered_schema"        JSONB,
  "manifest"                 JSONB,
  "static_check"             JSONB,
  "runtime_version"          TEXT,
  "lambda_arn"               TEXT,
  "endpoint_url"             TEXT,
  "endpoint_auth_encrypted"  TEXT,
  "registry_id"              TEXT,
  "last_error"               TEXT,
  "created_by_id"            TEXT NOT NULL,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "mcp_data_sources_status_idx" ON "mcp_data_sources" ("status");
CREATE INDEX IF NOT EXISTS "mcp_data_sources_created_by_id_idx" ON "mcp_data_sources" ("created_by_id");
