-- CMF Database Connections + Bearer Token store
-- =============================================
-- Admin-managed registry of CMF database connections (replaces the hardcoded
-- profiles in lib/cmf/db-registry.ts) plus a token table the auth Lambda writes
-- every ~45 min (replaces the Secrets Manager read in lib/cmf/cmf-auth.ts).
--
-- SAFETY: purely additive + idempotent. Nothing reads these tables until the new
-- app code ships, and the seed rows carry ONLY non-secret connection facts
-- (sql_password_encrypted + token start NULL/empty). The app falls back to the
-- existing env vars / Secrets Manager whenever a row's secret is absent, so
-- creating + seeding these tables changes zero runtime behaviour.
--
-- NEVER `prisma db push` (this is a shared DB). Run this SQL directly, then
-- `prisma db pull` + `prisma generate`.

-- 1) Connection registry ------------------------------------------------------
CREATE TABLE IF NOT EXISTS cmf_connections (
  id                     TEXT PRIMARY KEY,
  db_key                 TEXT NOT NULL,                 -- 'source' | 'target' | future keys
  label                  TEXT NOT NULL,
  engine                 TEXT NOT NULL DEFAULT 'mssql',
  sql_server             TEXT NOT NULL,
  sql_instance           TEXT,
  sql_database           TEXT NOT NULL,
  sql_user               TEXT NOT NULL,
  sql_password_encrypted TEXT,                          -- AES-256-GCM; NULL until an admin stores one
  base_url               TEXT NOT NULL,
  host_resolver          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [["host","ip"], ...]
  token_db_name          TEXT NOT NULL,                 -- key into cmf_bearer_tokens.cmf_database_name
  token_secret_id        TEXT,                          -- Secrets Manager fallback (legacy) while migrating
  enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_id          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cmf_connections_db_key_key ON cmf_connections (db_key);

-- 1b) Per-connection provisioning columns (Stage C) ---------------------------
-- The portal login credentials the token-minting Lambda uses (DISTINCT from the
-- SQL user/password above), plus handles to the Lambda + its schedule so they
-- can be torn down when the connection is deleted. Additive + idempotent.
ALTER TABLE cmf_connections ADD COLUMN IF NOT EXISTS portal_user               TEXT;
ALTER TABLE cmf_connections ADD COLUMN IF NOT EXISTS portal_password_encrypted TEXT;  -- AES-256-GCM
ALTER TABLE cmf_connections ADD COLUMN IF NOT EXISTS lambda_arn                TEXT;
ALTER TABLE cmf_connections ADD COLUMN IF NOT EXISTS schedule_name             TEXT;

-- 2) Bearer token store (written by the auth Lambda, read by the app) ---------
CREATE TABLE IF NOT EXISTS cmf_bearer_tokens (
  cmf_database_name TEXT PRIMARY KEY,   -- matches cmf_connections.token_db_name
  token             TEXT NOT NULL,
  expires_at        TIMESTAMPTZ,        -- ms/JWT expiry; app refreshes when near
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3) Seed the two existing connections from the current committed defaults -----
-- (lib/cmf/db-registry.ts). Passwords intentionally left NULL: the two built-in
-- profiles keep their committed env-default password (CMF_SQL_PASS /
-- CMF_SQL_PASS_TARGET) until an admin stores one in the UI.
-- ON CONFLICT DO NOTHING keeps this safe to re-run.
INSERT INTO cmf_connections
  (id, db_key, label, engine, sql_server, sql_instance, sql_database, sql_user,
   base_url, host_resolver, token_db_name, token_secret_id, enabled)
VALUES
  ('cmfconn_source', 'source', 'Entegris / KSP (source)', 'mssql',
   '10.10.1.224', 'ONLINE', 'EntegrisKSPUpgrade', 'cmuser',
   'https://atscmapp4.usa.athenatec.com',
   '[["atscmapp4.usa.athenatec.com","10.10.1.224"]]'::jsonb,
   'EntegrisKSPUpgrade', 'cmf/portal-token-entegris-224', TRUE),
  ('cmfconn_target', 'target', 'OOB (target)', 'mssql',
   '10.10.1.145', 'ONLINE', 'CriticalManufacturing', 'cmuser',
   'https://athena-cmf-srv.usa.athenatec.com',
   '[["athena-cmf-srv.usa.athenatec.com","10.10.1.145"]]'::jsonb,
   'CriticalManufacturing', 'cmf/portal-token-oob', TRUE)
ON CONFLICT (db_key) DO NOTHING;
