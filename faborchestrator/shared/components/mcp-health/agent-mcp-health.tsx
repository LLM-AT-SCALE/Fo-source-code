"use client"

/**
 * MCP health for ONE agent — the pill in the top-right corner of each agent's
 * chat (FabInsight, AI Support Engineer, Master Data Load, Coding Agent) and
 * the popover it opens: the MCP servers that user has on that agent, each with
 * its MCP server and its database as separate Healthy / Down columns.
 *
 *   ● MCP health · 2 of 8 healthy        (click)
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ FabInsight MCP health                       [2 healthy] [Check now] │
 *   │ SERVER                         MCP SERVER   DATABASE      CHECKED   │
 *   │ CM MES - Assembly (Use Cases)  ● Healthy    ● Healthy     2 min ago │
 *   │ ECO Testing-1                  ● Down       ● Not checked 2 min ago │
 *   │   Lambda function no longer exists — redeploy it or update its URL  │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * One poll per page (useMcpHealth); "Check now" re-checks only this agent's servers.
 */

import * as React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/components/ui/popover"
import { useMcpHealth } from "@/shared/hooks/use-mcp-health"
import { getAuthHeaders } from "@/shared/lib/client-session"
import { AGENT_LABELS, type AgentKey } from "@/shared/lib/agents"
import type {
    McpDatabaseLayer,
    McpHealthAgentView,
    McpHealthServerView,
    McpHealthStatus,
    McpHealthSummary,
    McpServerLayer,
} from "@/modules/mcp/lib/mcp-health-types"

/* ------------------------------------------------------------------ */
/* Colours and words                                                   */
/* ------------------------------------------------------------------ */

/** Foreground / background tokens per status (defined on :root in app/globals.css). */
const STATUS_COLOURS: Record<McpHealthStatus, { fg: string; bg: string }> = {
    healthy: { fg: "var(--status-green)", bg: "var(--status-green-bg)" },
    degraded: { fg: "var(--status-amber)", bg: "var(--status-amber-bg)" },
    down: { fg: "var(--status-red)", bg: "var(--status-red-bg)" },
    unknown: { fg: "var(--status-grey)", bg: "var(--status-grey-bg)" },
}

type LayerState = { status: McpHealthStatus; text: string }

const SERVER_STATES: Record<McpServerLayer, LayerState> = {
    up: { status: "healthy", text: "Healthy" },
    down: { status: "down", text: "Down" },
    "not-checked": { status: "unknown", text: "Not checked" },
}

const DATABASE_STATES: Record<McpDatabaseLayer, LayerState> = {
    ok: { status: "healthy", text: "Healthy" },
    failed: { status: "down", text: "Down" },
    "not-tested": { status: "unknown", text: "Not checked" },
}

/** A one-line reason an operator can act on; the full message stays in the tooltip. */
function shortReason(error: string): string {
    const e = error.trim()
    if (/Function not found|ResourceNotFoundException/i.test(e)) return "Lambda function no longer exists — redeploy it or update its URL"
    if (/HTTP 401|HTTP 403|unauthorized/i.test(e)) return "API key refused (HTTP 401) — re-enter it in the MCP registry"
    if (/HTTP 404/i.test(e)) return "Nothing at the server URL (HTTP 404) — check the connector URL"
    if (/could not be decrypted/i.test(e)) return "Saved API key cannot be read — re-enter it in the MCP registry"
    if (/timed? ?out|aborted due to timeout/i.test(e)) return "No answer in time (timeout)"
    if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(e)) return "Server not reachable on the network"
    if (/database not tested/i.test(e)) return "Server up; no safe read found, database not tested"
    // {'ok': False, 'error': '…'} — keep only the message.
    const inner = /['"]error['"]\s*:\s*['"]([^'"]+)['"]/.exec(e)?.[1]
    const text = (inner ?? e).replace(/\s+/g, " ")
    return text.length > 90 ? `${text.slice(0, 87)}…` : text
}

/** Why the latest check could not run on our side, in words a user can pass on. */
function recheckReason(error: string): string {
    if (/expired/i.test(error)) return "Couldn't re-check just now — this app's AWS access has expired"
    if (/cannot call AWS Lambda/i.test(error)) return "Couldn't re-check just now — this app can't call AWS Lambda"
    if (/could not be decrypted/i.test(error)) return "Couldn't re-check just now — the saved API key can't be read on this app server"
    return "Couldn't re-check just now"
}

/** "just now", "12 min ago", "1 h ago", "2 d ago", or "never". */
function ago(iso: string | null, now = Date.now()): string {
    if (!iso) return "never"
    const t = Date.parse(iso)
    if (Number.isNaN(t)) return "never"
    const min = Math.max(0, Math.round((now - t) / 60000))
    if (min < 1) return "just now"
    if (min < 60) return `${min} min ago`
    const h = Math.round(min / 60)
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Dot({ status, size = 7 }: { status: McpHealthStatus; size?: number }) {
    return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: STATUS_COLOURS[status].fg }} aria-hidden="true" />
}

