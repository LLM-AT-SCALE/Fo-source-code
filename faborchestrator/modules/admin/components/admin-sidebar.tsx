"use client";

import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import {
  LayoutDashboard,
  Users,
  Shield,
  BarChart3,
  Gauge,
  ScrollText,
  TriangleAlert,
  ShieldCheck,
  BellRing,
  Mail,
  Settings,
  LogOut,
  MessageSquare,
  Wrench,
  Boxes,
  Database,
  LayoutGrid,
  ChevronLeft,
  ChevronRight,
  Menu,
  ArrowLeft,
} from "lucide-react";
import { useEffect, useState } from "react";
import { usePendingDashboardRequests } from "@/modules/admin/components/use-pending-dashboard-requests";
import { AUTH_TOKEN_KEY, clearAuthStorage } from "@/shared/lib/client-session";

interface NavItem {
  label: string;
  href: string;
  icon: React.ElementType;
  /** Which live counter (if any) to show as a badge on this item. */
  badge?: "pendingDashboardRequests";
  /** Extra path prefixes that count as this item being active (e.g. a detail route under another segment). */
  alsoActive?: string[];
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

export const navGroups: NavGroup[] = [
  {
    title: "Overview",
    items: [
      { label: "Dashboard", href: "/admin", icon: LayoutDashboard },
      { label: "AI Chat", href: "/admin/chat", icon: MessageSquare },
    ],
  },
  {
    title: "People",
    items: [
      { label: "Users", href: "/admin/users", icon: Users },
      { label: "Roles", href: "/admin/roles", icon: Shield },
    ],
  },
  {
    title: "Configuration",
    items: [
      { label: "Models", href: "/admin/models", icon: Boxes },
      { label: "MCP Connections", href: "/admin/mcp", icon: Wrench },
      { label: "Database Connections", href: "/admin/database-connections", icon: Database },
      { label: "Dashboards", href: "/admin/dashboards", icon: LayoutGrid, badge: "pendingDashboardRequests", alsoActive: ["/admin/dashboard-requests"] },
    ],
  },
  {
    title: "Monitoring",
    items: [
      { label: "Usage", href: "/admin/usage", icon: BarChart3 },
      { label: "Performance", href: "/admin/performance", icon: Gauge },
      // Errors sits above Audit Logs deliberately: the two read alike but are
      // different tables. This one is error_audit_logs — what FAILED for a
      // user. "Audit Logs" is admin ACTIONS (who changed what).
      { label: "Errors", href: "/admin/errors", icon: TriangleAlert },
      { label: "Audit Logs", href: "/admin/audit-logs", icon: ScrollText },
      { label: "Alert Thresholds", href: "/admin/alert-thresholds", icon: BellRing },
      { label: "Shift Summaries", href: "/admin/shift-summaries", icon: Mail },
      { label: "Compliance", href: "/admin/compliance", icon: ShieldCheck },
    ],
  },
  {
    title: "System",
    items: [
      { label: "Settings", href: "/admin/settings", icon: Settings },
    ],
  },
];

interface AdminUser {
  id?: string;
  name?: string | null;
  email: string;
  isAdmin?: boolean;
}

/** Where "Back to FabOrchestrator" lands: the cockpit of the main app. */
const APP_HOME_HREF = "/home";

// Preserve the existing brand token for the active destination.
const ACTIVE_BG = "var(--brand-indigo)";

function useLogout() {
  const router = useRouter();
  return async () => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (token) {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    clearAuthStorage();
    router.push("/");
  };
}

function isActivePath(pathname: string, href: string, alsoActive: string[] = []) {
  if (href === "/admin") return pathname === "/admin";
  return pathname.startsWith(href) || alsoActive.some((p) => pathname.startsWith(p));
}

/** "Back to FabOrchestrator" — styled like a nav item, never marked active. */
function BackToAppItem({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const btn = (
    <Button
      variant="ghost"
      size={collapsed ? "icon" : "default"}
      onClick={onClick}
      aria-label={collapsed ? "Back to FabOrchestrator" : undefined}
      className={cn(
        "flex h-auto items-center justify-start rounded-lg text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 [&_svg]:size-[18px]",
        collapsed ? "h-11 w-11 justify-center" : "min-h-11 w-full gap-3 px-3 py-2"
      )}
    >
      <ArrowLeft className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
      {!collapsed && <span className="flex-1 text-left">Back to FabOrchestrator</span>}
    </Button>
  );
  if (!collapsed) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="right" className="border-0 bg-sidebar-active-navy font-medium text-white">
        Back to FabOrchestrator
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The navigation list. Shared between the desktop sidebar and the mobile drawer.
 * `collapsed` only applies to the desktop icon-rail mode; the mobile drawer
 * always renders the full-label layout. `onNavigate` lets the mobile drawer
 * close itself after a selection.
 */
function NavList({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const pendingRequests = usePendingDashboardRequests();

  const go = (href: string) => {
    router.push(href);
    onNavigate?.();
  };

  const badgeCount = (item: NavItem) => (item.badge === "pendingDashboardRequests" ? pendingRequests : 0);

  return (
    <nav
      aria-label="Primary"
      className={cn(
        // `overflow-y-auto` shows a bar only when the nav actually overflows;
        // `overscroll-contain` stops a scroll that reaches the end of the nav
        // from continuing into the page behind it.
        "flex-1 overflow-y-auto overflow-x-hidden overscroll-contain",
        collapsed ? "px-2 py-2" : "px-2 pb-2 pt-5"
      )}
    >
      {/* Back to the main app — admins arrive here from the cockpit. */}
      <div className={collapsed ? "mb-3 flex flex-col items-center" : "mb-4"}>
        <BackToAppItem collapsed={collapsed} onClick={() => go(APP_HOME_HREF)} />
      </div>

      {navGroups.map((group) => (
        <div key={group.title} className={collapsed ? "mb-3" : "mb-4"}>
          {!collapsed && (
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/60">
              {group.title}
            </p>
          )}
          <div className={collapsed ? "flex flex-col items-center gap-1.5" : ""}>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = isActivePath(pathname, item.href, item.alsoActive);
              const count = badgeCount(item);
              const btn = (
                <Button
                  variant="ghost"
                  size={collapsed ? "icon" : "default"}
                  onClick={() => go(item.href)}
                  aria-current={active ? "page" : undefined}
                  aria-label={collapsed ? (count ? `${item.label} (${count} pending)` : item.label) : undefined}
                  className={cn(
                    "relative flex h-auto items-center justify-start rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 [&_svg]:size-[18px]",
                    collapsed ? "h-11 w-11 justify-center" : "min-h-11 w-full gap-3 px-3 py-2",
                    active
                      ? "text-white hover:text-white"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  )}
                  style={active ? { backgroundColor: ACTIVE_BG } : undefined}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                  {!collapsed && <span className="flex-1 text-left">{item.label}</span>}
                  {count > 0 && !collapsed && (
                    <span
                      className="ml-auto inline-flex min-w-[20px] items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold leading-5 text-white"
                      aria-label={`${count} pending`}
                    >
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                  {count > 0 && collapsed && (
                    <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-sidebar" aria-hidden="true" />
                  )}
                </Button>
              );
              return collapsed ? (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>{btn}</TooltipTrigger>
                  <TooltipContent side="right" className="border-0 bg-sidebar-active-navy font-medium text-white">
                    {item.label}{count > 0 ? ` (${count} pending)` : ""}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <div key={item.href}>{btn}</div>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

/**
 * Profile block that opens an upward account menu (Settings, Sign out). In the
 * collapsed rail the avatar initial alone is the trigger. Radix handles
 * Enter/Space to open and Escape to close.
 */
function SidebarFooter({
  collapsed,
  user,
  onLogout,
}: {
  collapsed: boolean;
  user?: AdminUser;
  onLogout: () => void;
}) {
  const router = useRouter();
  if (!user) return null;
  const initial = (user.name?.trim()?.[0] || user.email[0]).toUpperCase();
  const displayName = user.name || "Admin";

  const menu = (
    <DropdownMenuContent side="top" align={collapsed ? "start" : "end"} sideOffset={8} className="w-60">
      <DropdownMenuLabel className="font-normal">
        <p className="truncate text-sm font-medium">{displayName}</p>
        <p className="truncate text-xs text-muted-foreground">{user.email}</p>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => router.push(APP_HOME_HREF)}>
        <ArrowLeft aria-hidden="true" />
        Back to FabOrchestrator
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => router.push("/admin/settings")}>
        <Settings aria-hidden="true" />
        Profile / Settings
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={onLogout}
        className="text-red-600 focus:bg-red-50 focus:text-red-700 dark:text-red-400 dark:focus:bg-red-950/40 dark:focus:text-red-300"
      >
        <LogOut aria-hidden="true" />
        Sign out
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  return (
    <div className={cn("p-3", collapsed && "flex flex-col items-center")}>
      {collapsed ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Account menu for ${displayName}`}
                  className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
                >
                  {initial}
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" className="border-0 bg-sidebar-active-navy font-medium text-white">{displayName}</TooltipContent>
          </Tooltip>
          {menu}
        </DropdownMenu>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Account menu for ${displayName}`}
              className="flex w-full items-center gap-2.5 rounded-lg bg-sidebar-accent/40 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground"
                aria-hidden
              >
                {initial}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-sm font-medium text-sidebar-foreground">{displayName}</span>
                <span className="block truncate text-xs text-sidebar-foreground/70">{user.email}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 -rotate-90 text-sidebar-foreground/60" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          {menu}
        </DropdownMenu>
      )}
    </div>
  );
}

interface AdminSidebarProps {
  user?: AdminUser;
}

/**
 * Desktop sidebar — hidden below the `md` breakpoint where the mobile drawer
 * (AdminMobileNav) takes over.
 */
export function AdminSidebar({ user }: AdminSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const handleLogout = useLogout();

  return (
    <TooltipProvider delayDuration={0}>
      <div
        /* Marks this subtree for the tinted sidebar scrollbar in globals.css —
           a dark thumb is invisible against the navy column. */
        data-admin-sidebar=""
        className={cn(
          "admin-navigation hidden h-full shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200 md:flex",
          collapsed ? "w-[72px]" : "w-[248px]"
        )}
      >
        {/* Header */}
        {collapsed ? (
          <div className="flex flex-col items-center gap-2 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary">
              <Shield className="h-5 w-5 text-primary-foreground" aria-hidden="true" />
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setCollapsed(false)}
              className="h-11 w-11 shrink-0 text-sidebar-foreground/70 hover:text-sidebar-foreground"
              aria-label="Expand sidebar"
              aria-expanded={false}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <div className="flex h-20 shrink-0 items-center justify-between border-b px-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary">
                <Shield className="h-5 w-5 text-primary-foreground" aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-sidebar-foreground">Admin Console</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setCollapsed(true)}
              className="h-11 w-11 shrink-0 text-sidebar-foreground/70 hover:text-sidebar-foreground"
              aria-label="Collapse sidebar"
              aria-expanded={true}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        )}

        <NavList collapsed={collapsed} />
        <SidebarFooter collapsed={collapsed} user={user} onLogout={handleLogout} />
      </div>
    </TooltipProvider>
  );
}

/**
 * Mobile navigation — a hamburger button that opens the same navigation inside
 * a slide-in drawer. Rendered in the mobile top bar (see app/admin/layout.tsx).
 * Visible only below the `md` breakpoint.
 */
export function AdminMobileNav({ user }: AdminSidebarProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const handleLogout = useLogout();

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        className="size-11 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls="admin-mobile-nav"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </Button>
      <SheetContent
        side="left"
        id="admin-mobile-nav"
        className="flex w-72 flex-col bg-sidebar p-0"
      >
        <SheetTitle className="flex h-14 items-center gap-2.5 px-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary">
            <Shield className="h-5 w-5 text-primary-foreground" aria-hidden="true" />
          </span>
          <span className="text-sm font-semibold text-sidebar-foreground">Admin Console</span>
        </SheetTitle>
        <NavList collapsed={false} onNavigate={() => setOpen(false)} />
        <SidebarFooter collapsed={false} user={user} onLogout={handleLogout} />
      </SheetContent>
    </Sheet>
  );
}
