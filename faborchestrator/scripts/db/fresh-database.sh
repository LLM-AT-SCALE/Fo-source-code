#!/usr/bin/env bash
# Rebuild a database from scratch for the CURRENT app: drop everything, create
# the schema from prisma/schema.prisma, add the indexes Prisma cannot express,
# seed configuration only (platform settings, model registry, prompt chips,
# roles, one admin user). No data survives.
#
#   DATABASE_URL=postgresql://... \
#   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='...' \
#   scripts/db/fresh-database.sh --yes
#
# Without --yes it only prints what it would do. Run from faborchestrator/.
# Needs: psql, node (prisma CLI from node_modules), tsx (for prisma/seed.ts).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here"

: "${DATABASE_URL:?set DATABASE_URL to the database to REBUILD}"
: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_NAME:?set ADMIN_NAME}"; : "${ADMIN_PASSWORD:?set ADMIN_PASSWORD}"
export DATABASE_URL ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD

dbname="$(psql "$DATABASE_URL" -At -c 'select current_database()')"
host="$(psql "$DATABASE_URL" -At -c "select coalesce(inet_server_addr()::text, 'local socket')")"
tables="$(psql "$DATABASE_URL" -At -c "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
echo "database : $dbname on $host"
echo "tables   : $tables (all will be dropped, with every row)"
echo "admin    : $ADMIN_EMAIL ($ADMIN_NAME)"
if [ "${1:-}" != "--yes" ]; then
  echo "dry run — add --yes to rebuild"; exit 0
fi

echo "== 1/6 generate DDL from prisma/schema.prisma"
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/fresh_schema.sql
grep -c "CREATE TABLE" prisma/fresh_schema.sql | sed 's/^/   tables in DDL: /'

echo "== 2/6 drop everything"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA IF EXISTS po_ui_codegeneration CASCADE;   -- leftover of the standalone PO UI app; unused
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "ALTER DATABASE \"$dbname\" SET timezone TO 'UTC'"

echo "== 3/6 create schema"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f prisma/fresh_schema.sql
echo "== 4/6 indexes Prisma cannot express"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f prisma/fresh_extras.sql

echo "== 5/6 configuration rows"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f prisma/create_platform_settings.sql     # 'global' theme row
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f prisma/update_model_registry_tiers.sql  # the four platform models
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f prisma/create_prompt_chips.sql          # default prompt chips
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f prisma/ensure_admin_role.sql            # built-in Admin role

echo "== 6/6 roles + admin user (prisma/seed.ts)"
npx tsx prisma/seed.ts

echo "== done"
psql "$DATABASE_URL" -At -F' | ' -c "
select 'tables', count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'
union all select 'roles', count(*) from roles
union all select 'users', count(*) from users
union all select 'models', count(*) from model_registry
union all select 'prompt_chips', count(*) from prompt_chips
union all select 'platform_settings', count(*) from platform_settings"
