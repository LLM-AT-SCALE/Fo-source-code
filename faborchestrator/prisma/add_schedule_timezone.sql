-- Timezone for report schedules. The atTime + day fields are interpreted in this
-- IANA timezone; the scheduler converts to UTC (DST-aware) for next_run_at.
-- Additive + idempotent; existing rows default to UTC (unchanged behaviour).
--
--   psql "$DATABASE_URL" -f faborchestrator/prisma/add_schedule_timezone.sql

ALTER TABLE "report_schedules" ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'UTC';