function Cell({ state }: { state: LayerState }) {
    const c = STATUS_COLOURS[state.status]
    return (
        <span className="inline-flex items-center gap-[6px] whitespace-nowrap rounded-full px-[8px] py-[2px] text-[11.5px] font-semibold" style={{ color: c.fg, background: c.bg }}>
            <Dot status={state.status} size={6} />
            {state.text}
        </span>
    )
}

function CheckNowButton({ checking, onCheck }: { checking: boolean; onCheck: () => void }) {
    return (
        <button
            type="button"
            data-testid="mcp-check-now"
            onClick={onCheck}
            disabled={checking}
            aria-busy={checking}
            className="inline-flex cursor-pointer items-center gap-[6px] rounded-[9px] border px-[11px] py-[5px] text-[12px] font-semibold transition-colors hover:bg-[var(--cockpit-surface)] disabled:cursor-wait disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-indigo)]"
            style={{ borderColor: "var(--border-light)", color: "var(--brand-indigo)", background: "var(--pure-white)" }}
        >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className={checking ? "animate-spin" : undefined} aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
            </svg>
            {checking ? "Checking…" : "Check now"}
        </button>
    )
}

/** "Checked automatically every 5 min · last run 2 min ago", or say plainly that they are not running. */
function AutoCheckLine({ summary }: { summary: McpHealthSummary | null }) {
    const auto = summary?.autoCheck
    if (!auto) return null
    const every = `every ${Math.max(1, Math.round(auto.intervalMs / 60000))} min`
    const last = auto.lastRunAt ? Date.parse(auto.lastRunAt) : NaN
    const running = Number.isFinite(last) && Date.now() - last < 3 * auto.intervalMs
    return running ? (
        <div className="mt-[2px] text-[11px]" style={{ color: "var(--text-subtle)" }}>
            Checked automatically {every} · last run {ago(auto.lastRunAt)}
        </div>
    ) : (
        <div className="mt-[2px] text-[11px] font-medium" style={{ color: "var(--status-amber)" }}>
            Automatic checks aren&apos;t running{auto.lastRunAt ? ` (last run ${ago(auto.lastRunAt)})` : ""} · use Check now
        </div>
    )
}

function Totals({ view }: { view: McpHealthAgentView }) {
    const healthy = view.servers.filter((s) => s.status === "healthy").length
    const problem = view.servers.filter((s) => s.status === "down" || s.status === "degraded").length
    const unchecked = view.servers.length - healthy - problem
    const chip = (status: McpHealthStatus, text: string) => (
        <span className="rounded-full px-[8px] py-[2px]" style={{ color: STATUS_COLOURS[status].fg, background: STATUS_COLOURS[status].bg }}>{text}</span>
    )
    return (
        <div className="flex flex-wrap items-center gap-[6px] text-[11px] font-semibold">
            {healthy > 0 && chip("healthy", `${healthy} healthy`)}
            {problem > 0 && chip("down", `${problem} with a problem`)}
            {unchecked > 0 && chip("unknown", `${unchecked} not checked`)}
        </div>
    )
}

