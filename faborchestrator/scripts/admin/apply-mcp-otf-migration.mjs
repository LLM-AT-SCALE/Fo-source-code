// Apply the additive on-the-fly MCP migration (create mcp_data_sources) to the
// database in faborchestrator/.env. Additive + idempotent — safe to re-run.
//
//   cd faborchestrator && node scripts/admin/apply-mcp-otf-migration.mjs
//
// The DB (RDS athena-poc-db) is firewalled to the app security groups, so run
// this from inside the VPC, OR temporarily authorize your IP on sg-0af6fdeed5a3882f2
// port 5432 first and revoke after (see the commands the assistant provided).
import { readFileSync } from "node:fs";
import { promises as dns } from "node:dns";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = readFileSync(join(root, ".env"), "utf8");

// Match the UNCOMMENTED DATABASE_URL line (skips "# DATABASE_URL=...localhost").
const m = env.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
if (!m) { console.error("No uncommented DATABASE_URL in .env"); process.exit(2); }
const url = new URL(m[1]);
if (["localhost", "127.0.0.1"].includes(url.hostname)) {
  console.error(`DATABASE_URL points to ${url.hostname} — set it to the RDS host.`); process.exit(3);
}

const sql = readFileSync(join(root, "prisma", "create_mcp_data_sources.sql"), "utf8");

// Use the OS resolver + IPv4 so the connection matches an IPv4 SG allow-rule
// (dns.resolve4 via c-ares is refused on some Windows setups).
const { address: host } = await dns.lookup(url.hostname, { family: 4 });
console.log(`host: ${url.hostname} -> ${host} | user: ${url.username} | db: ${url.pathname.slice(1)}`);

const client = new pg.Client({
  host, port: Number(url.port || 5432),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  database: url.pathname.slice(1), ssl: false, connectionTimeoutMillis: 12000,
});
await client.connect();
console.log("connected — applying create_mcp_data_sources.sql (additive, idempotent)");
await client.query(sql);
const r = await client.query(
  "select to_regclass('public.mcp_data_sources') as tbl, (select count(*)::int from information_schema.columns where table_name='mcp_data_sources') as cols",
);
console.log("RESULT: table =", r.rows[0].tbl, "| columns =", r.rows[0].cols);
await client.end();
