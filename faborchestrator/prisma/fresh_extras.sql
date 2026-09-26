-- Indexes the app relies on that Prisma cannot express (expression / partial).
-- Applied by scripts/db/fresh-database.sh right after the Prisma-generated DDL.
-- Source of truth for these stays here; `prisma migrate diff` never emits them.

-- One threshold per metric + source + dashboard, with "no dashboard" as ''.
CREATE UNIQUE INDEX IF NOT EXISTS alert_thresholds_metric_dash_uidx
  ON alert_thresholds (metric_key, source_key, COALESCE(dashboard_id, ''));

-- A CMF database is granted once per role and once per user.
CREATE UNIQUE INDEX IF NOT EXISTS cmf_access_role_db_uq
  ON cmf_access (db_key, role_id) WHERE role_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cmf_access_user_db_uq
  ON cmf_access (db_key, user_id) WHERE user_id IS NOT NULL;

-- Admin performance page: slowest time-to-first-token first.
CREATE INDEX IF NOT EXISTS prompt_audit_logs_ttft_idx
  ON prompt_audit_logs (((timings->>'ttftMs')::numeric) DESC) WHERE timings IS NOT NULL;
