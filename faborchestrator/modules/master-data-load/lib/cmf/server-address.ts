/**
 * An admin often types the SQL Server the way SSMS shows it: "10.10.1.224/ONLINE"
 * or "10.10.1.224\ONLINE" (server + named instance), sometimes with ",1433".
 * Everything that uses the server needs the parts apart: the SQL driver wants
 * the host and the instance separately, and the portal login maps the portal's
 * hostname to the host (a mapping to "10.10.1.224/ONLINE" is not an address, so
 * the browser ignored it and fell back to public DNS: ERR_NAME_NOT_RESOLVED).
 */
export interface ServerAddress {
  host: string;
  instance?: string;
  port?: number;
}

export function splitServerAddress(raw: string | null | undefined): ServerAddress {
  let s = String(raw ?? "").trim();
  let port: number | undefined;
  const comma = s.match(/,\s*(\d{1,5})\s*$/);
  if (comma) {
    port = Number(comma[1]);
    s = s.slice(0, comma.index).trim();
  }
  const sep = s.search(/[\\/]/);
  if (sep < 0) return { host: s, ...(port ? { port } : {}) };
  const host = s.slice(0, sep).trim();
  const instance = s.slice(sep + 1).trim();
  return { host, ...(instance ? { instance } : {}), ...(port ? { port } : {}) };
}

/** The host part only — what a host→IP mapping may point at. */
export function serverHost(raw: string | null | undefined): string {
  return splitServerAddress(raw).host;
}

/** Clean [[host, ip], ...] pairs: drop an instance or port glued to the address, drop empties. */
export function cleanResolverPairs(raw: unknown): Array<[string, string]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[string, string]> = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
    const host = pair[0].trim();
    const ip = serverHost(pair[1]);
    if (host && ip) out.push([host, ip]);
  }
  return out;
}
