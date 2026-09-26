-- Additive, non-destructive: creates only the new platform_settings table
-- and seeds the singleton row. Touches no existing tables. Idempotent.
CREATE TABLE IF NOT EXISTS "platform_settings" (
  "id"            TEXT NOT NULL,
  "color_theme"   TEXT NOT NULL DEFAULT 'fab-blue',
  "updated_by_id" TEXT,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "platform_settings" ("id", "color_theme", "updated_at")
VALUES ('global', 'fab-blue', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
