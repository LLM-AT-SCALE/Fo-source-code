"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { navGroups } from "@/modules/admin/components/admin-sidebar";

/** Global context belongs to the shell; AI Chat never mounts this bar. */
export function AdminWorkspaceBar({ user }: { user?: { name?: string | null; email: string } }) {
  const pathname = usePathname();
  const group = navGroups.find(group => group.items.some(item => item.href === pathname || (item.href !== "/admin" && pathname.startsWith(item.href + "/"))));
  const current = group?.items.find(item => item.href === pathname || (item.href !== "/admin" && pathname.startsWith(item.href + "/")));
  const detail = current && current.href !== pathname;
  return (
    <div className="admin-workspace-bar">
      <nav aria-label="Breadcrumb" className="admin-breadcrumb">
        <Link href="/admin">Admin</Link>
        {current && current.href !== "/admin" && <>
          <ChevronRight aria-hidden="true" />
          {detail ? <Link href={current.href}>{current.label}</Link> : <span aria-current="page">{current.label}</span>}
          {detail && <><ChevronRight aria-hidden="true" /><span aria-current="page">Details</span></>}
        </>}
      </nav>
      <div className="admin-workspace-tools">
        <span className="admin-account" title={user?.email}>{user?.name || user?.email}</span>
      </div>
    </div>
  );
}
