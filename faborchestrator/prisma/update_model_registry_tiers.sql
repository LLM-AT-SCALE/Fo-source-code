-- Model registry: the four platform models, tiered by capability.
--
--   FabOrchestrator 1  claude-sonnet-5    lowest tier
--   FabOrchestrator 2  claude-opus-5
--   FabOrchestrator 3  claude-fable-5
--   FabOrchestrator 4  claude-fable-5-1   highest tier (default)
--
-- Idempotent: upserts the four rows, deactivates every other row (kept for
-- usage history), and rewrites roles.allowed_models so no role is left
-- pointing only at retired model ids. Run directly, never via `db push`:
--   psql "$DATABASE_URL" -f prisma/update_model_registry_tiers.sql

BEGIN;

INSERT INTO "model_registry"
  ("id", "model_id", "display_name", "description",
   "input_cost_per_1m", "output_cost_per_1m", "cache_read_cost_per_1m", "cache_write_cost_per_1m",
   "thinking_type", "is_active", "is_default", "sort_order", "updated_at")
VALUES
  (gen_random_uuid(), 'claude-sonnet-5',  'FabOrchestrator 1', 'Fast and efficient for everyday work',
   2, 10, 0.20, 2.50, 'adaptive', true, false, 1, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'claude-opus-5',    'FabOrchestrator 2', 'Strong reasoning for complex tasks',
   5, 25, 0.50, 6.25, 'adaptive', true, false, 2, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'claude-fable-5',   'FabOrchestrator 3', 'Advanced reasoning for demanding work',
   10, 50, 1.00, 12.50, 'adaptive', true, false, 3, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'claude-fable-5-1', 'FabOrchestrator 4', 'Most capable model',
   10, 50, 1.00, 12.50, 'adaptive', true, true, 4, CURRENT_TIMESTAMP)
ON CONFLICT ("model_id") DO UPDATE SET
  "display_name"  = EXCLUDED."display_name",
  "description"   = EXCLUDED."description",
  "thinking_type" = EXCLUDED."thinking_type",
  "is_active"     = true,
  "is_default"    = EXCLUDED."is_default",
  "sort_order"    = EXCLUDED."sort_order",
  "updated_at"    = CURRENT_TIMESTAMP;

-- Retire everything else (history in usage tables still resolves the names).
UPDATE "model_registry"
   SET "is_active" = false, "is_default" = false, "updated_at" = CURRENT_TIMESTAMP
 WHERE "model_id" NOT IN ('claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-fable-5-1')
   AND ("is_active" OR "is_default");

-- Roles: drop retired ids. The Admin role gets all four; any other role that
-- listed models but would end up with none gets the two lower tiers. A role
-- whose list was already empty is left alone (empty = every model in Fab AI).
WITH mapped AS (
  SELECT id, name,
         jsonb_array_length("allowed_models") AS had,
         COALESCE(
           (SELECT jsonb_agg(v) FROM jsonb_array_elements_text("allowed_models") AS t(v)
             WHERE v IN ('claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-fable-5-1')),
           '[]'::jsonb) AS kept
    FROM "roles"
   WHERE jsonb_typeof("allowed_models") = 'array'
), target AS (
  SELECT id,
         CASE
           WHEN name = 'Admin' THEN '["claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-fable-5-1"]'::jsonb
           WHEN had > 0 AND jsonb_array_length(kept) = 0 THEN '["claude-sonnet-5", "claude-opus-5"]'::jsonb
           ELSE kept
         END AS models
    FROM mapped
)
UPDATE "roles" r
   SET "allowed_models" = t.models,
       "updated_at" = CURRENT_TIMESTAMP
  FROM target t
 WHERE r.id = t.id
   AND r."allowed_models" IS DISTINCT FROM t.models;

COMMIT;