/** The table: one row per server, the server and its database as separate columns. */
function ServerTable({ rows, serverHeader, databaseHeader }: { rows: McpHealthServerView[]; serverHeader: string; databaseHeader: string }) {
    const now = Date.now()
    const th = "px-[10px] py-[7px] text-left text-[10px] font-bold uppercase tracking-[0.08em]"
    return (
        <div className="overflow-x-auto rounded-[10px] border" style={{ borderColor: "var(--border-light)" }}>
            <table className="w-full min-w-[520px] table-fixed border-collapse text-[12.5px]" data-testid="mcp-health-table">
                <thead>
                    <tr style={{ background: "var(--cockpit-surface)", color: "var(--text-subtle)" }}>
                        <th scope="col" className={th}>Name</th>
                        <th scope="col" className={`${th} w-[122px]`}>{serverHeader}</th>
                        <th scope="col" className={`${th} w-[122px]`}>{databaseHeader}</th>
                        <th scope="col" className={`${th} w-[86px] text-right`}>Checked</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((s) => (
                        <tr
                            key={s.registryId}
                            data-testid="mcp-health-row"
                            data-server={s.server}
                            data-database={s.database}
                            className="align-top"
                            style={{ borderTop: "1px solid var(--border-light)" }}
                        >
                            <td className="px-[10px] py-[7px]">
                                <div className="truncate font-semibold" style={{ color: "var(--text-ink)" }} title={s.name}>{s.name}</div>
                                {s.error && s.status !== "healthy" && (
                                    <div className="mt-[2px] line-clamp-2 break-words text-[11px]" style={{ color: STATUS_COLOURS[s.status].fg }} title={s.error}>
                                        {shortReason(s.error)}
                                    </div>
                                )}
                                {s.recheckFailed && (
                                    <div className="mt-[2px] line-clamp-2 break-words text-[11px] font-medium" style={{ color: "var(--status-amber)" }} title={s.recheckFailed}>
                                        ⚠ {recheckReason(s.recheckFailed)} · showing the result from {ago(s.checkedAt, now)}
                                    </div>
                                )}
                            </td>
                            <td className="px-[10px] py-[7px]"><Cell state={SERVER_STATES[s.server]} /></td>
                            <td className="px-[10px] py-[7px]" title={s.toolUsed ? `Checked with ${s.toolUsed}` : undefined}>
                                <Cell state={DATABASE_STATES[s.database]} />
                            </td>
                            <td
                                className="whitespace-nowrap px-[10px] py-[7px] text-right text-[11px]"
                                style={{ color: s.recheckFailed ? "var(--status-amber)" : "var(--text-subtle)" }}
                                title={s.recheckFailed ? "Not renewed by the latest check" : undefined}
                            >
                                {ago(s.checkedAt, now)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/* ------------------------------------------------------------------ */
/* CMF — the Master Data Load Agent's own databases (not MCP)          */
/* ------------------------------------------------------------------ */

type CmfProbe = { ok: boolean; ms: number; status?: number; error?: string }
type CmfHealth = { ok: boolean; db: string; sql: CmfProbe; rest: CmfProbe; checkedAt: string }

/**
 * The CMF databases this user may load into (GET /api/cmf/connections — the
 * enabled admin-created connections they are granted; there is no built-in
 * default), each checked live by GET /api/cmf/health: the CMF REST API (the
 * MES application server) and the CMF SQL database, separately. Checked when
 * the page opens and on "Check now" — these calls cross the VPN, so they are
 * not polled. `available` is how many enabled connections exist at all, so the
 * popover can say whether none was added or none is granted.
 */
function useCmfHealth(enabled: boolean) {
    const [rows, setRows] = React.useState<McpHealthServerView[] | null>(null)
    const [available, setAvailable] = React.useState<number>(0)
    const [checking, setChecking] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    const check = React.useCallback(async () => {
        if (!enabled) return
        setChecking(true)
        try {
            const res = await fetch("/api/cmf/connections", { headers: getAuthHeaders(), cache: "no-store" })
            if (!res.ok) {
                setError(`CMF connections unavailable (HTTP ${res.status})`)
                return
            }
            const { connections = [], available: total } = (await res.json()) as { connections?: { key: string; label: string }[]; available?: number }
            setAvailable(typeof total === "number" ? total : connections.length)
            const results = await Promise.all(
                connections.map(async (c): Promise<McpHealthServerView> => {
                    try {
                        const r = await fetch(`/api/cmf/health?db=${encodeURIComponent(c.key)}`, { headers: getAuthHeaders(), cache: "no-store" })
                        if (!r.ok) throw new Error(`HTTP ${r.status}`)
                        const h = (await r.json()) as CmfHealth
                        const problems = [
                            !h.rest.ok ? `CMF server: ${h.rest.error ?? "no answer"}` : "",
                            !h.sql.ok ? `Database: ${h.sql.error ?? "no answer"}` : "",
                        ].filter(Boolean)
                        return {
                            registryId: `cmf:${c.key}`,
                            name: c.label,
                            status: h.ok ? "healthy" : "down",
                            checkedAt: h.checkedAt,
                            server: h.rest.ok ? "up" : "down",
                            database: h.sql.ok ? "ok" : "failed",
                            ...(problems.length ? { error: problems.join(" · ") } : {}),
                        }
                    } catch (e) {
                        return {
                            registryId: `cmf:${c.key}`,
                            name: c.label,
                            status: "unknown",
                            checkedAt: null,
                            server: "not-checked",
                            database: "not-tested",
                            error: `Could not run the CMF check: ${e instanceof Error ? e.message : String(e)}`,
                        }
                    }
                }),
            )
            setRows(results)
            setError(null)
        } catch (e) {
            setError(e instanceof Error ? e.message : "CMF check failed")
        } finally {
            setChecking(false)
        }
    }, [enabled])

    React.useEffect(() => {
        void check()
    }, [check])
    return { rows, available, checking, error, check }
}

/* ------------------------------------------------------------------ */
/* The pill + popover                                                  */
/* ------------------------------------------------------------------ */

/** The pill's text and colour for a set of rows. */
function describe(rows: McpHealthServerView[] | null, loading: boolean, cmf = false): { status: McpHealthStatus; text: string } {
    if (!rows) return { status: "unknown", text: loading ? "Checking…" : "Status unavailable" }
    const n = rows.length
    if (n === 0) return { status: "unknown", text: cmf ? "No databases or servers" : "Nothing assigned" }
    const healthy = rows.filter((s) => s.status === "healthy").length
    if (healthy === n) return { status: "healthy", text: `All ${n} healthy` }
    const worst: McpHealthStatus = rows.some((s) => s.status === "down" || s.status === "degraded") ? "down" : "unknown"
    return { status: worst, text: `${healthy} of ${n} healthy` }
}

function SectionTitle({ children }: { children: React.ReactNode }) {
    return (
        <div className="mb-[6px] mt-[4px] text-[11px] font-bold uppercase tracking-[0.08em]" style={{ color: "var(--text-subtle)" }}>
            {children}
        </div>
    )
}

/**
 * `cmf`: also check the agent's CMF databases (the Master Data Load Agent
 * talks to CMF directly — REST + SQL — not through MCP).
 */
export function AgentMcpHealth({ agent, cmf = false, className }: { agent: AgentKey; cmf?: boolean; className?: string }) {
    const { summary, loading, error, checking, checkNow } = useMcpHealth({ intervalMs: 60000, agent })
    const cmfHealth = useCmfHealth(cmf)
    const view = summary?.agents.find((a) => a.agent === agent) ?? null
    const mcpRows = view?.servers ?? []
    const cmfRows = cmfHealth.rows ?? []
    const allRows = summary || cmfHealth.rows ? [...cmfRows, ...mcpRows] : null
    const pill = describe(allRows, loading || cmfHealth.checking, cmf)
    const c = STATUS_COLOURS[pill.status]
    const label = AGENT_LABELS[agent]
    const busy = checking || cmfHealth.checking
    const onCheck = () => {
        void checkNow()
        if (cmf) void cmfHealth.check()
    }
    const allView: McpHealthAgentView = { agent, label, status: pill.status, servers: allRows ?? [] }

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    data-testid="agent-mcp-health"
                    data-status={pill.status}
                    aria-label={`${label} MCP/DB Health: ${pill.text}. Open details`}
                    className={`inline-flex cursor-pointer items-center gap-[7px] rounded-full border px-[12px] py-[5px] text-[12px] font-semibold shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-indigo)] ${className ?? ""}`}
                    style={{ color: c.fg, background: c.bg, borderColor: "transparent" }}
                >
                    <Dot status={pill.status} />
                    <span style={{ color: "var(--text-ink)" }}>MCP/DB Health</span>
                    <span>· {pill.text}</span>
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="end"
                sideOffset={8}
                className="w-[640px] max-w-[calc(100vw-24px)] rounded-[14px] border p-0 shadow-[0_10px_30px_rgba(22,28,52,.12)]"
                style={{ borderColor: "var(--border-light)", background: "var(--pure-white)", color: "var(--text-ink)", lineHeight: "normal" }}
            >
                <div className="flex flex-wrap items-center justify-between gap-2 px-[16px] pb-[10px] pt-[14px]">
                    <div>
                        <div className="text-[14px] font-bold">{label} · MCP/DB Health</div>
                        <AutoCheckLine summary={summary} />
                    </div>
                    <div className="flex flex-wrap items-center gap-[8px]">
                        {allView.servers.length > 0 && <Totals view={allView} />}
                        <CheckNowButton checking={busy} onCheck={onCheck} />
                    </div>
                </div>
                <div className="flex max-h-[min(460px,70vh)] flex-col gap-[12px] overflow-y-auto px-[16px] pb-[14px]">
                    {cmf && (
                        <div>
                            <SectionTitle>CMF databases</SectionTitle>
                            {cmfHealth.rows === null ? (
                                <p className="text-[12.5px]" style={{ color: "var(--text-muted-cool)" }}>
                                    {cmfHealth.error
                                        ? `Status unavailable: ${cmfHealth.error}`
                                        : "Checking the CMF server and database… (a cold connection can take ~20 s)"}
                                </p>
                            ) : cmfRows.length === 0 ? (
                                <p className="text-[12.5px]" style={{ color: "var(--text-muted-cool)" }}>
                                    {cmfHealth.available === 0
                                        ? "No database connections have been added yet. An administrator adds them in Admin → Database Connections."
                                        : "No CMF databases are granted to you. Ask an administrator for access."}
                                </p>
                            ) : (
                                <ServerTable rows={cmfRows} serverHeader="CMF server" databaseHeader="Database (SQL)" />
                            )}
                        </div>
                    )}
                    <div>
                        {cmf && <SectionTitle>MCP servers</SectionTitle>}
                        {!summary ? (
                            <p className="text-[12.5px]" style={{ color: "var(--text-muted-cool)" }}>
                                {error ? `Status unavailable: ${error}` : "Checking your MCP servers…"}
                            </p>
                        ) : mcpRows.length === 0 ? (
                            <p className="text-[12.5px]" style={{ color: "var(--text-muted-cool)" }}>
                                No MCP servers are assigned to you for {label}.
                            </p>
                        ) : (
                            <ServerTable rows={mcpRows} serverHeader="MCP server" databaseHeader="Database" />
                        )}
                        {summary && error && (
                            <p className="pt-[6px] text-[10.5px]" style={{ color: "var(--status-amber)" }}>
                                Latest refresh failed: {error}. Showing the last known status.
                            </p>
                        )}
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    )
}
