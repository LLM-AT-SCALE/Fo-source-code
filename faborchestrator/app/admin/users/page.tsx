"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { AdminPage, AdminCollectionHeader, AdminCollection, AdminToolbar } from "@/modules/admin/components/admin-page-patterns";
import { AdminPageHeader } from "@/modules/admin/components/admin-page-header";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Badge } from "@/shared/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { UserDetailPanel } from "@/modules/admin/components/user-detail-panel";
import { CreateUserDialog } from "@/modules/admin/components/create-user-dialog";
import { Plus, Search, Users as UsersIcon, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  isAdmin: boolean;
  role: { id: string; name: string } | null;
  createdAt: string;
  lastLogin: string | null;
  forcePasswordChange: boolean;
}

interface RoleMeta {
  id: string;
  name: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserRow | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [sortKey, setSortKey] = useState<"name" | "lastLogin">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const toggleSort = (key: "name" | "lastLogin") => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortedUsers = useMemo(() => {
    const arr = [...users];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") {
        cmp = (a.name || a.email).localeCompare(b.name || b.email);
      } else {
        const at = a.lastLogin ? new Date(a.lastLogin).getTime() : 0;
        const bt = b.lastLogin ? new Date(b.lastLogin).getTime() : 0;
        cmp = at - bt;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [users, sortKey, sortDir]);

  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null;

  const fetchUsers = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ meta: "true" });
      if (search) params.set("search", search);
      const res = await fetch(`/api/admin/users?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setUsers(data.users || []);
      if (data.meta?.roles) setRoles(data.meta.roles);
    } catch {
      toast.error("Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [token, search]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleAction = async (userId: string, action: string, extra?: Record<string, string>) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Action failed");
        return;
      }
      toast.success(`User ${action} successful`);
      fetchUsers();
      setSelectedUser(null);
    } catch {
      toast.error("Action failed");
    }
  };

  const handleDelete = async (userId: string) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Delete failed");
        return;
      }
      toast.success("User deleted");
      fetchUsers();
      setSelectedUser(null);
    } catch {
      toast.error("Delete failed");
    }
  };

  const handleForceReset = async (userId: string) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}/force-reset`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { toast.error("Failed"); return; }
      toast.success("Password reset forced");
      fetchUsers();
    } catch { toast.error("Failed"); }
  };

  const handleForceLogout = async (userId: string) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}/force-logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { toast.error("Failed"); return; }
      toast.success("All sessions terminated");
      fetchUsers();
    } catch { toast.error("Failed"); }
  };

  return (
    <AdminPage className="admin-workspace-collection">
      <AdminPageHeader section="People" title="Users" description="Manage user accounts and access">
        <Button onClick={() => setShowCreate(true)} className="bg-primary">
          <Plus className="mr-2 h-4 w-4" /> Invite User
        </Button>
      </AdminPageHeader>

      <AdminCollection>
      <AdminCollectionHeader title="User directory" description="Find an account, then open it to manage access and security." count={loading ? undefined : users.length} />

      {/* Search */}
      <AdminToolbar label="Find users">
        <div className="relative w-full sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <label htmlFor="user-search" className="sr-only">Search users by name or email</label>
          <Input
            id="user-search"
            type="search"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <p className="sm:ml-auto text-sm text-muted-foreground" aria-live="polite">{users.length} users</p>
      </AdminToolbar>

      {/* Table */}
      <div
        className="admin-table-surface"
        role="region"
        aria-label="Users"
        tabIndex={0}
      >
        <Table className="min-w-[640px] text-sm">
          <TableCaption className="sr-only">List of user accounts with role, status, and last active date. Select a row to view details.</TableCaption>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead scope="col" aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className="h-auto bg-muted/50 p-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <button type="button" onClick={() => toggleSort("name")} className="flex w-full items-center gap-1 px-4 py-3 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  User
                  {sortKey === "name" ? (sortDir === "asc" ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />) : <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" aria-hidden="true" />}
                </button>
              </TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Role</TableHead>
              <TableHead scope="col" className="h-auto bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</TableHead>
              <TableHead scope="col" aria-sort={sortKey === "lastLogin" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className="h-auto bg-muted/50 p-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <button type="button" onClick={() => toggleSort("lastLogin")} className="flex w-full items-center gap-1 px-4 py-3 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  Last Active
                  {sortKey === "lastLogin" ? (sortDir === "asc" ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />) : <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" aria-hidden="true" />}
                </button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr:last-child]:border-b">
            {loading ? (
              [...Array(5)].map((_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={4} className="whitespace-normal px-4 py-4"><div className="h-4 w-48 animate-pulse rounded bg-muted" /></TableCell>
                </TableRow>
              ))
            ) : sortedUsers.length === 0 ? (
              <TableRow className="border-b-0! hover:bg-transparent">
                <TableCell colSpan={4} className="whitespace-normal px-4 py-14 text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
                    <UsersIcon className="h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{search ? "No users match your search" : "No users yet"}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{search ? "Try a different name or email." : "Invite your first user to get started."}</p>
                    </div>
                    {!search && (
                      <Button onClick={() => setShowCreate(true)} size="sm" className="mt-1 bg-primary">
                        <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Invite User
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              sortedUsers.map((user) => (
                <TableRow
                  key={user.id}
                  onClick={() => setSelectedUser(user)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedUser(user);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`View details for ${user.name || user.email}`}
                  className="cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <TableCell className="whitespace-normal px-4 py-3">
                    <div>
                      <p className="font-medium">{user.name || "—"}</p>
                      <p className="text-sm text-muted-foreground">{user.email}</p>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal px-4 py-3">
                    <div className="flex items-center gap-2">
                      {user.role ? (
                        <Badge variant="secondary">{user.role.name}</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">No role</span>
                      )}
                      {user.isAdmin && <Badge variant="default">Admin</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal px-4 py-3">
                    <Badge variant={user.status === "ACTIVE" ? "success" : "destructive"}>
                      {user.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-normal px-4 py-3 text-sm tabular-nums text-muted-foreground">
                    {user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : "Never"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Detail Panel */}
      </AdminCollection>

      <UserDetailPanel
        user={selectedUser}
        roles={roles}
        open={!!selectedUser}
        onClose={() => setSelectedUser(null)}
        onAction={handleAction}
        onDelete={handleDelete}
        onForceReset={handleForceReset}
        onForceLogout={handleForceLogout}
      />

      {/* Create Dialog */}
      <CreateUserDialog
        roles={roles}
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); fetchUsers(); }}
      />
    </AdminPage>
  );
}
