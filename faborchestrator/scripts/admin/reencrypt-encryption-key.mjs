// =============================================================================
// One-time KEY_ENCRYPTION_SECRET convergence migration.
//
// PROBLEM: the admin app and FabOrchestrator (FO) currently run with DIFFERENT
// KEY_ENCRYPTION_SECRET values, but they share ONE database. Every credential is
// stored as AES-256-GCM `iv:authTag:ciphertext`. If we just set both apps to the
// same key, every value that was encrypted under the *other* key becomes
// permanently undecryptable (GCM auth-tag failure), silently isolating existing
// functionality (users' saved Anthropic keys, personal/OAuth MCPs, catalog
// connectors, on-the-fly bearers).
//
// FIX: BEFORE flipping the envs, re-encrypt every existing value under ONE
// canonical key. This script decrypts each value with whichever candidate key
// actually wrote it (try-all-keys — GCM makes a wrong key fail cleanly, so this
// is unambiguous) and re-encrypts it under the chosen NEW key. It is idempotent
// and DRY-RUN by default (prints a plan; writes nothing until you pass --apply).
//
// The four encrypted columns in the shared DB (the complete set — verified):
//   users.anthropic_api_key_encrypted            (written by FO)
//   mcp_connections.auth_credentials_encrypted   (written by FO + admin)
//   mcp_registry.auth_credentials_encrypted      (written by admin)
//   mcp_data_sources.endpoint_auth_encrypted     (written by admin)
//
// It does NOT touch passwords (scrypt) or session/reset tokens (random) — those
// do not use KEY_ENCRYPTION_SECRET.
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//   cd faborchestrator
//   # Provide the canonical NEW key and ALL candidate OLD keys (comma-separated).
//   # Recommended NEW key = FO's current key (it protects the most user data).
//   export REENCRYPT_NEW_KEY=<64-hex canonical key>
//   export REENCRYPT_OLD_KEYS=<64-hex admin key>,<64-hex FO key>   # any it might be under
//
//   node scripts/reencrypt-encryption-key.mjs            # DRY RUN (default) — plan only
//   node scripts/reencrypt-encryption-key.mjs --apply    # actually re-encrypt + write
//
// After a clean --apply run, set BOTH apps' KEY_ENCRYPTION_SECRET = REENCRYPT_NEW_KEY
// and redeploy/restart. Re-running the script is safe (everything then decrypts
// under NEW and is reported "already-aligned", zero writes).
//
// DB reachability is the same as apply-mcp-otf-migration.mjs: run inside the VPC,
// or temporarily authorize your IP on the RDS SG (revoke after). DATABASE_URL is
// read from faborchestrator/.env. Secrets/plaintext are NEVER printed.
// =============================================================================
import { readFileSync } from "node:fs";
import { promises as dns } from "node:dns";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";
import pg from "pg";

