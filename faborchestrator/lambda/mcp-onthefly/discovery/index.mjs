// =============================================================================
// On-the-Fly MCP — DISCOVERY Lambda (fixed, reviewed, shared).
//
// Runs INSIDE the CMF VPC so it can reach on-prem SQL Server (10.10.x) over the
// VPN, peered RDS, or public DBs via NAT. The admin app invokes it directly
// (lambda:InvokeFunction) — NOT over HTTP — so discovery works for targets the
// admin app itself can't reach. Read-only: reads information_schema only.
//
// Event : { secretArn, engine: "postgres"|"sqlserver", schemas: string[] }
// Return: { ok, tables:[{schema,table,columns:[...]}], discovered, returned, truncated }
//
// DYNAMIC SUBJECT-AREA SELECTION (see ledger UPDATE 10): a large schema (the
// CAMSTAR `cammes` schema has 500+ tables) cannot be returned whole (Lambda
// sync-invoke caps the response at ~6MB), and a blind alphabetical cap HIDES
// entire areas whose table names sort late (SPC, BOM, specs...). We solve this
// WITHOUT any hardcoded/domain vocabulary: we DERIVE groups from the actual table
// names (strip the schema's dominant prefix, then cluster by the leading name
// token), and ROUND-ROBIN across those data-derived groups so every area is
// represented regardless of alphabetical position — then trim to a byte budget.
// Nothing here is specific to any industry or database.
// =============================================================================

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from "pg";
import sql from "mssql";

const REGION = process.env.AWS_REGION || "us-west-2";
const MAX_TABLES = Number(process.env.MAX_TABLES || "800");
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES || "5000000"); // < Lambda 6MB sync cap
const sm = new SecretsManagerClient({ region: REGION });

async function readSecret(arn) {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error("target secret has no value");
  return JSON.parse(res.SecretString);
}

// Group ALL column rows into tables (no cap here — selection happens later).
function groupAll(rows) {
  const byTable = new Map();
  for (const r of rows) {
    const key = `${r.schema}.${r.table}`;
    let t = byTable.get(key);
    if (!t) { t = { schema: r.schema, table: r.table, columns: [] }; byTable.set(key, t); }
    t.columns.push({ column: r.column, type: r.type, nullable: r.nullable });
  }
  return [...byTable.values()];
}

// Select a bounded, representative set of tables from the full list — fully
// data-driven, no domain vocabulary and no fragile name tokenization:
//   1) IMPORTANCE — take the most information-rich tables first, ranked by column
//      count (a schema-agnostic proxy: entity/master/transaction tables are wide,
//      link/lookup stubs are narrow). This favours the tables worth rich tools.
//   2) BREADTH — fill the rest by STRATIFIED sampling evenly across the full
//      name-sorted list, so areas whose names sort late (SPC, Spec, BOM, ...) are
//      always represented instead of being truncated by an alphabetical cap.
function selectTables(all) {
  if (all.length <= MAX_TABLES) return trimToBudget(all);
  const keyOf = (t) => `${t.schema}.${t.table}`;
  const chosen = new Map();

  // 1) Importance: ~60% of the budget to the widest (richest) tables.
  const rich = Math.min(all.length, Math.floor(MAX_TABLES * 0.6));
  const byCols = [...all].sort((a, b) => b.columns.length - a.columns.length);
  for (let i = 0; i < rich; i++) chosen.set(keyOf(byCols[i]), byCols[i]);

  // 2) Breadth: stratified sample across the remaining tables (still name-sorted).
  const remaining = all.filter((t) => !chosen.has(keyOf(t)));
  const need = MAX_TABLES - chosen.size;
  if (need > 0 && remaining.length) {
    const step = remaining.length / need;
    for (let i = 0; i < need; i++) {
      const t = remaining[Math.floor(i * step)];
      if (t) chosen.set(keyOf(t), t);
    }
  }
  return trimToBudget([...chosen.values()]);
}

// Ensure the response stays under the Lambda sync-invoke byte cap.
function trimToBudget(tables) {
  let out = tables;
  while (out.length && Buffer.byteLength(JSON.stringify({ ok: true, tables: out }), "utf8") > MAX_RESPONSE_BYTES) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return out;
}

async function discoverPostgres(c, schemas) {
  const client = new pg.Client({
    host: c.host, port: Number(c.port) || 5432, user: c.user, password: c.password, database: c.database,
    ssl: c.ssl === false ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000, statement_timeout: 60000,
    options: "-c default_transaction_read_only=on",
  });
  await client.connect();
  try {
    // Empty schemas = discover everything (exclude Postgres system schemas).
    const filter = schemas.length
      ? { clause: "table_schema = ANY($1::text[])", args: [schemas] }
      : { clause: "table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_%'", args: [] };
    const { rows } = await client.query(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE ${filter.clause}
        ORDER BY table_schema, table_name, ordinal_position`,
      filter.args,
    );
    return groupAll(rows.map((r) => ({ schema: r.table_schema, table: r.table_name, column: r.column_name, type: r.data_type, nullable: r.is_nullable === "YES" })));
  } finally { await client.end().catch(() => {}); }
}

async function discoverSqlServer(c, schemas) {
  const config = {
    server: c.host, database: c.database, user: c.user, password: c.password,
    options: { instanceName: c.instance || undefined, encrypt: false, trustServerCertificate: true, enableArithAbort: true },
    // Named instances behind the VPN pay SQL Browser discovery; give it room.
    connectionTimeout: 45000, requestTimeout: 90000,
    ...(c.instance ? {} : { port: Number(c.port) || 1433 }),
  };
  const pool = await new sql.ConnectionPool(config).connect();
  try {
    const req = pool.request();
    // Empty schemas = discover everything (exclude SQL Server system schemas).
    let whereClause;
    if (schemas.length) {
      whereClause = "TABLE_SCHEMA IN (" + schemas.map((s, i) => { req.input(`s${i}`, s); return `@s${i}`; }).join(", ") + ")";
    } else {
      whereClause = "TABLE_SCHEMA NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin','db_securityadmin','db_ddladmin','db_backupoperator','db_datareader','db_datawriter','db_denydatareader','db_denydatawriter')";
    }
    const result = await req.query(
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE ${whereClause}
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
    );
    return groupAll(result.recordset.map((r) => ({ schema: r.TABLE_SCHEMA, table: r.TABLE_NAME, column: r.COLUMN_NAME, type: r.DATA_TYPE, nullable: r.IS_NULLABLE === "YES" })));
  } finally { await pool.close().catch(() => {}); }
}

export const handler = async (event) => {
  try {
    const { secretArn, engine, schemas } = event || {};
    if (!secretArn) return { ok: false, error: "secretArn is required" };
    const schemaList = Array.isArray(schemas) ? schemas : []; // empty = discover everything
    const creds = await readSecret(secretArn);
    const all = engine === "sqlserver" ? await discoverSqlServer(creds, schemaList) : await discoverPostgres(creds, schemaList);
    const tables = selectTables(all);
    return { ok: true, tables, discovered: all.length, returned: tables.length, truncated: tables.length < all.length };
  } catch (e) {
    // Surface a safe message (no creds); the caller logs/stores it.
    return { ok: false, error: e?.message ? String(e.message).slice(0, 400) : "discovery failed" };
  }
};
