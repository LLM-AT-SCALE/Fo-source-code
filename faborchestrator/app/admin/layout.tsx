"use client";

import "@/modules/admin/admin.css";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AdminWorkspaceBar } from "@/modules/admin/components/admin-workspace-bar";
import { AdminSidebar, AdminMobileNav } from "@/modules/admin/components/admin-sidebar";
import { ConfirmProvider } from "@/shared/components/ui/confirm-dialog";
import { AUTH_TOKEN_KEY, AUTH_SESSION_KEY, clearAuthStorage } from "@/shared/lib/client-session";

/** The signed-in admin as the shell renders them. */
interface AdminUser {
  id: string;
  email: string;
  name?: string | null;
  isAdmin: boolean;
}

/**
 * Gate for everything under /admin.
 *
 * The session blob in localStorage is only a hint (it is written by the login
 * page from the login response). Admin status is verified server-side on every
 * mount by calling GET /api/auth/me with the bearer token:
 *   - no token / no session blob      → login page
 *   - 401 (expired, evicted, revoked) → storage cleared, login page
 *   - signed in but not an admin      → /home
 * The shell only renders once the server has said "admin".
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const isChat = pathname === "/admin/chat" || pathname.startsWith("/admin/chat/");
  const [user, setUser] = useState<AdminUser | null>(null);

  useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    const sessionStr = localStorage.getItem(AUTH_SESSION_KEY);

    if (!token || !sessionStr) {
      router.replace("/");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (cancelled) return;

        if (res.status === 401) {
          clearAuthStorage();
          router.replace("/");
          return;
        }
        if (!res.ok) {
          // Server trouble is not a reason to log the user out; send them home.
          router.replace("/home");
          return;
        }

        const data = await res.json();
        const me = data?.user as
          | { id: string; email: string; name?: string | null; isAdmin?: boolean }
          | undefined;

        if (!me?.id) {
          router.replace("/");
          return;
        }
        if (!me.isAdmin) {
          router.replace("/home");
          return;
        }

        setUser({ id: me.id, email: me.email, name: me.name ?? null, isAdmin: true });
      } catch {
        if (!cancelled) router.replace("/home");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!user) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-label="Loading">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  return (
    <ConfirmProvider>
      <div className={isChat ? "flex h-full flex-col md:flex-row" : "admin-shell flex h-full flex-col md:flex-row"}>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        {/* Mobile top bar — provides nav access where the static sidebar is hidden. */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-sidebar px-3 md:hidden">
          <AdminMobileNav user={user} />
          <span className="text-sm font-semibold text-sidebar-foreground">Admin Console</span>
        </header>

        <AdminSidebar user={user} />

        <main
          id="main-content"
          tabIndex={0}
          className={isChat ? "flex-1 overflow-y-auto bg-background focus:outline-none" : "min-w-0 flex-1 overflow-y-auto bg-background focus:outline-none"}
        >
          {!isChat && <AdminWorkspaceBar user={user} />}
          {children}
        </main>
      </div>
    </ConfirmProvider>
  );
}
