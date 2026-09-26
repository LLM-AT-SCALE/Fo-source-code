-- CMF Master-Data Loader (Modeling Agent) — additive, idempotent migration.
-- Safe to run repeatedly against the shared DB. Creates the loader tables,
-- their enums, and the conversations.agent discriminator. The audit trail
-- reuses the existing audit_logs table (action = 'cmf.*'), so there is no
-- separate audit_events table.
--
--   psql "$DATABASE_URL" -f prisma/create_cmf_dataloader.sql

-- ── conversations.agent — separates Modeling Agent chats from general chats ──
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "agent" TEXT NOT NULL DEFAULT 'chat';

-- ── enums ──
DO $$ BEGIN
  CREATE TYPE "cmf_operation" AS ENUM ('VALIDATE', 'LOAD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "cmf_run_status" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILURE', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── cmf_packages ──
CREATE TABLE IF NOT EXISTS "cmf_packages" (
  "id"                 TEXT PRIMARY KEY,
  "cmf_id"             TEXT NOT NULL UNIQUE,
  "name"               TEXT NOT NULL,
  "filename"           TEXT NOT NULL,
  "checksum"           TEXT NOT NULL,
  "size_bytes"         BIGINT NOT NULL,
  "content_type"       TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL REFERENCES "users"("id"),
  "last_result"        INTEGER,
  "last_operation"     "cmf_operation",
  "last_run_at"        TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "cmf_packages_created_at_idx" ON "cmf_packages" ("created_at");

-- ── cmf_staged_uploads ──
CREATE TABLE IF NOT EXISTS "cmf_staged_uploads" (
  "id"             TEXT PRIMARY KEY,
  "user_id"        TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "filename"       TEXT NOT NULL,
  "s3_key"         TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'UPLOADED',
  "package_name"   TEXT,
  "package_cmf_id" TEXT,
  "selected_types" JSONB,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "cmf_staged_uploads_user_id_idx" ON "cmf_staged_uploads" ("user_id");
CREATE INDEX IF NOT EXISTS "cmf_staged_uploads_status_idx" ON "cmf_staged_uploads" ("status");

-- ── cmf_package_files ──
CREATE TABLE IF NOT EXISTS "cmf_package_files" (
  "id"         TEXT PRIMARY KEY,
  "package_id" TEXT NOT NULL UNIQUE REFERENCES "cmf_packages"("id"),
  "filename"   TEXT NOT NULL,
  "s3_key"     TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── cmf_runs ──
CREATE TABLE IF NOT EXISTS "cmf_runs" (
  "id"                    TEXT PRIMARY KEY,
  "package_id"            TEXT NOT NULL REFERENCES "cmf_packages"("id"),
  "user_id"               TEXT NOT NULL REFERENCES "users"("id"),
  "operation"             "cmf_operation" NOT NULL,
  "status"                "cmf_run_status" NOT NULL DEFAULT 'QUEUED',
  "cmf_baseline_end_date" TEXT,
  "selected_types"        JSONB NOT NULL,
  "result"                INTEGER,
  "log"                   JSONB,
  "error"                 TEXT,
  "started_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at"              TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "cmf_runs_package_id_idx" ON "cmf_runs" ("package_id");
CREATE INDEX IF NOT EXISTS "cmf_runs_started_at_idx" ON "cmf_runs" ("started_at");
