-- Model Registry: admin-configurable AI models + per-token pricing.
-- Additive, non-destructive, idempotent. Creates only the new model_registry
-- table and seeds the current 3 models. Touches no existing tables.
--
-- Run against the shared DB, e.g.:
--   psql "$DATABASE_URL" -f prisma/create_model_registry.sql

CREATE TABLE IF NOT EXISTS "model_registry" (
  "id"                     TEXT NOT NULL,
  "model_id"               TEXT NOT NULL,
  "display_name"           TEXT NOT NULL,
  "description"            TEXT,
  "input_cost_per_1m"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "output_cost_per_1m"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "cache_read_cost_per_1m" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "cache_write_cost_per_1m" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "thinking_type"          TEXT NOT NULL DEFAULT 'adaptive',
  "thinking_budget"        INTEGER,
  "is_active"              BOOLEAN NOT NULL DEFAULT true,
  "is_default"             BOOLEAN NOT NULL DEFAULT false,
  "sort_order"             INTEGER NOT NULL DEFAULT 0,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "model_registry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "model_registry_model_id_key" ON "model_registry" ("model_id");
CREATE INDEX IF NOT EXISTS "model_registry_is_active_idx" ON "model_registry" ("is_active");
CREATE INDEX IF NOT EXISTS "model_registry_sort_order_idx" ON "model_registry" ("sort_order");

-- Seed the current 3 FabOrchestrator models (idempotent on model_id).
INSERT INTO "model_registry"
  ("id", "model_id", "display_name", "description",
   "input_cost_per_1m", "output_cost_per_1m", "cache_read_cost_per_1m", "cache_write_cost_per_1m",
   "thinking_type", "is_active", "is_default", "sort_order", "updated_at")
VALUES
  (gen_random_uuid(), 'claude-opus-4-7', 'FabOrchestrator 1.0', 'Powerful reasoning with adaptive thinking',
   5, 25, 0.50, 6.25, 'adaptive', true, false, 0, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'claude-sonnet-5', 'FabOrchestrator 1.1', 'Fast and intelligent with adaptive thinking',
   2, 10, 0.20, 2.50, 'adaptive', true, false, 1, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'claude-opus-4-8', 'FabOrchestrator 2.0', 'Most capable model with adaptive thinking',
   5, 25, 0.50, 6.25, 'adaptive', true, true, 2, CURRENT_TIMESTAMP)
ON CONFLICT ("model_id") DO NOTHING;
