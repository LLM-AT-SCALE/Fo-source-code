"use client";

import { useEffect, useState } from "react";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { Input } from "@/shared/components/ui/input";
import { Loader2, X } from "lucide-react";

export type VisibilityValue = { visibleToAll: boolean; roleIds: string[]; userIds: string[] };

type Role = { id: string; name: string };
type UserLite = { id: string; name: string | null; email: string | null };

/**
 * Who can see a dashboard: everyone, a set of roles, and/or specific users.
 * The requester is always included (shown as a locked chip).
 */
export function VisibilityPicker({
  value,
  onChange,
  token,
  requester,
  disabled = false,
}: {
  value: VisibilityValue;
  onChange: (v: VisibilityValue) => void;
  token: string | null;
  requester?: UserLite | null;
  disabled?: boolean;
}) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loadingRoles, setLoadingRoles] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserLite[]>([]);
  const [searching, setSearching] = useState(false);
  const [known, setKnown] = useState<Map<string, UserLite>>(new Map());

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/admin/roles", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { roles?: Role[] } | null) => {
        if (!cancelled) setRoles((j?.roles ?? []).map((r) => ({ id: r.id, name: r.name })));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingRoles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Debounced user search.
  useEffect(() => {
    if (!token) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`/api/admin/users?search=${encodeURIComponent(q)}&pageSize=10`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { users?: UserLite[] } | null) => {
          if (cancelled) return;
          const users = (j?.users ?? []).map((u) => ({ id: u.id, name: u.name, email: u.email }));
          setResults(users);
          setKnown((prev) => {
            const next = new Map(prev);
            for (const u of users) next.set(u.id, u);
            return next;
          });
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, token]);

  const toggleRole = (id: string) =>
    onChange({ ...value, roleIds: value.roleIds.includes(id) ? value.roleIds.filter((x) => x !== id) : [...value.roleIds, id] });
  const addUser = (u: UserLite) => {
    if (u.id === requester?.id || value.userIds.includes(u.id)) return;
    onChange({ ...value, userIds: [...value.userIds, u.id] });
    setQuery("");
    setResults([]);
  };
  const removeUser = (id: string) => onChange({ ...value, userIds: value.userIds.filter((x) => x !== id) });
  const labelOf = (id: string) => {
    const u = known.get(id);
    return u ? u.name || u.email || id.slice(0, 8) : id.slice(0, 8);
  };

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={value.visibleToAll} disabled={disabled} onCheckedChange={(v) => onChange({ ...value, visibleToAll: !!v })} />
        <span className="font-medium">Everyone</span>
        <span className="text-xs text-muted-foreground">(all users can open it)</span>
      </label>

      <div className={value.visibleToAll ? "opacity-50" : ""}>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Roles</p>
        <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-md border p-3">
          {loadingRoles ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : roles.length === 0 ? (
            <p className="text-xs text-muted-foreground">No roles found.</p>
          ) : (
            roles.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={value.roleIds.includes(r.id)} disabled={disabled || value.visibleToAll} onCheckedChange={() => toggleRole(r.id)} />
                <span>{r.name}</span>
              </label>
            ))
          )}
        </div>
      </div>

      <div className={value.visibleToAll ? "opacity-50" : ""}>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Specific users</p>
        <div className="flex flex-wrap gap-1.5">
          {requester && (
            <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-0.5 text-xs" title="The requester always has access">
              {requester.name || requester.email}
              <span className="text-[10px] text-muted-foreground">requester</span>
            </span>
          )}
          {value.userIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs">
              {labelOf(id)}
              {!disabled && !value.visibleToAll && (
                <button type="button" onClick={() => removeUser(id)} aria-label="Remove user" className="text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
        <div className="relative mt-2">
          <Input
            value={query}
            disabled={disabled || value.visibleToAll}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search users by name or email…"
            className="h-9"
          />
          {searching && <Loader2 className="absolute right-2 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />}
          {results.length > 0 && (
            <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md">
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => addUser(u)}
                    className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-accent"
                  >
                    <span>{u.name || u.email}</span>
                    {u.name && <span className="text-xs text-muted-foreground">{u.email}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
