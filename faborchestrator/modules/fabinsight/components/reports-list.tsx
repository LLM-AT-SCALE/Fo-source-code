"use client"

/**
 * Recent Reports — search bar, grid/list toggle and the compact list view.
 *
 * The page (`app/reports/page.tsx`) owns the data, the filter text and the
 * chosen view; these pieces only render. The list view shows the same
 * dashboards as the card grid, one row each, with the same actions (open,
 * refresh, remove) so nothing an admin can do from a card is missing here.
 */

import { useEffect, useState, type KeyboardEvent, type RefObject } from "react"
import { LayoutGrid, List, RefreshCw, Search, Trash2, X } from "lucide-react"

/** One dashboard as `/api/fabinsight/pinned` returns it (plus optional extras). */
export type PinnedDashboard = {
  id: string
  title: string
  dashboardId: string
  kind?: string
  status?: string
  params?: Record<string, string>
  createdAt: string
  createdBy: string
  refreshedAt: string | null
  hasCache: boolean
  stale?: boolean
  expiresAt?: string | null
  perServerStatus?: Record<string, string>
  /** Present only when the API starts returning them — searched and shown when set. */
  description?: string | null
  summary?: string | null
  schedule?: string | null
  kpis?: Array<string | { label?: string; name?: string }> | null
  /** A pinned snapshot with no refresh program yet: static | preparing | setup_failed. */
  setup?: "static" | "preparing" | "setup_failed" | null
}

export type ReportsView = "grid" | "list"

export const REPORTS_VIEW_KEY = "llmatscale_reports_view"

export function kindLabel(p: PinnedDashboard): string {
  return p.kind === "seeded" ? "Standard dashboard" : "Custom dashboard"
}

export function kpiNames(p: PinnedDashboard): string[] {
  if (!Array.isArray(p.kpis)) return []
  return p.kpis
    .map((k) => (typeof k === "string" ? k : k?.label ?? k?.name ?? ""))
    .filter((s): s is string => typeof s === "string" && s.length > 0)
}

/** Case-insensitive match over every text a user might remember a dashboard by. */
export function matchesQuery(p: PinnedDashboard, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    p.title,
    p.description ?? "",
    p.summary ?? "",
    kindLabel(p),
    p.status ?? "",
    ...kpiNames(p),
  ]
    .join("\n")
    .toLowerCase()
  return haystack.includes(q)
}

/** Sort key shared by both views: most recently refreshed first, never-refreshed last. */
export function byRefreshedDesc(a: PinnedDashboard, b: PinnedDashboard): number {
  const ta = a.hasCache && a.refreshedAt ? Date.parse(a.refreshedAt) : NaN
  const tb = b.hasCache && b.refreshedAt ? Date.parse(b.refreshedAt) : NaN
  const aHas = !Number.isNaN(ta)
  const bHas = !Number.isNaN(tb)
  if (aHas && bHas && ta !== tb) return tb - ta
  if (aHas !== bHas) return aHas ? -1 : 1
  return Date.parse(b.createdAt) - Date.parse(a.createdAt)
}

/** "3 min ago", "2 h ago", "5 d ago" — coarse on purpose; the full stamp is on hover. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ""
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo} mo ago`
  return `${Math.round(mo / 12)} y ago`
}

const CARD_STYLE = {
  borderColor: "var(--border-light)",
  boxShadow: "0 2px 10px rgba(22,28,52,.05)",
} as const

/* ── Search + view toggle ─────────────────────────────────────────────── */

