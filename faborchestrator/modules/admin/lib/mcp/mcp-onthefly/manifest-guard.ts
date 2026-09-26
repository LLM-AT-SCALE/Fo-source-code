/**
 * On-the-Fly MCP — static safety check for a GENERATED manifest, run BEFORE deploy.
 *
 * This is the control-plane mirror of the runtime guard in
 * `mcp-onthefly/runtime/guard.mjs` (which enforces the SAME rules again at query
 * time — defense in depth). Keep the two in sync. The LLM only ever produces the
 * manifest (data); this gate rejects anything that isn't a single, allow-listed,
 * read-only SELECT with named params — so no unsafe query can reach deployment.
 */
import { ManifestSchema, type Manifest, type ManifestTool, type StaticCheckResult } from './types';

// Write/DDL deny-list — identical to the runtime guard.
const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|MERGE|CALL|COPY|VACUUM|REINDEX|COMMENT|SET|RESET|BEGIN|COMMIT|ROLLBACK|LOCK|DO)\b/i;

const PARAM_RE = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** True if the SQL is a single read-only SELECT/WITH with no write/DDL. */
export function checkSql(sql: string): string | null {
  const trimmed = String(sql).trim().replace(/;\s*$/, '');
  if (/;/.test(trimmed)) return 'multiple statements are not allowed';
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) return 'only SELECT/WITH queries are allowed';
  if (FORBIDDEN.test(trimmed)) return 'query contains a forbidden (write/DDL) keyword';
  return null;
}

/** Every :param in the SQL must be declared in the tool's inputSchema.properties. */
function checkParams(tool: ManifestTool): string | null {
  const declared = new Set(Object.keys(tool.inputSchema.properties || {}));
  const used = new Set<string>();
  let m: RegExpExecArray | null;
  PARAM_RE.lastIndex = 0;
  while ((m = PARAM_RE.exec(tool.sql)) !== null) used.add(m[1]);
  for (const p of used) {
    if (!declared.has(p)) return `tool "${tool.name}": SQL uses :${p} not declared in inputSchema`;
  }
  return null;
}

/**
 * Validate a manifest object (already JSON-parsed). Returns a structured result;
 * callers must refuse to deploy unless `ok`.
 */
export function staticCheckManifest(raw: unknown): { result: StaticCheckResult; manifest: Manifest | null } {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      result: { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), toolCount: 0 },
      manifest: null,
    };
  }
  const manifest = parsed.data;
  const errors: string[] = [];
  const names = new Set<string>();
  for (const tool of manifest.tools) {
    if (names.has(tool.name)) errors.push(`duplicate tool name: ${tool.name}`);
    names.add(tool.name);
    const sqlErr = checkSql(tool.sql);
    if (sqlErr) errors.push(`tool "${tool.name}": ${sqlErr}`);
    const paramErr = checkParams(tool);
    if (paramErr) errors.push(paramErr);
  }
  return {
    result: { ok: errors.length === 0, errors, toolCount: manifest.tools.length },
    manifest: errors.length === 0 ? manifest : null,
  };
}
