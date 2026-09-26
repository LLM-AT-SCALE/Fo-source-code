"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminPage, AdminToolbar, AdminSearch } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { RoleCard } from "@/modules/admin/components/role-card";
import { RoleFormModal } from "@/modules/admin/components/role-form-modal";
import { Button } from "@/shared/components/ui/button";
import { toast } from "sonner";
import { useConfirm } from "@/shared/components/ui/confirm-dialog";
import { Plus, ShieldCheck } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RoleData = any;

/** 1 column on phones, 2 from md, 3 from xl; every card stretches to the row height. */
const GRID = "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3";

export default function RolesPage() {
  const [roles, setRoles] = useState<RoleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const filtered = roles.filter(item => [item.name, item.description].filter(Boolean).join(" ").toLowerCase().includes(search.trim().toLowerCase()));
  const [showForm, setShowForm] = useState(false);
  const [editRole, setEditRole] = useState<RoleData | null>(null);
  const confirm = useConfirm();

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const fetchRoles = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/roles", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setRoles(data.roles || []);
    } catch {
      toast.error("Failed to load roles");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchRoles(); }, [fetchRoles]);

  const handleDelete = async (roleId: string) => {
    if (!token) return;
    const ok = await confirm({
      title: "Delete this role?",
      description: "This permanently removes the role. A role that still has users assigned cannot be deleted — reassign them first.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;

    try {
      const res = await fetch(`/api/admin/roles/${roleId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete role");
        return;
      }
      toast.success("Role deleted");
      fetchRoles();
    } catch {
      toast.error("Failed to delete role");
    }
  };

  const countText = loading
    ? "Loading…"
    : search
      ? `${filtered.length} of ${roles.length} ${roles.length === 1 ? "role" : "roles"}`
      : `${roles.length} ${roles.length === 1 ? "role" : "roles"}`;

  return (
    <AdminPage className="admin-workspace-collection">
      <AdminPageHeader section="People" title="Roles" description="Define access levels, model permissions, and usage limits">
        <Button onClick={() => { setEditRole(null); setShowForm(true); }} className="bg-primary">
          <Plus className="mr-2 h-4 w-4" /> Create Role
        </Button>
      </AdminPageHeader>

      <AdminToolbar label="Find roles" className="mt-6">
        <AdminSearch value={search} onChange={setSearch} placeholder="Search roles..." />
        {search && <Button variant="ghost" size="sm" onClick={() => setSearch("")}>Clear search</Button>}
        <span className="text-sm tabular-nums text-muted-foreground sm:ml-auto" aria-live="polite">{countText}</span>
      </AdminToolbar>

      <div className="mt-4 min-w-0">
        {loading ? (
          <div className={GRID} aria-busy="true" aria-label="Loading roles">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-56 animate-pulse rounded-xl border bg-muted" />
            ))}
          </div>
        ) : filtered.length === 0 && search ? (
          <div className="rounded-xl border bg-card px-6 py-16 text-center">
            <h2 className="text-base font-semibold">No matches found</h2>
            <p className="mt-2 text-sm text-muted-foreground">Try another name or clear your search.</p>
            <Button variant="outline" className="mt-4" onClick={() => setSearch("")}>Clear search</Button>
          </div>
        ) : roles.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-16 text-center">
            <ShieldCheck className="h-12 w-12 text-muted-foreground/40" aria-hidden="true" />
            <div>
              <h2 className="text-lg font-medium">No roles yet</h2>
              <p className="mt-1 text-sm text-muted-foreground">Create a role to define model access and usage limits.</p>
            </div>
            <Button onClick={() => { setEditRole(null); setShowForm(true); }} className="mt-1 bg-primary">
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Create Role
            </Button>
          </div>
        ) : (
          <div className={GRID}>
            {filtered.map((role) => (
              <RoleCard
                key={role.id}
                role={role}
                onEdit={() => { setEditRole(role); setShowForm(true); }}
                onDelete={() => handleDelete(role.id)}
              />
            ))}
          </div>
        )}
      </div>

      <RoleFormModal
        open={showForm}
        onClose={() => { setShowForm(false); setEditRole(null); }}
        onSaved={() => { setShowForm(false); setEditRole(null); fetchRoles(); }}
        editRole={editRole}
      />
    </AdminPage>
  );
}
