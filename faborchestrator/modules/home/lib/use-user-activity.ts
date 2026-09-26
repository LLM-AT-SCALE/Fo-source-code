"use client"

/**
 * useUserActivity — the cockpit's view of the signed-in user's own recent work
 * (GET /api/user/activity). One instance per page; pass the result down.
 * Never throws: a failed fetch keeps the last good value and sets `error`.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { getAuthHeaders } from "@/shared/lib/client-session"
import type { UserActivity } from "./activity-types"

export type UseUserActivityState = {
  activity: UserActivity | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

function isActivity(value: unknown): value is UserActivity {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.items) && typeof v.agents === "object" && typeof v.totals === "object"
}

export function useUserActivity({ intervalMs = 60000 }: { intervalMs?: number } = {}): UseUserActivityState {
  const [activity, setActivity] = useState<UserActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current
    try {
      const res = await fetch("/api/user/activity", { headers: getAuthHeaders(), cache: "no-store" })
      if (!alive.current || seq !== requestSeq.current) return
      if (!res.ok) {
        setError(`Activity unavailable (HTTP ${res.status})`)
        return
      }
      const data: unknown = await res.json().catch(() => null)
      if (!alive.current || seq !== requestSeq.current) return
      if (!isActivity(data)) {
        setError("Activity returned an unexpected response")
        return
      }
      setActivity(data)
      setError(null)
    } catch (e) {
      if (!alive.current || seq !== requestSeq.current) return
      setError(e instanceof Error ? e.message : "Activity unreachable")
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

  return { activity, loading, error, refresh }
}