export function ReportsToolbar({
  query, onQueryChange, shown, total, view, onViewChange, inputRef,
}: {
  query: string
  onQueryChange: (q: string) => void
  shown: number
  total: number
  view: ReportsView
  onViewChange: (v: ReportsView) => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const segBtn = (v: ReportsView, label: string, IconCmp: typeof LayoutGrid) => {
    const active = view === v
    return (
      <button
        type="button"
        aria-pressed={active}
        aria-label={`${label} view`}
        title={`${label} view`}
        onClick={() => onViewChange(v)}
        className="flex h-[30px] w-[34px] items-center justify-center rounded-[7px] transition-colors"
        style={active
          ? { background: "#fff", color: "var(--brand-indigo)", boxShadow: "0 1px 3px rgba(22,28,52,.12)" }
          : { color: "var(--text-muted-cool)" }}
      >
        <IconCmp className="h-[15px] w-[15px]" strokeWidth={2} aria-hidden="true" />
      </button>
    )
  }

  return (
    <div className="mb-[16px] flex flex-wrap items-center gap-[10px]">
      <div className="relative min-w-[220px] flex-1 sm:max-w-[420px]">
        <Search
          className="pointer-events-none absolute left-[11px] top-1/2 h-[15px] w-[15px] -translate-y-1/2"
          style={{ color: "var(--text-subtle)" }}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); onQueryChange("") } }}
          placeholder="Search dashboards…"
          aria-label="Search dashboards"
          className="h-[36px] w-full rounded-[9px] border bg-white pl-[34px] pr-[34px] text-[13px] outline-none transition-[box-shadow,border-color] placeholder:text-[var(--text-subtle)] focus:border-[var(--brand-indigo)] focus:shadow-[0_0_0_3px_var(--brand-indigo-bg)] [&::-webkit-search-cancel-button]:hidden"
          style={{ borderColor: "var(--border-light)", color: "var(--text-ink)" }}
        />
        {query && (
          <button
            type="button"
            onClick={() => { onQueryChange(""); inputRef.current?.focus() }}
            aria-label="Clear search"
            title="Clear search"
            className="absolute right-[7px] top-1/2 flex h-[22px] w-[22px] -translate-y-1/2 items-center justify-center rounded-[6px] transition-colors hover:bg-[var(--brand-indigo-bg)]"
            style={{ color: "var(--text-muted-cool)" }}
          >
            <X className="h-[13px] w-[13px]" aria-hidden="true" />
          </button>
        )}
      </div>

      <span className="text-[12.5px] tabular-nums" style={{ color: "var(--text-muted-cool)" }} aria-live="polite">
        {shown} of {total} {total === 1 ? "dashboard" : "dashboards"}
      </span>

      <div
        role="group"
        aria-label="View"
        className="ml-auto flex items-center gap-[2px] rounded-[9px] border p-[2px]"
        style={{ borderColor: "var(--border-light)", background: "var(--cockpit-surface)" }}
      >
        {segBtn("grid", "Grid", LayoutGrid)}
        {segBtn("list", "List", List)}
      </div>
    </div>
  )
}

/* ── No-match state ───────────────────────────────────────────────────── */

export function ReportsNoMatch({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="rounded-2xl border bg-white px-6 py-[42px] text-center" style={CARD_STYLE}>
      <Search className="mx-auto mb-[10px] h-[22px] w-[22px]" style={{ color: "var(--text-subtle)" }} aria-hidden="true" />
      <p className="text-[14.5px] font-bold">No dashboards match “{query.trim()}”</p>
      <p className="mx-auto mt-[6px] max-w-[440px] text-[12.5px] leading-[1.5]" style={{ color: "var(--text-muted-cool)" }}>
        Try a different word from the title, its type or status.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-[14px] rounded-[9px] border bg-white px-[11px] py-[7px] text-[12.5px] font-semibold transition-colors hover:bg-[var(--brand-indigo-bg)]"
        style={{ ...CARD_STYLE, color: "var(--brand-indigo)" }}
      >
        Clear search
      </button>
    </div>
  )
}

/* ── List view ────────────────────────────────────────────────────────── */

function StatusPill({ status }: { status?: string }) {
  const s = (status || "live").toLowerCase()
  const tone = s === "live"
    ? { color: "var(--status-success-foreground)", background: "var(--status-success-muted)" }
    : s === "paused"
      ? { color: "var(--status-warning-foreground)", background: "var(--status-warning-muted)" }
      : { color: "var(--text-muted-cool)", background: "var(--cockpit-surface)" }
  return (
    <span className="inline-flex items-center gap-[5px] rounded-full px-[8px] py-[2px] text-[10.5px] font-bold capitalize tracking-[0.02em]" style={tone}>
      <span className="h-[6px] w-[6px] rounded-full" style={{ background: "currentColor" }} aria-hidden="true" />
      {s}
    </span>
  )
}

function KindBadge({ p }: { p: PinnedDashboard }) {
  return (
    <span
      className="inline-flex whitespace-nowrap rounded-[6px] px-[7px] py-[2px] text-[9.5px] font-bold uppercase tracking-[0.1em]"
      style={{ color: "var(--brand-indigo)", background: "var(--brand-indigo-bg)" }}
    >
      {p.kind === "seeded" ? "standard" : "custom"}
    </span>
  )
}

const ROW_COLS =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[14px] md:grid-cols-[minmax(0,1fr)_84px_82px_130px_120px_56px_auto]"

