-- Audit & compliance additions. Additive, non-destructive, idempotent.
--   * prompt_audit_logs.model         → per-model attribution in the audit record
--   * platform_settings.audit_retention_days → configurable audit retention
-- Run once against the shared DB BEFORE deploying the code that writes them:
--   psql "$DATABASE_URL" -f prisma/alter_audit_compliance.sql

-- prompt_audit_logs is a raw-SQL table; add the model column if missing.
ALTER TABLE "prompt_audit_logs" ADD COLUMN IF NOT EXISTS "model" TEXT;

-- Ensure platform_settings exists, then add the retention setting.
CREATE TABLE IF NOT EXISTS "platform_settings" (
  "id"            TEXT NOT NULL,
  "color_theme"   TEXT NOT NULL DEFAULT 'fab-blue',
  "updated_by_id" TEXT,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "audit_retention_days" INTEGER NOT NULL DEFAULT 90;
INSERT INTO "platform_settings" ("id", "color_theme", "updated_at")
VALUES ('global', 'fab-blue', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
