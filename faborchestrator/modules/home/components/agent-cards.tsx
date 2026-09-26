"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/shared/components/ui/button"
import { type McpHealthStatus, type McpHealthSummary } from "@/modules/mcp/lib/mcp-health-types"
import { type AgentKey } from "@/shared/lib/agents"
import { relativeTimeShort } from "@/shared/lib/relative-time"
import type { UserActivity } from "../lib/activity-types"

const sv = (children: React.ReactNode, size: number, sw = 2) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
        {children}
    </svg>
)

const ARROW = sv(<><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></>, 14, 2.2)

interface Agent {
    num: string
    icon: React.ReactNode
    name: string
    cat: string
    desc: string
    route: string
    /** Key in GET /api/mcp/health `agents[].agent` and GET /api/user/activity `agents` — drives the status dot and the usage numbers. */
    agentKey: AgentKey
    /** Looks like every other card, but clicking it does nothing yet. */
    noAction?: boolean
}

/** Dot colour per health status (tokens on :root in app/globals.css). */
const DOT: Record<McpHealthStatus, { fg: string; ring: string }> = {
    healthy: { fg: "var(--status-green)", ring: "rgba(31,169,113,.18)" },
    degraded: { fg: "var(--status-amber)", ring: "rgba(214,132,31,.18)" },
    down: { fg: "var(--status-red)", ring: "rgba(217,64,58,.18)" },
    unknown: { fg: "var(--status-grey)", ring: "rgba(139,147,176,.18)" },
}

/** Status of one agent's MCP servers, and its tooltip ("FabInsight: 6 of 8 servers down"). */
function agentHealth(summary: McpHealthSummary | null, agentKey: string, name: string): { status: McpHealthStatus; title: string } {
    const view = summary?.agents.find((x) => x.agent === agentKey)
    if (!view) return { status: "unknown", title: `${name}: status unknown` }
    const n = view.servers.length
    if (n === 0) return { status: view.status, title: `${name}: no MCP servers assigned` }
    const noun = n === 1 ? "server" : "servers"
    if (view.status === "healthy") return { status: "healthy", title: `${name}: ${n} ${noun} healthy` }
    const healthy = view.servers.filter((s) => s.status === "healthy").length
    const down = view.servers.filter((s) => s.status === "down").length
    const dbDown = view.servers.filter((s) => s.status === "degraded").length
    const parts = [`${healthy} of ${n} ${noun} healthy`, down ? `${down} down` : "", dbDown ? `${dbDown} with DB down` : ""].filter(Boolean)
    return { status: view.status, title: `${name}: ${parts.join(", ")}` }
}

