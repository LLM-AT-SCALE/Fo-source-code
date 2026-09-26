// =============================================================================
// Read-only SQL guard + named-param binding — PURE, no I/O, no deps.
// Extracted so it can be unit-tested without pg / aws-sdk installed, and so the
// security-critical logic lives in one small, reviewable file.
// =============================================================================

// JSON-RPC error codes (aligned with faborchestrator/lib/mcp-client.ts mapping).
export const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

export function rpcError(code, message) {
  const e = new Error(message);
  e.rpcCode = code;
  return e;
}

// Write/DDL deny-list — defense in depth on top of the SELECT/WITH allow-check.
export const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|MERGE|CALL|COPY|VACUUM|REINDEX|COMMENT|SET|RESET|BEGIN|COMMIT|ROLLBACK|LOCK|DO)\b/i;

// Reject anything that is not a single read-only SELECT/WITH statement.
export function assertReadOnly(sql) {
  const trimmed = String(sql).trim().replace(/;\s*$/, ""); // allow a single trailing ;
  if (/;/.test(trimmed)) throw rpcError(RPC.INVALID_PARAMS, "Multiple statements are not allowed");
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) throw rpcError(RPC.INVALID_PARAMS, "Only SELECT/WITH queries are allowed");
  if (FORBIDDEN.test(trimmed)) throw rpcError(RPC.INVALID_PARAMS, "Query contains a forbidden (write/DDL) keyword");
  return trimmed;
}

// Convert ":name" placeholders to positional $1.. and build the values array,
// pulling ONLY from the allow-listed input properties. No string concatenation.
export function bindNamedParams(sql, args, allowedKeys) {
  const order = [];
  const bound = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
    if (!allowedKeys.includes(name)) throw rpcError(RPC.INVALID_PARAMS, `Unknown parameter :${name}`);
    let idx = order.indexOf(name);
    if (idx === -1) {
      order.push(name);
      idx = order.length - 1;
    }
    return `$${idx + 1}`;
  });
  // Missing params bind as NULL (optional filters are written as ":p IS NULL OR ...").
  // Truly-required params are enforced by the caller's input schema before we get here.
  const values = order.map((name) => (args && name in args ? args[name] : null));
  return { bound, values };
}

// Append a LIMIT if the query has none (belt-and-suspenders with the JS row cap).
export function enforceLimit(sql, rowCap) {
  return /\blimit\b/i.test(sql) ? sql : `${sql}\nLIMIT ${rowCap}`;
}
