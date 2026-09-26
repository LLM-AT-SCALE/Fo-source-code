-- Recent Reports scheduled-refresh feature.
-- Additive + idempotent. Run directly against claude_ai_athena (shared DB).
-- NEVER `prisma db push` (would drop tables the admin app / other apps own).

-- 1. Per-dashboard refresh schedule (written by admin app, read by Fab Orch cron).
CREATE TABLE IF NOT EXISTS report_schedules (
  id               TEXT PRIMARY KEY,
  dashboard_id     TEXT NOT NULL,
  source_key       TEXT NOT NULL DEFAULT 'lumentum',
  frequency        TEXT NOT NULL DEFAULT 'hourly',   -- hourly | daily | weekly | monthly
  interval_minutes INTEGER,
  at_time          TEXT,                              -- 'HH:MM' UTC (daily/weekly/monthly)
  days_of_week     TEXT,                              -- '1,3,5' — weekly, one or more days
  day_of_month     INTEGER,                           -- 1-31 for monthly
  enabled          BOOLEAN NOT NULL DEFAULT true,
  next_run_at      TIMESTAMPTZ,
  last_run_at      TIMESTAMPTZ,
  last_status      TEXT,
  updated_by_id    TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Added later: weekly can run on multiple days ("1,3,5"). Idempotent for
-- environments where report_schedules already exists.
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS days_of_week TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS report_schedules_dashboard_source_key
  ON report_schedules (dashboard_id, source_key);
CREATE INDEX IF NOT EXISTS report_schedules_enabled_next_run_idx
  ON report_schedules (enabled, next_run_at);

-- Seed the 7 canonical dashboards, hourly + enabled, due now. Idempotent.
INSERT INTO report_schedules (id, dashboard_id, source_key, frequency, enabled, next_run_at)
SELECT gen_random_uuid()::text, d, 'lumentum', 'hourly', true, now()
FROM (VALUES
  ('factory-operations'),
  ('lot-history'),
  ('process-analytics'),
  ('maintenance-prediction'),
  ('bottleneck-prediction'),
  ('analytics-dashboard'),
  ('executive-overview')
) AS t(d)
ON CONFLICT (dashboard_id, source_key) DO NOTHING;

-- 2. Per-pin cache columns (Fab Orch cron writes the snapshot; /reports reads it).
ALTER TABLE pinned_dashboards ADD COLUMN IF NOT EXISTS source_key     TEXT NOT NULL DEFAULT 'lumentum';
ALTER TABLE pinned_dashboards ADD COLUMN IF NOT EXISTS cached_html    TEXT;
ALTER TABLE pinned_dashboards ADD COLUMN IF NOT EXISTS cached_summary TEXT;
ALTER TABLE pinned_dashboards ADD COLUMN IF NOT EXISTS refreshed_at   TIMESTAMPTZ;
ALTER TABLE pinned_dashboards ADD COLUMN IF NOT EXISTS last_status    TEXT;