const AGENTS: Agent[] = [
    {
        num: "AGENT · 01",
        icon: sv(<><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="12" r="2.2" /><path d="M8.2 6H13a3 3 0 0 1 3 3v.4" /><path d="M8.2 18H13a3 3 0 0 0 3-3v-.4" /></>, 20),
        name: "FabInsight™",
        cat: "Decision Intelligence",
        desc: "Real-time decisions across MES, ERP, and quality data.",
        route: "/chat?agent=fabinsight",
        agentKey: "fabinsight",
    },
    {
        num: "AGENT · 02",
        icon: sv(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2-2z" />, 20),
        name: "AI Support Engineer",
        cat: "Operations Automation",
        desc: "Automates 70% of routine ops work.",
        route: "/chat",
        agentKey: "support-engineer",
        noAction: true,
    },
    {
        num: "AGENT · 03",
        icon: sv(<><circle cx="7" cy="7" r="2.4" /><circle cx="17" cy="17" r="2.4" /><path d="M9.4 7H15a2 2 0 0 1 2 2v5.6" /><path d="M14.6 17H9a2 2 0 0 1-2-2V9.4" /></>, 20),
        name: "Master Data Load Agent",
        cat: "Enterprise Configuration",
        desc: "AI-guided MES rollouts at scale.",
        route: "/modeling-agent",
        agentKey: "master-data-load",
    },
    {
        num: "AGENT · 04",
        icon: sv(<><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>, 20),
        name: "Coding Agent",
        cat: "Requirement to Code",
        desc: "Turns requirement documents into deployable CMF artifacts.",
        route: "/backend-agent",
        agentKey: "coding-agent",
    },
]


/** The card's usage block: how many conversations the user has had with this agent, and when the last one moved. */
function agentUsage(activity: UserActivity | null, agentKey: AgentKey): { value: string; note: string } {
    const usage = activity?.agents[agentKey]
    if (!usage) return { value: "–", note: activity ? "No activity yet" : "Loading" }
    if (!usage.conversations) return { value: "0", note: "No activity yet" }
    const ago = relativeTimeShort(usage.lastActiveAt)
    const note = !ago ? "No activity yet" : ago === "just now" ? "Active just now" : `Active ${ago} ago`
    return { value: String(usage.conversations), note }
}

export function AgentCards({ health: summary, activity }: { health: McpHealthSummary | null; activity: UserActivity | null }) {
    const router = useRouter()

    return (
        <>
            {/* section head */}
            <div className="mb-[18px] mt-[58px] flex items-center gap-[11px]">
                <span className="text-[18px] font-extrabold tracking-[-0.3px]">The Nucleus</span>
                <span className="rounded-[7px] px-[9px] py-[3px] text-[10.5px] font-bold tracking-[0.06em]" style={{ color: "var(--brand-indigo)", background: "var(--brand-indigo-bg)" }}>
                    4 AGENTS
                </span>
                <Button type="button" variant="ghost" onClick={() => router.push("/home")} className="ml-auto flex h-auto items-center gap-[5px] rounded-none border-0 bg-transparent p-0 text-[13px] font-semibold hover:bg-transparent active:scale-100 dark:hover:bg-transparent" style={{ color: "var(--brand-indigo)" }}>
                    Manage agents {ARROW}
                </Button>
            </div>

            {/* nucleus */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {AGENTS.map((a) => {
                    const health = agentHealth(summary, a.agentKey, a.name.replace("™", ""))
                    const usage = agentUsage(activity, a.agentKey)
                    return (
                    <article
                        key={a.num}
                        // A no-action card looks like the others; clicking it simply does nothing yet.
                        onClick={a.noAction ? undefined : () => router.push(a.route)}
                        className="group flex cursor-pointer flex-col rounded-2xl border bg-white p-[18px] transition-all hover:-translate-y-[3px]"
                        style={{ borderColor: "var(--border-light)", boxShadow: "0 2px 10px rgba(22,28,52,.05)" }}
                    >
                        <div className="flex items-center justify-between">
                            <span className="text-[9.5px] font-bold tracking-[0.14em]" style={{ color: "var(--text-[var(--text-subtle)])" }}>{a.num}</span>
                            <span
                                data-testid={`agent-status-dot-${a.agentKey}`}
                                data-status={health.status}
                                role="img"
                                aria-label={health.title}
                                title={health.title}
                                className="mr-[2px] inline-block h-[8px] w-[8px] shrink-0 rounded-full"
                                style={{ background: DOT[health.status].fg, boxShadow: `0 0 0 3px ${DOT[health.status].ring}` }}
                            />
                        </div>

                        <div className="my-[10px] mb-[14px] flex h-[42px] w-[42px] items-center justify-center rounded-xl text-white" style={{ background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))", boxShadow: "0 5px 14px rgba(91,84,232,.3)", marginTop: 10, marginBottom: 14 }}>
                            {a.icon}
                        </div>

                        <div className="text-[16px] font-bold">{a.name}</div>
                        <div className="mt-[3px] text-[9.5px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--brand-indigo)" }}>{a.cat}</div>
                        <div className="mt-2.5 min-h-[54px] text-[12.5px] leading-[1.5]" style={{ color: "var(--text-muted-cool)" }}>{a.desc}</div>

                        <div className="mt-1.5 rounded-[11px] px-[13px] py-[11px]" style={{ background: "var(--cockpit-surface)" }}>
                            <div className="text-[9.5px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--text-subtle)" }}>Conversations</div>
                            <div className="mt-[5px] flex items-baseline gap-2">
                                <span className="text-[23px] font-extrabold tracking-[-0.5px]">{usage.value}</span>
                                <span className="truncate text-[12px] font-bold" style={{ color: usage.value !== "0" && usage.value !== "–" ? "var(--status-green)" : "var(--text-subtle)" }}>
                                    {usage.note}
                                </span>
                            </div>
                        </div>

                        <div className="mt-[14px] flex items-center gap-1.5 text-[13px] font-bold transition-colors group-hover:text-[var(--cockpit-indigo)]" style={{ color: "var(--brand-indigo)" }}>
                            Open
                            <span className="flex transition-transform group-hover:translate-x-[3px]">{ARROW}</span>
                        </div>
                    </article>
                    )
                })}

            </div>
        </>
    )
}
