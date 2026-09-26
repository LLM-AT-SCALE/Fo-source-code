-- CMF database access grants (per-user + per-role)
-- =================================================
-- Governs which CMF database connections a user may see/use, mirroring the MCP
-- assignment model (mcp_connections with userId/roleId). A grant is polymorphic:
-- EXACTLY ONE of user_id / role_id is set. A user's effective access = the UNION
-- of their direct user grants and their role's grants. Admins bypass entirely.
--
-- Additive model: no grants = no CMF access. To preserve today's behaviour (all
-- users could use both DBs), we SEED every existing user with a grant to every
-- enabled connection. New users start with none until an admin grants access.
--
-- Additive + idempotent. NEVER `prisma db push` (shared DB). Run this SQL then
-- `prisma db pull` + `prisma generate` (Fab Orch).

CREATE TABLE IF NOT EXISTS cmf_access (
  id            TEXT PRIMARY KEY,
  db_key        TEXT NOT NULL REFERENCES cmf_connections(db_key) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  role_id       TEXT REFERENCES roles(id) ON DELETE CASCADE,
  created_by_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- exactly one target (a grant is EITHER to a user OR to a role)
  CONSTRAINT cmf_access_one_target CHECK (num_nonnulls(user_id, role_id) = 1)
);

-- Dedupe: a (db_key, user) or (db_key, role) grant is unique. Partial indexes so
-- the NULL side never collides.
CREATE UNIQUE INDEX IF NOT EXISTS cmf_access_user_db_uq ON cmf_access (db_key, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cmf_access_role_db_uq ON cmf_access (db_key, role_id) WHERE role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cmf_access_user_idx ON cmf_access (user_id);
CREATE INDEX IF NOT EXISTS cmf_access_role_idx ON cmf_access (role_id);

-- Seed: grant every existing user access to every enabled connection, preserving
-- the pre-feature "everyone sees all DBs" behaviour. Idempotent.
INSERT INTO cmf_access (id, db_key, user_id, created_at)
SELECT gen_random_uuid()::text, c.db_key, u.id, now()
  FROM users u
  CROSS JOIN cmf_connections c
 WHERE c.enabled = TRUE
ON CONFLICT (db_key, user_id) WHERE user_id IS NOT NULL DO NOTHING;
