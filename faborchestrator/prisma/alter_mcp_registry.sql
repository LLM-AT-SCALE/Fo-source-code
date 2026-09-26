-- Additive, non-destructive, idempotent. Extends the MCP catalog + links assignments.
ALTER TABLE "mcp_registry" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "mcp_registry" ADD COLUMN IF NOT EXISTS "auth_credentials_encrypted" TEXT;
ALTER TABLE "mcp_registry" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "mcp_registry" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "mcp_connections" ADD COLUMN IF NOT EXISTS "registry_id" TEXT;
CREATE INDEX IF NOT EXISTS "mcp_connections_registry_id_idx" ON "mcp_connections" ("registry_id");
