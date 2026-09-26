// =============================================================================
// On-the-Fly MCP Runtime — SQL SERVER variant (mssql). Fixed, reviewed shell.
//
// Same MCP-over-HTTP protocol as the Postgres runtime (initialize / tools/list /
// tools/call, Bearer, Mcp-Session-Id). Deployed into the CMF VPC so it can reach
// on-prem SQL Server (e.g. Opcenter/CAMSTAR MES at 10.10.1.x) over the Site-to-Site
// VPN. Connects to a NAMED instance via SQL Browser (UDP 1434) + dynamic port,
// reusing the proven config from faborchestrator/lib/cmf/cmf-sql.ts.
//
// Read-only: the guard rejects non-SELECT/DDL/exec/sproc; use a READ-ONLY SQL
// login for the target. Row + output + request-timeout caps bound cost.
// =============================================================================

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import sql from "mssql";
import { randomUUID } from "node:crypto";
import { RPC, rpcError, assertReadOnly, bindNamedParams } from "./guard.mjs";

const REGION = process.env.AWS_REGION || "us-west-2";
const SECRET_ARN = process.env.SECRET_ARN;
const BEARER = process.env.MCP_BEARER_TOKEN;
const ROW_CAP = clampInt(process.env.MAX_ROWS, 1000, 1, 10000);
const OUTPUT_BYTE_CAP = clampInt(process.env.MAX_OUTPUT_BYTES, 1_000_000, 1024, 5_000_000);
// Named instance behind a VPN pays SQL Browser discovery + a dynamic-port handshake;
// these are the proven timeouts from the CMF SQL client — do not shorten.
const CONNECT_TIMEOUT_MS = clampInt(process.env.CMF_SQL_CONNECT_TIMEOUT_MS, 20000, 5000, 60000);
const REQUEST_TIMEOUT_MS = clampInt(process.env.CMF_SQL_REQUEST_TIMEOUT_MS, 30000, 5000, 60000);
const PROTOCOL_VERSION = "2024-11-05";

let _sm = null, _secretCache = null, _poolPromise = null, _manifest = null;
const sm = () => (_sm ??= new SecretsManagerClient({ region: REGION }));

function clampInt(v, dflt, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt;
}

async function loadManifest() {
  if (_manifest) return _manifest;
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("./manifest.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.tools)) throw new Error("manifest.json missing tools[]");
  return (_manifest = parsed);
}

async function getSecret() {
  if (_secretCache) return _secretCache;
  if (!SECRET_ARN) throw new Error("SECRET_ARN is not configured");
  const res = await sm().send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  if (!res.SecretString) throw new Error("target secret has no SecretString");
  const s = JSON.parse(res.SecretString);
  if (!s.host || !s.user || !s.password || !s.database) throw new Error("secret missing host/user/password/database");
  return (_secretCache = s);
}

async function getPool() {
  if (_poolPromise) return _poolPromise;
  const s = await getSecret();
  const config = {
    server: s.host,
    database: s.database,
    user: s.user,
    password: s.password,
    options: {
      instanceName: s.instance || undefined, // named instance via SQL Browser (UDP 1434)
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    ...(s.instance ? {} : { port: Number(s.port) || 1433 }),
  };
  _poolPromise = new sql.ConnectionPool(config).connect().catch((err) => { _poolPromise = null; throw err; });
  return _poolPromise;
}

async function runTool(tool, args) {
  const allowedKeys = Object.keys(tool.inputSchema?.properties || {});
  const safeSql = assertReadOnly(tool.sql); // T-SQL row cap comes from the tool's TOP(n) + JS slice below
  const { text, params } = bindNamedParams(safeSql, args, allowedKeys);
  const pool = await getPool();
  const req = pool.request();
  for (const p of params) req.input(p.name, p.value);
  const result = await req.query(text);
  let rows = (result.recordset || []).slice(0, ROW_CAP);
  const capped = (result.recordset || []).length > ROW_CAP;
  const columns = result.recordset?.columns ? Object.keys(result.recordset.columns) : (rows[0] ? Object.keys(rows[0]) : []);
  let outText = JSON.stringify({ columns, rowCount: rows.length, capped, rows });
  while (rows.length && Buffer.byteLength(outText, "utf8") > OUTPUT_BYTE_CAP) {
    rows = rows.slice(0, Math.floor(rows.length / 2));
    outText = JSON.stringify({ columns, rowCount: rows.length, capped: true, note: "output truncated to byte cap", rows });
  }
  return { content: [{ type: "text", text: outText }] };
}

// ── built-in health_check ──
// Proves the database answers: SELECT 1, then TOP (1) from the first table the
// manifest's first SQL reads (read-only guard + requestTimeout still apply).
const HEALTH_TOOL = {
  name: "health_check",
  description: "Connectivity check: opens the database connection and reads one row from the first table in the manifest.",
  inputSchema: { type: "object", properties: {} },
};
// First "FROM <ident>" of a query, kept only when it is a plain (optionally
// schema-qualified, optionally [bracketed]) identifier — never interpolated otherwise.
function firstTableIn(sql) {
  const m = /\bFROM\s+((?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)){0,2})/i.exec(String(sql || ""));
  return m ? m[1] : null;
}
async function healthCheck(manifest) {
  const started = Date.now();
  const pool = await getPool();
  await pool.request().query("SELECT 1 AS ok");
  const first = manifest.tools.find((t) => typeof t.sql === "string" && t.sql.trim());
  // A WITH query names CTEs first, which are not tables — only a plain SELECT is mined for one.
  const table = first && /^\s*SELECT\b/i.test(first.sql) ? firstTableIn(first.sql) : null;
  if (table) await pool.request().query(assertReadOnly(`SELECT TOP (1) * FROM ${table}`));
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, db: "mssql", ms: Date.now() - started, table }) }] };
}

