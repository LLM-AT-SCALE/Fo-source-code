-- Discrepancy alerts (Lumentum V06) — one-time migration, apply ONCE to the
-- shared RDS. Do NOT `prisma migrate` (two apps share this DB); follow the
-- hand-applied-SQL + @@map convention used by create_cmf_connections.sql.
-- Idempotent: safe to re-run.

-- 1) Admin-configurable alert thresholds.
CREATE TABLE IF NOT EXISTS alert_thresholds (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  metric_key     TEXT             NOT NULL,
  label          TEXT,
  comparator     TEXT             NOT NULL DEFAULT 'gt',   -- 'gt' | 'lt' | 'outside'
  min_value      DOUBLE PRECISION,
  max_value      DOUBLE PRECISION,
  dashboard_id   TEXT,
  source_key     TEXT             NOT NULL DEFAULT 'lumentum',
  throttle_min   INTEGER          NOT NULL DEFAULT 60,
  is_active      BOOLEAN          NOT NULL DEFAULT true,
  created_by_id  TEXT,
  created_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- Per-threshold recipient roles (JSON array of role ids). Empty = fall back to
-- the default alert roles (Shift Lead / Shift Supervisor / Admin).
ALTER TABLE alert_thresholds
  ADD COLUMN IF NOT EXISTS recipient_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Custom-dashboard alerting: for a threshold whose metric_key is
-- 'custom:<pinnedId>:<setKey>:<column>', these hold the query set + numeric column
-- to read from the custom dashboard's result. Null for the 7 curated metrics.
ALTER TABLE alert_thresholds ADD COLUMN IF NOT EXISTS custom_set_key TEXT;
ALTER TABLE alert_thresholds ADD COLUMN IF NOT EXISTS custom_column  TEXT;

-- Fab records each custom (pinned) dashboard's discovered numeric columns here so
-- the admin can pick them without MES access: [{setKey,setLabel,column}].
ALTER TABLE pinned_dashboards
  ADD COLUMN IF NOT EXISTS metric_columns JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS alert_thresholds_active_idx
  ON alert_thresholds (is_active);

CREATE UNIQUE INDEX IF NOT EXISTS alert_thresholds_metric_dash_uidx
  ON alert_thresholds (metric_key, source_key, COALESCE(dashboard_id, ''));

-- 1b) Rolling metric samples — the Fab scheduler records each metric's live
-- value here so the admin UI can show a DYNAMIC "normal range" (7-day min/avg/max
-- + current) when picking a metric. Pruned to ~30 days by the sampler.
CREATE TABLE IF NOT EXISTS metric_samples (
  id          BIGSERIAL PRIMARY KEY,
  metric_key  TEXT             NOT NULL,
  source_key  TEXT             NOT NULL DEFAULT 'lumentum',
  value       DOUBLE PRECISION NOT NULL,
  sampled_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS metric_samples_key_time_idx
  ON metric_samples (metric_key, sampled_at DESC);

-- 2) Seed the backward-compat threshold: equipment idle > 30% (preserves the POC).
INSERT INTO alert_thresholds (metric_key, comparator, max_value, throttle_min, is_active)
SELECT 'equipment_idle_pct', 'gt', 30, 60, true
WHERE NOT EXISTS (
  SELECT 1 FROM alert_thresholds
   WHERE metric_key = 'equipment_idle_pct' AND source_key = 'lumentum'
     AND COALESCE(dashboard_id, '') = ''
);

-- 3) Create the two recipient roles (Admin already exists). Idempotent.
INSERT INTO roles (id, name, description, is_system_role, permissions, allowed_models, created_at, updated_at)
VALUES
  (gen_random_uuid()::text, 'Shift Lead',       'Shift Lead — discrepancy alert recipient',       false, '[]'::jsonb, '[]'::jsonb, now(), now()),
  (gen_random_uuid()::text, 'Shift Supervisor', 'Shift Supervisor — discrepancy alert recipient', false, '[]'::jsonb, '[]'::jsonb, now(), now())
ON CONFLICT (name) DO NOTHING;
