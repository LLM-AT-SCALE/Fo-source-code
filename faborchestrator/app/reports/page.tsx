"use client"

/**
 * Recent Reports — the pinned dashboards section.
 *
 * Readable by every role; dashboards are pinned from a chat dashboard (Pin), and
 * only an admin can remove one. Opening a report shows its shared snapshot;
 * Refresh replays it for live data. `?d=<id>` opens one report directly (the Pin
 * dialog lands here). A pinned snapshot that is static, or whose automatic
 * refresh is still being set up, says so instead of offering Refresh.
 *
 * Uses the cockpit shell (nav, Plus Jakarta Sans, 1180px column, card tokens)
 * so it reads as part of FabOrchestrator rather than a bolted-on page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { CockpitNav } from "@/modules/home/components/cockpit-nav"
import { COCKPIT_FONT } from "@/modules/home/components/cockpit-page"
import { PageLoadingSkeleton } from "@/shared/components/ui/skeleton-loaders"
import { listTimezones, browserTz } from "@/shared/lib/timezones"
import { PIN_SETUP_TEXT } from "@/modules/fabinsight/lib/pin/options"
import type { AuthedUser } from "@/modules/home/components/types"
import {
  ReportsListView, ReportsNoMatch, ReportsToolbar, REPORTS_VIEW_KEY,
  byRefreshedDesc, matchesQuery,
  type PinnedDashboard, type ReportsView,
} from "@/modules/fabinsight/components/reports-list"

type Pinned = PinnedDashboard

const AUTH_TOKEN_KEY = "llmatscale_auth_token"

function authHeaders(): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

const TZ_STORAGE_KEY = "fabinsight_reports_tz"

/** Timestamp formatted in the chosen timezone, with a short tz label (e.g. GMT+5:30). */
function formatStamp(iso: string | null | undefined, tz: string): string {
  if (!iso) return ""
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: tz, timeZoneName: "short",
    })
  } catch {
    return ""
  }
}