export function ReportsListView({
  items, canManage, tz, onOpen, onRefresh, onRemove, formatStamp,
}: {
  items: PinnedDashboard[]
  canManage: boolean
  tz: string
  onOpen: (p: PinnedDashboard) => void
  onRefresh: (p: PinnedDashboard) => void
  onRemove: (p: PinnedDashboard) => void
  formatStamp: (iso: string | null | undefined, tz: string) => string
}) {
  // Re-render every minute so "3 min ago" keeps up without a reload.
  const [, bump] = useState(0)
  useEffect(() => {
    const t = setInterval(() => bump((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const iconBtn =
    "flex h-[28px] w-[28px] items-center justify-center rounded-[7px] transition-colors hover:bg-[var(--brand-indigo-bg)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--brand-indigo)] disabled:opacity-50"

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, p: PinnedDashboard) => {
    if (e.target !== e.currentTarget) return
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(p) }
  }

  return (
    <div className="overflow-hidden rounded-2xl border bg-white" style={CARD_STYLE} role="list" aria-label="Pinned dashboards">
      <div
        className={`${ROW_COLS} hidden border-b px-[16px] py-[9px] text-[10px] font-bold uppercase tracking-[0.12em] md:grid`}
        style={{ borderColor: "var(--border-light)", color: "var(--text-subtle)", background: "var(--page-surface)" }}
        aria-hidden="true"
      >
        <span>Dashboard</span>
        <span>Type</span>
        <span>Status</span>
        <span>Last refreshed</span>
        <span>Schedule</span>
        <span className="text-right">KPIs</span>
        <span className="text-right">Actions</span>
      </div>

      {items.map((p, i) => {
        const refreshed = p.hasCache && p.refreshedAt ? p.refreshedAt : null
        const kpis = kpiNames(p)
        return (
          <div
            key={p.id}
            role="listitem"
            tabIndex={0}
            onKeyDown={(e) => onRowKey(e, p)}
            onClick={() => onOpen(p)}
            className={`${ROW_COLS} group cursor-pointer px-[16px] py-[11px] transition-colors hover:bg-[var(--page-surface)] focus-visible:bg-[var(--page-surface)] focus-visible:outline-none ${i > 0 ? "border-t" : ""}`}
            style={{ borderColor: "var(--border-light)" }}
          >
            {/* Title + mobile meta */}
            <div className="min-w-0">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpen(p) }}
                className="block max-w-full truncate text-left text-[13.5px] font-bold transition-colors hover:text-[var(--cockpit-indigo)] focus-visible:outline-none"
                style={{ color: "var(--text-ink)" }}
                title={p.title}
              >
                {p.title}
              </button>
              <div className="mt-[3px] flex flex-wrap items-center gap-x-[8px] gap-y-[3px] text-[11.5px]" style={{ color: "var(--text-muted-cool)" }}>
                <span className="md:hidden"><KindBadge p={p} /></span>
                <span className="md:hidden"><StatusPill status={p.status} /></span>
                <span className="truncate">Pinned by {p.createdBy}</span>
                {p.expiresAt && <span>· Expires {formatStamp(p.expiresAt, tz)}</span>}
                {p.stale && (
                  <span style={{ color: "var(--status-red, #d33)", fontWeight: 600 }}>· ⚠ Last refresh failed</span>
                )}
                <span className="md:hidden">
                  · {refreshed ? `Refreshed ${relativeTime(refreshed)}` : "Not yet refreshed"}
                </span>
              </div>
            </div>

            <div className="hidden md:block"><KindBadge p={p} /></div>
            <div className="hidden md:block"><StatusPill status={p.status} /></div>

            <div className="hidden text-[12.5px] md:block" style={{ color: refreshed ? "var(--text-ink)" : "var(--text-subtle)" }}>
              {refreshed ? (
                <time dateTime={refreshed} title={formatStamp(refreshed, tz)}>{relativeTime(refreshed)}</time>
              ) : (
                "Not yet refreshed"
              )}
            </div>

            <div className="hidden truncate text-[12.5px] md:block" style={{ color: p.schedule ? "var(--text-ink)" : "var(--text-subtle)" }}
              title={p.schedule ?? undefined}>
              {p.schedule || "—"}
            </div>

            <div className="hidden text-right text-[12.5px] tabular-nums md:block" style={{ color: kpis.length ? "var(--text-ink)" : "var(--text-subtle)" }}
              title={kpis.length ? kpis.join(", ") : undefined}>
              {kpis.length ? kpis.length : "—"}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-[2px]" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => onOpen(p)}
                aria-label={`Open ${p.title}`}
                title="Open"
                className={iconBtn}
                style={{ color: "var(--brand-indigo)" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => onRefresh(p)}
                aria-label={`Refresh ${p.title}`}
                title="Refresh (live data)"
                className={iconBtn}
                style={{ color: "var(--text-muted-cool)" }}
              >
                <RefreshCw className="h-[14px] w-[14px]" aria-hidden="true" />
              </button>
              {canManage && (
                <button
                  type="button"
                  onClick={() => onRemove(p)}
                  aria-label={`Remove ${p.title}`}
                  title="Remove from Recent Reports"
                  className={iconBtn}
                  style={{ color: "var(--text-muted-cool)" }}
                >
                  <Trash2 className="h-[14px] w-[14px]" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
