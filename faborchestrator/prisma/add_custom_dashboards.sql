-- Custom (admin-created) dashboards on the pinned_dashboards table.
--
-- Additive and idempotent: safe to run more than once, and safe to run while
-- both apps are live. Existing rows become kind='recipe' with a NULL definition
-- (unchanged behaviour); new custom dashboards store their re-runnable query set
-- in `definition` so Refresh + scheduled runs can re-execute them.
--
--   psql "$DATABASE_URL" -f faborchestrator/prisma/add_custom_dashboards.sql
--
-- Shape of `definition` (see faborchestrator/lib/fabinsight/custom.ts):
--   { "queries": [ { "key": "...", "label": "...", "sql": "SELECT ...", "limit": 500 }, ... ] }

ALTER TABLE "pinned_dashboards" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'recipe';
ALTER TABLE "pinned_dashboards" ADD COLUMN IF NOT EXISTS "definition" jsonb;
