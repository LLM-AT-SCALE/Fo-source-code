"use client"

/**
 * useMcpHealth — the cockpit's view of MCP server health per agent.
 *
 * Fetches `GET /api/mcp/health` on mount and then every `intervalMs` while
 * the tab is visible (hidden tabs skip the tick; the next visibility change
 * refreshes at once). It never throws: a 404/500 or a network failure keeps
 * the last good summary and surfaces the reason in `error`.
 *
 * One instance per page — pass the summary down to the pill, the cards and
 * the nav rather than calling the hook in each of them.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { getAuthHeaders } from "@/shared/lib/client-session"
import type { McpHealthSummary } from "@/modules/mcp/lib/mcp-health-types"

export type UseMcpHealthOptions = {
  /** How often to poll while the tab is visible. Default 60 s. */
  intervalMs?: number
  /** Limit "Check now" to this agent's servers (the read still returns every agent). */
  agent?: string
}

export type UseMcpHealthState = {
  /** The last good summary, or null before the first successful fetch. */
  summary: McpHealthSummary | null
  /** True until the first fetch settles (success or failure). */
  loading: boolean
  /** Why the latest fetch failed; null after a successful one. */
  error: string | null
  /** Fetch now, regardless of the interval. */
  refresh: () => Promise<void>
  /** True while "Check now" is re-checking the user's servers. */
  checking: boolean
  /** Re-check the user's MCP servers now (POST /api/mcp/health) and show the result. */
  checkNow: () => Promise<void>
}

function isSummary(value: unknown): value is McpHealthSummary {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return typeof v.overall === "string" && Array.isArray(v.agents)
}

export function useMcpHealth({ intervalMs = 60000, agent }: UseMcpHealthOptions = {}): UseMcpHealthState {
  const [summary, setSummary] = useState<McpHealthSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Guards a late response from overwriting a newer one, and any response
  // from touching state after unmount.
  const requestSeq = useRef(0)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current
    try {
      const res = await fetch("/api/mcp/health", { headers: getAuthHeaders(), cache: "no-store" })
      if (!alive.current || seq !== requestSeq.current) return
      if (!res.ok) {
        setError(res.status === 404 ? "Health check not available" : `Health check failed (HTTP ${res.status})`)
        return
      }
      let data: unknown = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      if (!alive.current || seq !== requestSeq.current) return
      if (!isSummary(data)) {
        setError("Health check returned an unexpected response")
        return
      }
      setSummary(data)
      setError(null)
    } catch (e) {
      if (!alive.current || seq !== requestSeq.current) return
      setError(e instanceof Error ? e.message : "Health check unreachable")
    } finally {
      if (alive.current && seq === requestSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()

    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return
      void refresh()
    }
    const timer = setInterval(tick, Math.max(5000, intervalMs))
    const onVisibility = () => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      alive.current = false
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [refresh, intervalMs])

  const [checking, setChecking] = useState(false)
  const checkNow = useCallback(async () => {
    if (checking) return
    setChecking(true)
    // Invalidate any poll in flight so it cannot overwrite the fresh result.
    const seq = ++requestSeq.current
    try {
      const url = agent ? `/api/mcp/health?agent=${encodeURIComponent(agent)}` : "/api/mcp/health"
      const res = await fetch(url, { method: "POST", headers: getAuthHeaders(), cache: "no-store" })
      const data: unknown = await res.json().catch(() => null)
      if (!alive.current || seq !== requestSeq.current) return
      if (!res.ok || !isSummary(data)) {
        setError(`Check failed (HTTP ${res.status})`)
        return
      }
      setSummary(data)
      setError(null)
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Check failed")
    } finally {
      if (alive.current) setChecking(false)
    }
  }, [checking, agent])

  return { summary, loading, error, refresh, checking, checkNow }
}
