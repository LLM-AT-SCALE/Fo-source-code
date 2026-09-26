// =============================================================================
// Read-only T-SQL guard + named-param binding for the SQL Server runtime. Pure.
// Mirrors runtime/guard.mjs but with a T-SQL deny-list and mssql (@name) params.
// =============================================================================

export const RPC = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602, INTERNAL: -32603,
};

export function rpcError(code, message) {
  const e = new Error(message);
  e.rpcCode = code;
  return e;
}

// Write/DDL/exec deny-list — T-SQL flavored (adds EXEC/sp_/xp_/BULK/WAITFOR/DBCC/…).
export const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|DENY|MERGE|EXEC|EXECUTE|BULK|WAITFOR|SHUTDOWN|DBCC|BACKUP|RESTORE|KILL|RECONFIGURE|OPENROWSET|OPENQUERY|OPENDATASOURCE|INTO|SET)\b/i;
const SPROC = /\b(sp_|xp_)\w+/i;

// Reject anything that is not a single read-only SELECT/WITH statement.
export function assertReadOnly(sql) {
  const trimmed = String(sql).trim().replace(/;\s*$/, "");
  if (/;/.test(trimmed)) throw rpcError(RPC.INVALID_PARAMS, "Multiple statements are not allowed");
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) throw rpcError(RPC.INVALID_PARAMS, "Only SELECT/WITH queries are allowed");
  if (FORBIDDEN.test(trimmed)) throw rpcError(RPC.INVALID_PARAMS, "Query contains a forbidden (write/DDL/exec) keyword");
  if (SPROC.test(trimmed)) throw rpcError(RPC.INVALID_PARAMS, "Stored-procedure calls are not allowed");
  return trimmed;
}

// Convert ":name" placeholders to mssql "@name" and collect the params to bind
// via request.input(). Pulls ONLY from the allow-listed input properties.
export function bindNamedParams(sql, args, allowedKeys) {
  const used = new Set();
  const text = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
    if (!allowedKeys.includes(name)) throw rpcError(RPC.INVALID_PARAMS, `Unknown parameter :${name}`);
    used.add(name);
    return `@${name}`;
  });
  // Missing params bind as NULL (optional filters are written as ":p IS NULL OR ...").
  // Truly-required params are enforced by the caller's input schema before we get here.
  const params = [...used].map((name) => ({ name, value: args && name in args ? args[name] : null }));
  return { text, params };
}
