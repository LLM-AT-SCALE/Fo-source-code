-- Per-agent MCP connections: every row (admin-assigned or personal) belongs to
-- exactly one agent. Existing connections were all used by the chat that
-- builds dashboards, so they move to FabInsight. Additive + idempotent; run
-- directly, never via `prisma db push`:
--   psql "$DATABASE_URL" -f prisma/add_mcp_agent.sql
ALTER TABLE "mcp_connections" ADD COLUMN IF NOT EXISTS "agent" TEXT NOT NULL DEFAULT 'fabinsight';
CREATE INDEX IF NOT EXISTS "mcp_connections_agent_idx" ON "mcp_connections" ("agent");