async function handleRpc(body) {
  const { id, method, params } = body;
  switch (method) {
    case "initialize":
      return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "mcp-onthefly-runtime-mssql", version: "0.1.0" } });
    case "notifications/initialized":
      return null;
    case "tools/list": {
      const manifest = await loadManifest();
      const tools = manifest.tools.map((t) => ({ name: t.name, description: t.description || `Read-only query: ${t.name}`, inputSchema: t.inputSchema || { type: "object", properties: {} } }));
      tools.push(HEALTH_TOOL);
      return ok(id, { tools });
    }
    case "tools/call": {
      const manifest = await loadManifest();
      if (params?.name === HEALTH_TOOL.name) {
        try {
          return ok(id, await healthCheck(manifest));
        } catch (err) {
          // The driver's own message: a health check exists to say WHY the database is not answering.
          throw rpcError(RPC.INTERNAL, `health_check failed: ${err?.message || String(err)}`);
        }
      }
      const tool = manifest.tools.find((t) => t.name === params?.name);
      if (!tool) throw rpcError(RPC.METHOD_NOT_FOUND, `Unknown tool: ${params?.name}`);
      return ok(id, await runTool(tool, params?.arguments || {}));
    }
    default:
      throw rpcError(RPC.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

const ok = (id, result) => ({ jsonrpc: "2.0", id: id ?? null, result });
const errResponse = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const lowerKeys = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [String(k).toLowerCase(), v]));

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "POST";
  const headers = lowerKeys(event?.headers || {});
  const respHeaders = { "content-type": "application/json" };

  if (method === "GET") return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ status: "ok", server: "mcp-onthefly-runtime-mssql" }) };
  if (method !== "POST") return { statusCode: 405, headers: respHeaders, body: JSON.stringify({ error: "method not allowed" }) };

  if (!BEARER || (headers["authorization"] || "") !== `Bearer ${BEARER}`) {
    return { statusCode: 401, headers: respHeaders, body: JSON.stringify(errResponse(null, RPC.INVALID_REQUEST, "unauthorized")) };
  }

  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
    body = JSON.parse(raw);
  } catch {
    return { statusCode: 400, headers: respHeaders, body: JSON.stringify(errResponse(null, RPC.PARSE, "invalid JSON")) };
  }

  respHeaders["mcp-session-id"] = headers["mcp-session-id"] || randomUUID();
  try {
    const result = await handleRpc(body);
    if (result === null) return { statusCode: 202, headers: respHeaders, body: "" };
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify(result) };
  } catch (err) {
    const code = err?.rpcCode || RPC.INTERNAL;
    const safeMsg = err?.rpcCode ? err.message : "internal error executing query";
    console.error(JSON.stringify({ level: "error", msg: err?.message, code }));
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify(errResponse(body?.id, code, safeMsg)) };
  }
};