// ── crypto: byte-for-byte identical to shared/lib/encryption.ts ──
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function keyBuf(hex) {
  if (typeof hex !== "string" || hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("key must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

function encryptWith(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let enc = cipher.update(plaintext, "utf8", "hex");
  enc += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc}`;
}

// Returns the plaintext, or throws (wrong key / malformed) — caller tries next key.
function decryptWith(text, key) {
  const parts = String(text).split(":");
  if (parts.length !== 3) throw new Error("not iv:tag:ciphertext");
  const iv = Buffer.from(parts[0], "hex");
  const tag = Buffer.from(parts[1], "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let dec = decipher.update(parts[2], "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

// ── inputs ───────────────────────────────────────────────────────────────────
const APPLY = process.argv.includes("--apply");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const newHex = (process.env.REENCRYPT_NEW_KEY || "").trim();
const oldHexes = (process.env.REENCRYPT_OLD_KEYS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!newHex) { console.error("Set REENCRYPT_NEW_KEY (the 64-hex canonical key)."); process.exit(2); }
let NEW_KEY, OLD_KEYS;
try {
  NEW_KEY = keyBuf(newHex);
  // Candidate set = NEW first (so already-aligned rows are detected + skipped),
  // then every distinct OLD key. De-dupe by hex so NEW isn't tried twice.
  const seen = new Set([newHex.toLowerCase()]);
  OLD_KEYS = [];
  for (const h of oldHexes) {
    const lk = h.toLowerCase();
    if (seen.has(lk)) continue;
    seen.add(lk);
    OLD_KEYS.push(keyBuf(h));
  }
} catch (e) { console.error(`Invalid key: ${e.message}`); process.exit(2); }

if (OLD_KEYS.length === 0) {
  console.warn("⚠ REENCRYPT_OLD_KEYS is empty/only equals NEW — the script can only");
  console.warn("  verify NEW-key alignment; it cannot rescue values under a different key.");
}

// NEW first, then the old candidates.
const CANDIDATES = [{ label: "NEW", key: NEW_KEY }, ...OLD_KEYS.map((k, i) => ({ label: `OLD#${i + 1}`, key: k }))];

// The complete set of encrypted columns in the shared DB.
const TARGETS = [
  { table: "users",            col: "anthropic_api_key_encrypted", who: "FO" },
  { table: "mcp_connections",  col: "auth_credentials_encrypted",  who: "FO+admin" },
  { table: "mcp_registry",     col: "auth_credentials_encrypted",  who: "admin" },
  { table: "mcp_data_sources", col: "endpoint_auth_encrypted",     who: "admin" },
];

// ── DB connection (mirrors apply-mcp-otf-migration.mjs) ──────────────────────
const env = readFileSync(join(root, ".env"), "utf8");
const m = env.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
if (!m) { console.error("No uncommented DATABASE_URL in faborchestrator/.env"); process.exit(2); }
const url = new URL(m[1]);
const { address: host } = await dns.lookup(url.hostname, { family: 4 });
console.log(`DB: ${url.hostname} -> ${host} | user: ${url.username} | db: ${url.pathname.slice(1)}`);
console.log(`Mode: ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"} | candidate keys: ${CANDIDATES.map((c) => c.label).join(", ")}\n`);

const client = new pg.Client({
  host, port: Number(url.port || 5432),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  database: url.pathname.slice(1), ssl: false, connectionTimeoutMillis: 12000,
});
await client.connect();

// ── migrate ──────────────────────────────────────────────────────────────────
let grandFailures = 0;
try {
  if (APPLY) await client.query("BEGIN");

  for (const t of TARGETS) {
    // Skip cleanly if a table/column doesn't exist in this DB.
    const exists = await client.query(
      "select 1 from information_schema.columns where table_name=$1 and column_name=$2 limit 1",
      [t.table, t.col],
    );
    if (exists.rowCount === 0) { console.log(`• ${t.table}.${t.col} — column absent, skipped`); continue; }

    const { rows } = await client.query(
      `SELECT id, "${t.col}" AS val FROM "${t.table}" WHERE "${t.col}" IS NOT NULL AND "${t.col}" <> ''`,
    );

    let aligned = 0, reenc = 0, failed = 0;
    const failedIds = [];
    for (const r of rows) {
      // Find the key that wrote this value (NEW first).
      let hit = null;
      for (const c of CANDIDATES) {
        try { const plain = decryptWith(r.val, c.key); hit = { label: c.label, plain }; break; }
        catch { /* try next candidate */ }
      }
      if (!hit) { failed++; failedIds.push(r.id); continue; }
      if (hit.label === "NEW") { aligned++; continue; } // already under the canonical key

      // Re-encrypt the recovered plaintext under NEW and write it back.
      const updated = encryptWith(hit.plain, NEW_KEY);
      if (APPLY) {
        await client.query(`UPDATE "${t.table}" SET "${t.col}" = $1 WHERE id = $2`, [updated, r.id]);
      }
      reenc++;
    }

    grandFailures += failed;
    const verb = APPLY ? "re-encrypted" : "would re-encrypt";
    console.log(
      `• ${t.table}.${t.col} (${t.who}): ${rows.length} rows | already-aligned ${aligned} | ${verb} ${reenc} | UNRECOVERABLE ${failed}`,
    );
    if (failed) console.log(`    ↳ could not decrypt with ANY provided key (ids): ${failedIds.join(", ")}`);
  }

  if (APPLY) {
    if (grandFailures > 0) {
      // Any unrecoverable row means a key is missing from REENCRYPT_OLD_KEYS — do
      // NOT commit a partial, ambiguous migration. Roll back and let the operator
      // supply the missing key.
      await client.query("ROLLBACK");
      console.log(`\n✗ ${grandFailures} value(s) could not be decrypted with the provided keys — ROLLED BACK.`);
      console.log("  Add the missing old key to REENCRYPT_OLD_KEYS and re-run.");
    } else {
      await client.query("COMMIT");
      console.log("\n✓ COMMIT — all values now encrypted under the NEW key.");
      console.log("  Next: set KEY_ENCRYPTION_SECRET=<NEW key> on BOTH EB envs, then redeploy/restart.");
    }
  } else {
    console.log(`\nDRY RUN complete.${grandFailures ? ` ⚠ ${grandFailures} value(s) match NONE of the provided keys — add the missing old key before --apply.` : " No unrecoverable values — safe to --apply."}`);
  }
} catch (e) {
  if (APPLY) { try { await client.query("ROLLBACK"); } catch { /* ignore */ } }
  console.error("ERROR:", e?.message || e);
  process.exitCode = 1;
} finally {
  await client.end();
}

if (grandFailures > 0) process.exitCode = 1;
