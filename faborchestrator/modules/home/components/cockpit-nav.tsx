"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
} from "@/shared/components/ui/dropdown-menu"
import { LogOut, Shield } from "lucide-react"
import { Button } from "@/shared/components/ui/button"
import { AUTH_TOKEN_KEY, clearAuthStorage } from "@/shared/lib/client-session"
import type { AuthedUser } from "./types"

const sv = (children: React.ReactNode, size = 16) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {children}
    </svg>
)

const NAV_ITEMS: { label: string; active?: boolean; icon: React.ReactNode }[] = [
    { label: "Cockpit", active: true, icon: sv(<><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></>) },
    { label: "Agents", icon: sv(<><circle cx="12" cy="8" r="3.2" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></>) },
    { label: "Workflows", icon: sv(<><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="12" r="2.2" /><path d="M8.2 6H13a3 3 0 0 1 3 3v.4" /><path d="M8.2 18H13a3 3 0 0 0 3-3v-.4" /></>) },
    { label: "Sites", icon: sv(<><path d="M4 21V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15" /><path d="M15 9h4a1 1 0 0 1 1 1v11" /><line x1="7.5" y1="9" x2="11" y2="9" /></>) },
    { label: "Reports", icon: sv(<><line x1="6" y1="20" x2="6" y2="13" /><line x1="12" y1="20" x2="12" y2="8" /><line x1="18" y1="20" x2="18" y2="11" /></>) },
]

function getInitials(name: string | null, email: string): string {
    if (name) {
        const parts = name.trim().split(/\s+/)
        return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || email[0]!.toUpperCase()
    }
    return email[0]!.toUpperCase()
}

export function CockpitNav({
    user,
}: {
    user: AuthedUser | null
}) {
    const router = useRouter()
    const initials = user ? getInitials(user.name, user.email) : "—"
    const displayName = user?.name || user?.email || "—"
    const roleName = user?.role?.name || "Business User"

    const handleLogout = async () => {
        if (typeof window === "undefined") return
        const token = window.localStorage.getItem(AUTH_TOKEN_KEY)
        if (token) {
            try {
                await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } })
            } catch {
                // Ignore — still clear local storage and redirect.
            }
        }
        clearAuthStorage()
        router.push("/")
    }

    return (
        <div className="sticky top-0 z-20 flex items-center gap-1.5 border-b bg-white px-[26px] py-[14px]" style={{ borderColor: "var(--border-light)" }}>
            {/* brand */}
            <div className="mr-[22px] flex items-center gap-2.5">
                <div className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-[15px] font-extrabold text-white" style={{ background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))" }}>
                    A
                </div>
                <div style={{ lineHeight: 1.05 }}>
                    <div className="text-[14.5px] font-bold">FabOrchestrator</div>
                    <div className="text-[9.5px] font-semibold tracking-[0.14em]" style={{ color: "var(--text-[var(--text-subtle)])" }}>ATHENATEC</div>
                </div>
            </div>

            {/* nav links */}
            <nav className="hidden items-center gap-1.5 md:flex">
                {NAV_ITEMS.map((item) => (
                    <Button
                        key={item.label}
                        type="button"
                        variant="ghost"
                        onClick={() => router.push("/home")}
                        className="flex h-auto items-center gap-[7px] rounded-[9px] border-0 bg-transparent px-[14px] py-2 text-[13.5px] font-semibold transition-colors hover:bg-transparent active:scale-100 dark:hover:bg-transparent"
                        style={item.active ? { background: "var(--cockpit-nav-active)", color: "var(--pure-white)" } : { color: "var(--text-muted-cool)" }}
                    >
                        <span className="flex">{item.icon}</span>
                        {item.label}
                    </Button>
                ))}
            </nav>

            <div className="flex-1" />

            {/* util */}
            <div className="flex items-center gap-1.5">
                <Button type="button" variant="ghost" aria-label="Search" className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border-0 bg-transparent p-0 transition-colors hover:bg-[var(--cockpit-surface)] active:scale-100" style={{ color: "var(--text-muted-cool)" }}>
                    {sv(<><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>, 18)}
                </Button>
                <Button type="button" variant="ghost" aria-label="Notifications" className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border-0 bg-transparent p-0 transition-colors hover:bg-[var(--cockpit-surface)] active:scale-100" style={{ color: "var(--text-muted-cool)" }}>
                    {sv(<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>, 18)}
                </Button>

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" className="ml-2 flex h-auto items-center gap-[9px] rounded-none border-0 bg-transparent border-l p-0 pl-[14px] hover:bg-transparent active:scale-100 dark:hover:bg-transparent focus:outline-none" style={{ borderColor: "var(--border-light)" }}>
                            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-[12px] font-bold text-white" style={{ background: "linear-gradient(135deg,var(--brand-indigo-light),var(--cockpit-indigo))" }}>
                                {initials}
                            </span>
                            <span className="hidden text-left md:block" style={{ lineHeight: 1.1 }}>
                                <span className="block text-[12.5px] font-bold">{displayName}</span>
                                <span className="block text-[10px] font-semibold" style={{ color: "var(--text-[var(--text-subtle)])" }}>{roleName}</span>
                            </span>
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuLabel className="leading-tight">
                            <div className="text-sm font-semibold text-foreground">{displayName}</div>
                            {user?.email && <div className="text-xs font-normal text-muted-foreground">{user.email}</div>}
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {user?.isAdmin && (
                            <>
                                <DropdownMenuItem onClick={() => router.push("/admin")}>
                                    <Shield className="mr-2 size-4" />
                                    Admin Console
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                            </>
                        )}
                        <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
                            <LogOut className="mr-2 size-4" />
                            Log out
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </div>
    )
}