function Icon({ d, className = "h-[15px] w-[15px]" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const CARD_STYLE = {
  borderColor: "var(--border-light)",
  boxShadow: "0 2px 10px rgba(22,28,52,.05)",
} as const

export default function ReportsPage() {
  const router = useRouter()
  const [user, setUser] = useState<AuthedUser | null>(null)
  const [ready, setReady] = useState(false)

  const [items, setItems] = useState<Pinned[]>([])
  const [canManage, setCanManage] = useState(false)
  const [canPin, setCanPin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [open, setOpen] = useState<Pinned | null>(null)
  const [openSetup, setOpenSetup] = useState<Pinned["setup"]>(null)
  const [html, setHtml] = useState("")
  const [rendering, setRendering] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [refreshedAtIso, setRefreshedAtIso] = useState<string | null>(null)
  // Timezone the times are shown in. Default UTC on first render (avoids a
  // hydration mismatch), then switch to the viewer's saved choice or local tz.
  const [tz, setTz] = useState<string>("UTC")
  useEffect(() => {
    try { setTz(localStorage.getItem(TZ_STORAGE_KEY) || browserTz()) } catch { setTz(browserTz()) }
  }, [])
  const changeTz = (v: string) => { setTz(v); try { localStorage.setItem(TZ_STORAGE_KEY, v) } catch {} }
  const tzOptions = listTimezones()
  const [isLive, setIsLive] = useState(false)
  const [noSnapshot, setNoSnapshot] = useState(false)

  // Search + grid/list view. The view is remembered per browser; read it after
  // mount so the server and first client render agree (default grid).
  const [query, setQuery] = useState("")
  const [view, setView] = useState<ReportsView>("list")
  const searchRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(REPORTS_VIEW_KEY)
      if (saved === "grid" || saved === "list") setView(saved)
    } catch {}
  }, [])
  const changeView = (v: ReportsView) => { setView(v); try { localStorage.setItem(REPORTS_VIEW_KEY, v) } catch {} }

  // `/` focuses the search (unless typing elsewhere); Escape clears it.
  useEffect(() => {
    if (open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === "Escape" && (!typing || el === searchRef.current)) {
        setQuery("")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  const filtered = useMemo(
    () => items.filter((p) => matchesQuery(p, query)).sort(byRefreshedDesc),
    [items, query],
  )

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!localStorage.getItem(AUTH_TOKEN_KEY)) { router.replace("/"); return }
    fetch("/api/auth/me", { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setUser(j?.user ?? null))
      .catch(() => {})
      .finally(() => setReady(true))
  }, [router])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/fabinsight/pinned", { headers: authHeaders() })
      if (res.status === 401) { router.replace("/"); return }
      const raw = await res.text()
      const json = raw ? JSON.parse(raw) : {}
      setItems(json.dashboards ?? [])
      setCanManage(!!json.canManage)
      setCanPin(!!json.canPin)
      setError(null)
    } catch {
      setError("Could not load pinned dashboards.")
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => { void load() }, [load])

  /** Refresh button — a fresh LIVE query, bypassing the cached snapshot. */
  const renderPinned = useCallback(async (p: Pinned) => {
    setRendering(true)
    setRenderError(null)
    setNoSnapshot(false)
    try {
      // Every dashboard is a replay program now: re-run it through the MCP
      // client and update the shared snapshot everyone sees.
      const res = await fetch(`/api/fabinsight/pinned/${p.id}/refresh`, { method: "POST", headers: authHeaders() })
      const raw = await res.text()
      const json = raw ? (JSON.parse(raw) as { html?: string; refreshedAt?: string; error?: string }) : {}
      if (!res.ok) throw new Error(json.error ?? `Could not load live data (${res.status}).`)
      setHtml(json.html ?? "")
      setRefreshedAtIso(json.refreshedAt ?? new Date().toISOString())
      setIsLive(true)
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : "Could not load live data.")
      setHtml("")
    } finally {
      setRendering(false)
    }
  }, [])

  /**
   * Open — show ONLY the shared scheduled SNAPSHOT (cached HTML). Opening a
   * report NEVER hits the MES; live data is fetched exclusively by the Refresh
   * button. A pin with no snapshot yet (brand-new, before its first scheduled
   * run) shows a "not refreshed yet" prompt rather than auto-querying live.
   */
  const openReport = useCallback(async (p: Pinned) => {
    setOpen(p); setHtml(""); setRefreshedAtIso(null); setRenderError(null); setIsLive(false); setNoSnapshot(false)
    setOpenSetup(p.setup ?? null)
    setRendering(true)
    try {
      const res = await fetch(`/api/fabinsight/pinned/${p.id}`, { headers: authHeaders() })
      const raw = await res.text()
      const json = raw ? (JSON.parse(raw) as { html?: string | null; refreshedAt?: string | null; setup?: Pinned["setup"] }) : {}
      if (res.ok) setOpenSetup(json.setup ?? null)
      if (res.ok && json.html) {
        setHtml(json.html)
        setRefreshedAtIso(json.refreshedAt ?? null)
        setIsLive(false)
      } else {
        // No snapshot yet — do NOT auto-refresh live; wait for the button.
        setNoSnapshot(true)
      }
    } catch {
      setNoSnapshot(true)
    } finally {
      setRendering(false)
    }
  }, [])

  // `/reports?d=<id>` opens that report once the list is in (the Pin dialog
  // sends an admin here straight after pinning).
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current || loading || typeof window === "undefined") return
    const id = new URLSearchParams(window.location.search).get("d")
    if (!id) return
    deepLinked.current = true
    const hit = items.find((p) => p.id === id || p.dashboardId === id)
    if (hit) void openReport(hit)
  }, [items, loading, openReport])

  // Leaving a report drops `?d=` so a reload shows the list.
  const closeReport = useCallback(() => {
    setOpen(null)
    if (typeof window !== "undefined" && window.location.search.includes("d=")) {
      window.history.replaceState(null, "", window.location.pathname)
    }
  }, [])

  // While automatic refresh is being set up, check back every 15 s and swap in
  // the refreshed dashboard as soon as it is ready.
  useEffect(() => {
    if (!open || openSetup !== "preparing") return
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/fabinsight/pinned/${open.id}`, { headers: authHeaders() })
        if (!res.ok) return
        const json = (await res.json()) as { html?: string | null; refreshedAt?: string | null; setup?: Pinned["setup"] }
        if ((json.setup ?? null) === "preparing") return
        setOpenSetup(json.setup ?? null)
        if (json.html) { setHtml(json.html); setRefreshedAtIso(json.refreshedAt ?? null); setIsLive(false) }
        void load()
      } catch { /* try again on the next tick */ }
    }, 15_000)
    return () => clearInterval(t)
  }, [open, openSetup, load])

  /** Refresh from the list: open the report and run the live query right away. */
  const refreshFromList = useCallback((p: Pinned) => {
    setOpen(p); setHtml(""); setRefreshedAtIso(null); setRenderError(null); setIsLive(false); setNoSnapshot(false)
    void renderPinned(p)
  }, [renderPinned])

  const remove = useCallback(async (p: Pinned) => {
    if (!confirm(`Remove “${p.title}” from Recent Reports?`)) return
    const res = await fetch(`/api/fabinsight/pinned/${p.id}`, { method: "DELETE", headers: authHeaders() })
    if (res.ok) {
      setItems((prev) => prev.filter((x) => x.id !== p.id))
      if (open?.id === p.id) setOpen(null)
    } else {
      const raw = await res.text()
      alert((raw ? JSON.parse(raw).error : null) ?? "Could not remove this dashboard.")
    }
  }, [open])

  const download = useCallback(() => {
    if (!html || !open) return
    const blob = new Blob([html], { type: "text/html" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${open.title.replace(/[^\w-]+/g, "-").toLowerCase()}.html`
    a.click()
    URL.revokeObjectURL(url)
  }, [html, open])

  const subtitle = (p: Pinned) => {
    const bits = [p.kind === "seeded" ? "Standard dashboard" : "Custom dashboard"]
    if (p.expiresAt) bits.push(`expires ${formatStamp(p.expiresAt, tz)}`)
    return bits.join(" · ")
  }

  const btn = "flex items-center gap-[6px] rounded-[9px] border px-[11px] py-[7px] text-[12.5px] font-semibold transition-colors disabled:opacity-50"

  const tzSelect = (
    <label className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-muted-cool)" }}>
      <span>Times in</span>
      <select
        value={tz}
        onChange={(e) => changeTz(e.target.value)}
        className="rounded-[7px] border px-2 py-[5px] text-[12px] font-medium"
        style={{ borderColor: "var(--border-light)", background: "#fff", color: "var(--text-ink)" }}
      >
        {tzOptions.map((z) => (
          <option key={z.value} value={z.value}>{z.label}</option>
        ))}
      </select>
    </label>
  )

  if (!ready) return <PageLoadingSkeleton />

  return (
    <div
      className="cockpit-v2 h-full overflow-y-auto"
      style={{ fontFamily: COCKPIT_FONT, background: "var(--page-surface)", color: "var(--text-ink)", lineHeight: "normal" }}
    >
      <CockpitNav user={user} />

      <div className="mx-auto w-full max-w-[1180px] px-[26px] pb-[48px] pt-[38px]">
        {open ? (
          <>
            {/* ── One report, live ─────────────────────────────────────── */}
            <button onClick={closeReport}
              className="mb-[14px] flex items-center gap-[5px] text-[13px] font-semibold"
              style={{ color: "var(--brand-indigo)" }}>
              <Icon d="M15 18l-6-6 6-6" className="h-[14px] w-[14px]" /> All reports
            </button>

            <div className="mb-[18px] flex flex-wrap items-end gap-[11px]">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[22px] font-extrabold tracking-[-0.4px]">{open.title}</h1>
                <p className="mt-[3px] text-[12.5px] capitalize" style={{ color: "var(--text-muted-cool)" }}>
                  {subtitle(open)}
                  {refreshedAtIso && (
                    <span className="normal-case">
                      {" · "}{isLive ? "Live" : "Snapshot"} · Last refreshed {formatStamp(refreshedAtIso, tz)}
                    </span>
                  )}
                </p>
                {openSetup && (
                  <p className="mt-[4px] flex items-center gap-[6px] text-[12px] font-semibold"
                    style={{ color: openSetup === "setup_failed" ? "var(--status-red, #d33)" : "var(--brand-indigo)" }}>
                    {openSetup === "preparing" && (
                      <Icon d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" className="h-[12px] w-[12px] animate-spin" />
                    )}
                    {PIN_SETUP_TEXT[openSetup]}
                  </p>
                )}
                {open.stale && (
                  <p className="mt-[4px] text-[12px] font-semibold" style={{ color: "var(--status-red, #d33)" }}>
                    ⚠ Last scheduled refresh failed — showing the previous snapshot
                  </p>
                )}
              </div>
              {!openSetup && (
                <button onClick={() => void renderPinned(open)} disabled={rendering}
                  className={btn} style={{ ...CARD_STYLE, background: "#fff" }}>
                  <Icon d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" className={`h-[14px] w-[14px] ${rendering ? "animate-spin" : ""}`} />
                  {rendering ? "Refreshing…" : "Refresh"}
                </button>
              )}
              <button onClick={download} disabled={!html} className={btn} style={{ ...CARD_STYLE, background: "#fff" }}>
                <Icon d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" className="h-[14px] w-[14px]" /> Download
              </button>
              {canManage && (
                <button onClick={() => void remove(open)} className={btn}
                  style={{ ...CARD_STYLE, background: "#fff", color: "var(--status-red, #d33)" }}>
                  <Icon d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" className="h-[14px] w-[14px]" /> Remove
                </button>
              )}
              <div className="w-full sm:w-auto">{tzSelect}</div>
            </div>

            <div className="overflow-hidden rounded-2xl border bg-white" style={CARD_STYLE}>
              {rendering && !html && (
                <div className="flex h-[520px] items-center justify-center text-[13px]" style={{ color: "var(--text-muted-cool)" }}>
                  {isLive ? "Querying live manufacturing data…" : "Loading snapshot…"}
                </div>
              )}
              {noSnapshot && !rendering && !html && !renderError && (
                <div className="flex h-[520px] flex-col items-center justify-center gap-[6px] px-6 text-center">
                  <p className="text-[13.5px] font-bold">No snapshot yet</p>
                  <p className="text-[12.5px]" style={{ color: "var(--text-muted-cool)" }}>
                    This report hasn’t been refreshed yet. Click <span className="font-semibold">Refresh</span> to load live data.
                  </p>
                </div>
              )}
              {renderError && (
                <div className="flex h-[520px] flex-col items-center justify-center gap-[6px] px-6 text-center">
                  <p className="text-[13.5px] font-bold">{renderError}</p>
                  <p className="text-[12.5px]" style={{ color: "var(--text-muted-cool)" }}>
                    The report is still saved — try refreshing in a moment.
                  </p>
                </div>
              )}
              {html && (
                <iframe srcDoc={html} title={open.title} className="h-[calc(100vh-260px)] min-h-[520px] w-full border-0"
                  sandbox="allow-same-origin allow-scripts" />
              )}
            </div>
          </>
        ) : (
          <>
            {/* ── The list ─────────────────────────────────────────────── */}
            <button type="button" onClick={() => router.push("/chat")}
              className="mb-[14px] flex items-center gap-[5px] text-[13px] font-semibold"
              style={{ color: "var(--brand-indigo)" }}>
              <Icon d="M15 18l-6-6 6-6" className="h-[14px] w-[14px]" /> Back to chat
            </button>

            <div className="mb-[18px] flex items-center gap-[11px]">
              <span className="text-[18px] font-extrabold tracking-[-0.3px]">Recent Reports</span>
              <span className="rounded-[7px] px-[9px] py-[3px] text-[10.5px] font-bold tracking-[0.06em]"
                style={{ color: "var(--brand-indigo)", background: "var(--brand-indigo-bg)" }}>
                {items.length} PINNED
              </span>
              <div className="ml-auto">{tzSelect}</div>
            </div>
            <p className="mb-[22px] text-[12.5px]" style={{ color: "var(--text-muted-cool)" }}>
              Dashboards pinned from the chat. Scheduled reports refresh automatically — opening shows the latest
              shared snapshot; use Refresh inside a report for live data. Static reports keep the snapshot taken when
              they were pinned.
            </p>

            {loading && <p className="text-[13px]" style={{ color: "var(--text-muted-cool)" }}>Loading…</p>}
            {error && <p className="text-[13px] font-semibold" style={{ color: "var(--status-red, #d33)" }}>{error}</p>}

            {!loading && !error && items.length === 0 && (
              <div className="rounded-2xl border bg-white px-6 py-[54px] text-center" style={CARD_STYLE}>
                <div className="mx-auto mb-[14px] flex h-[42px] w-[42px] items-center justify-center rounded-xl text-white"
                  style={{ background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))", boxShadow: "0 5px 14px rgba(91,84,232,.3)" }}>
                  <Icon d="M6 20V13M12 20V8M18 20V11" className="h-[19px] w-[19px]" />
                </div>
                <p className="text-[15px] font-bold">No pinned dashboards yet</p>
                <p className="mx-auto mt-[6px] max-w-[440px] text-[12.5px] leading-[1.5]" style={{ color: "var(--text-muted-cool)" }}>
                  {canManage || canPin
                    ? "Generate a dashboard in the chat, then choose Pin in the dashboard panel to save it here."
                    : "No dashboards have been shared with you yet. Once they are, they appear here."}
                </p>
              </div>
            )}

            {!loading && !error && items.length > 0 && (
              <ReportsToolbar
                query={query}
                onQueryChange={setQuery}
                shown={filtered.length}
                total={items.length}
                view={view}
                onViewChange={changeView}
                inputRef={searchRef}
              />
            )}

            {!loading && !error && items.length > 0 && filtered.length === 0 && (
              <ReportsNoMatch query={query} onClear={() => { setQuery(""); searchRef.current?.focus() }} />
            )}

            {view === "list" && filtered.length > 0 && (
              <ReportsListView
                items={filtered}
                canManage={canManage}
                tz={tz}
                onOpen={openReport}
                onRefresh={refreshFromList}
                onRemove={(p) => void remove(p)}
                formatStamp={formatStamp}
              />
            )}

            {view === "grid" && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((p) => (
                <div key={p.id} onClick={() => openReport(p)}
                  className="group flex cursor-pointer flex-col rounded-2xl border bg-white p-[18px] transition-all hover:-translate-y-[3px]"
                  style={CARD_STYLE}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-[9.5px] font-bold tracking-[0.14em]" style={{ color: "var(--text-subtle)" }}>
                      LIVE REPORT
                    </div>
                    {canManage && (
                      <button onClick={(e) => { e.stopPropagation(); void remove(p) }} aria-label={`Remove ${p.title}`}
                        className="rounded p-1 opacity-0 transition group-hover:opacity-100"
                        style={{ color: "var(--text-muted-cool)" }}>
                        <Icon d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" className="h-[14px] w-[14px]" />
                      </button>
                    )}
                  </div>

                  <div className="my-[10px] mb-[14px] flex h-[42px] w-[42px] items-center justify-center rounded-xl text-white"
                    style={{ background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))", boxShadow: "0 5px 14px rgba(91,84,232,.3)" }}>
                    <Icon d="M6 20V13M12 20V8M18 20V11" className="h-[19px] w-[19px]" />
                  </div>

                  <div className="text-[16px] font-bold leading-[1.25]">{p.title}</div>
                  <div className="mt-[3px] text-[9.5px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--brand-indigo)" }}>
                    {p.kind === "seeded" ? "standard" : "custom"}
                  </div>
                  <div className="mt-2.5 min-h-[36px] text-[12.5px] leading-[1.5]" style={{ color: "var(--text-muted-cool)" }}>
                    {p.expiresAt ? `Expires ${formatStamp(p.expiresAt, tz)}` : "No expiry"}
                    {" · "}Pinned by {p.createdBy}
                    <br />
                    {p.hasCache && p.refreshedAt
                      ? `Refreshed ${formatStamp(p.refreshedAt, tz)}`
                      : "Not yet refreshed"}
                    {p.stale && (
                      <>
                        <br />
                        <span style={{ color: "var(--status-red, #d33)", fontWeight: 600 }}>
                          ⚠ Last refresh failed — showing previous snapshot
                        </span>
                      </>
                    )}
                  </div>

                  <div className="mt-[14px] flex items-center gap-1.5 text-[13px] font-bold transition-colors group-hover:text-[var(--cockpit-indigo)]"
                    style={{ color: "var(--brand-indigo)" }}>
                    Open <Icon d="M9 6l6 6-6 6" className="h-[13px] w-[13px]" />
                  </div>
                </div>
              ))}
            </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
