"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type { AgentKey } from "@/shared/lib/agents"
import { relativeTimeShort } from "@/shared/lib/relative-time"
import type { McpHealthSummary } from "@/modules/mcp/lib/mcp-health-types"
import type { UserActivity } from "../lib/activity-types"

const sv = (children: React.ReactNode, size: number, sw = 2) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
        {children}
    </svg>
)

/** The icon each agent's activity row carries (same glyphs as the nucleus cards). */
const AGENT_ICON: Record<AgentKey, React.ReactNode> = {
    fabinsight: sv(<><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="12" r="2.2" /><path d="M8.2 6H13a3 3 0 0 1 3 3v.4" /><path d="M8.2 18H13a3 3 0 0 0 3-3v-.4" /></>, 16),
    "support-engineer": sv(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2-2z" />, 16),
    "master-data-load": sv(<><circle cx="7" cy="7" r="2.4" /><circle cx="17" cy="17" r="2.4" /><path d="M9.4 7H15a2 2 0 0 1 2 2v5.6" /></>, 16),
    "coding-agent": sv(<><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>, 16),
}

const ICON_WORKFLOWS = sv(<><circle cx="6" cy="6" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="18" r="2" /><path d="M8 6h5a3 3 0 0 1 3 3v.4M8 18h5a3 3 0 0 0 3-3v-.4" /></>, 13)
const ICON_REPORTS = sv(<><line x1="6" y1="20" x2="6" y2="13" /><line x1="12" y1="20" x2="12" y2="8" /><line x1="18" y1="20" x2="18" y2="11" /></>, 13)
const ICON_LOADS = sv(<><circle cx="12" cy="12" r="9" /><polyline points="9 12 11 14 15 9" /></>, 13)
const ICON_SERVERS = sv(<><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><line x1="7" y1="7" x2="7.01" y2="7" /><line x1="7" y1="17" x2="7.01" y2="17" /></>, 13)

const GREEN = "var(--status-green)"
const AMBER = "var(--status-amber)"
const RED = "var(--status-red)"
const SUBTLE = "var(--text-subtle)"

type Tile = { label: string; icon: React.ReactNode; value: string; note: string; tone: string }

/** The four "Live ops" tiles from the user's own numbers and the health of their data servers. */
function tiles(activity: UserActivity | null, health: McpHealthSummary | null): Tile[] {
    const t = activity?.totals
    const conversations: Tile = {
        label: "Conversations", icon: ICON_WORKFLOWS,
        value: t ? String(t.conversations) : "–",
        note: t ? (t.conversationsThisWeek ? `${t.conversationsThisWeek} this week` : "None this week") : "Loading",
        tone: t?.conversationsThisWeek ? GREEN : SUBTLE,
    }
    const dashboards: Tile = {
        label: "Reports", icon: ICON_REPORTS,
        value: t ? String(t.dashboards) : "–",
        note: t ? (t.dashboardsPending ? `${t.dashboardsPending} pending approval` : "None pending approval") : "Loading",
        tone: t?.dashboardsPending ? AMBER : SUBTLE,
    }
    const loads: Tile = {
        label: "Data loads", icon: ICON_LOADS,
        value: t ? String(t.dataLoads) : "–",
        note: t ? (t.lastDataLoad ? `Last: ${t.lastDataLoad.text}` : "No loads yet") : "Loading",
        tone: t?.lastDataLoad?.ok === true ? GREEN : t?.lastDataLoad?.ok === false ? RED : SUBTLE,
    }
    const servers = health ? health.agents.flatMap((a) => a.servers) : null
    const total = servers?.length ?? 0
    const healthy = servers ? servers.filter((s) => s.status === "healthy").length : 0
    const down = servers ? servers.filter((s) => s.status === "down").length : 0
    const dbDown = servers ? servers.filter((s) => s.status === "degraded").length : 0
    const trouble = [down ? `${down} down` : "", dbDown ? `${dbDown} with DB down` : ""].filter(Boolean).join(", ")
    const dataServers: Tile = {
        label: "Data servers", icon: ICON_SERVERS,
        value: servers ? String(healthy) : "–",
        note: !servers ? "Checking" : total === 0 ? "None assigned" : trouble || `All ${total} healthy`,
        tone: !servers || total === 0 ? SUBTLE : down ? RED : dbDown ? AMBER : GREEN,
    }
    return [conversations, dashboards, loads, dataServers]
}

export function CockpitFooterStats({ activity, loading, health }: { activity: UserActivity | null; loading: boolean; health: McpHealthSummary | null }) {
    const router = useRouter()
    // Re-render every 30 s so "2 min" stays honest between fetches.
    const [now, setNow] = React.useState(() => Date.now())
    React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000)
        return () => clearInterval(timer)
    }, [])

    const items = activity?.items ?? []
    const emptyText = loading ? "Loading your activity" : activity ? "No activity yet — start a conversation with any agent." : "Your activity is not available right now."

    return (
        <div className="mt-[34px] grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
            {/* Live ops */}
            <div className="rounded-2xl border bg-white px-5 py-[18px]" style={{ borderColor: "var(--border-light)", boxShadow: "0 2px 10px rgba(22,28,52,.05)" }}>
                <div className="mb-[14px] flex items-center justify-between">
                    <span className="flex items-center gap-2 text-[14.5px] font-bold">
                        <span className="flex" style={{ color: "var(--brand-indigo)" }}>{sv(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />, 17)}</span>
                        Live ops
                    </span>
                    <Link href="/reports" className="text-[12.5px] font-semibold" style={{ color: "var(--brand-indigo)" }}>Reports →</Link>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    {tiles(activity, health).map((k) => (
                        <div key={k.label} className="rounded-xl px-[15px] py-[14px]" style={{ background: "var(--cockpit-surface)" }}>
                            <div className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em]" style={{ color: "var(--text-muted-cool)" }}>
                                {k.icon}
                                {k.label}
                            </div>
                            <div className="mt-[7px] text-[27px] font-extrabold tracking-[-0.6px]">{k.value}</div>
                            <div className="mt-[3px] truncate text-[11.5px] font-semibold" title={k.note} style={{ color: k.tone }}>{k.note}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Recent activity */}
            <div className="rounded-2xl border bg-white px-5 py-[18px]" style={{ borderColor: "var(--border-light)", boxShadow: "0 2px 10px rgba(22,28,52,.05)" }}>
                <div className="mb-[14px] flex items-center justify-between">
                    <span className="flex items-center gap-2 text-[14.5px] font-bold">
                        <span className="flex" style={{ color: "var(--brand-indigo)" }}>{sv(<><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></>, 17)}</span>
                        Recent activity
                    </span>
                    <Link href="/chat" className="text-[12.5px] font-semibold" style={{ color: "var(--brand-indigo)" }}>All →</Link>
                </div>
                <div className="flex flex-col gap-[3px]" data-testid="recent-activity">
                    {items.length === 0 ? (
                        <div className="px-2 py-[9px] text-[12.5px]" style={{ color: "var(--text-muted-cool)" }}>{emptyText}</div>
                    ) : items.map((a, i) => (
                        <div
                            key={`${a.agent}-${a.at}-${i}`}
                            role="link"
                            tabIndex={0}
                            onClick={() => router.push(a.href)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push(a.href) } }}
                            className="flex cursor-pointer items-center gap-3 rounded-[10px] px-2 py-[9px] transition-colors hover:bg-[var(--cockpit-surface)]"
                        >
                            <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[9px] text-white" style={{ background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))" }}>
                                {AGENT_ICON[a.agent]}
                            </span>
                            <span className="min-w-0 flex-1" style={{ lineHeight: 1.3 }}>
                                <span className="block text-[13px] font-bold">{a.label}</span>
                                <span className="block truncate text-[12px]" title={a.description} style={{ color: "var(--text-muted-cool)" }}>{a.description}</span>
                            </span>
                            {a.active && <span className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: GREEN, boxShadow: "0 0 0 3px rgba(31,169,113,.16)" }} />}
                            <span className="whitespace-nowrap text-[11px] font-semibold" style={{ color: SUBTLE }}>{relativeTimeShort(a.at, now)}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
