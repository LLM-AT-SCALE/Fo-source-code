"use client"

import * as React from "react"

/**
 * Proactive client-side idle timer that mirrors the server's
 * `user_session_logs.last_activity_at` clock.
 *
 * The timer base is **the timestamp of the last authenticated API call**
 * (passed in via `lastApiCallRef.current`, bumped by the patched window.fetch
 * in providers.tsx on every successful authed request). The hook polls the
 * elapsed time and fires `onWarning` once when `elapsed >= warningAtMs`,
 * and `onExpire` once when `elapsed >= expireAtMs`. Both fire even if the
 * user is sitting idle — no DOM events required.
 *
 * Why callbacks live in a ref:
 *   In Providers.tsx the callbacks are inline arrow functions
 *   (`() => setWarningOpen(true)`, etc.). Inline arrows are fresh on every
 *   render, so if we put them in the useEffect dep array the interval is
 *   torn down and rebuilt on every Provider re-render. If Providers
 *   re-renders faster than `pollMs`, the timer never gets to fire.
 *
 *   The fix is the standard one: stash the callbacks in a ref that we
 *   update each render, and only depend on stable values
 *   (`enabled`, `pollMs`, `warningAtMs`, `expireAtMs`) so the interval is
 *   created once per `enabled` flip and stays alive.
 *
 * Visibility / focus re-check:
 *   `setInterval` is throttled (and frozen) in background tabs, so the
 *   28/30-min thresholds can be crossed without ticking. We re-run the
 *   check immediately on `visibilitychange→visible` and `focus`.
 */
export interface UseIdleTimeoutArgs {
  /** Mutable ref holding the last authed-API-call timestamp (ms). */
  lastApiCallRef: React.MutableRefObject<number>
  /** Skip the timer entirely (e.g., on the login page). */
  enabled: boolean
  /** Default 28 min — when the warning should fire. */
  warningAtMs?: number
  /** Default 30 min — when the expire modal should fire. */
  expireAtMs?: number
  /** Polling interval in ms. Default 5 s. */
  pollMs?: number
  onWarning?: () => void
  /** Called continuously while inside the warning window for live countdown. */
  onWarningTick?: (msRemaining: number) => void
  onExpire?: () => void
  /** Called when activity returns after a warning had been shown. */
  onActivityAfterWarning?: () => void
}

export function useIdleTimeout(args: UseIdleTimeoutArgs) {
  const {
    lastApiCallRef,
    enabled,
    warningAtMs = 28 * 60 * 1000,
    expireAtMs = 30 * 60 * 1000,
    pollMs = 5_000,
  } = args

  // Latest callbacks kept in a ref so the interval below is built once
  // and survives Provider re-renders. See header comment for why.
  const callbacksRef = React.useRef(args)
  callbacksRef.current = args

  const warnedRef = React.useRef(false)
  const expiredRef = React.useRef(false)

  React.useEffect(() => {
    if (!enabled) return

    const runCheck = () => {
      const elapsed = Date.now() - lastApiCallRef.current

      if (warnedRef.current && elapsed < warningAtMs) {
        warnedRef.current = false
        callbacksRef.current.onActivityAfterWarning?.()
      }

      if (!expiredRef.current && elapsed >= expireAtMs) {
        expiredRef.current = true
        callbacksRef.current.onExpire?.()
        return
      }

      if (!expiredRef.current && elapsed >= warningAtMs) {
        if (!warnedRef.current) {
          warnedRef.current = true
          callbacksRef.current.onWarning?.()
        }
        callbacksRef.current.onWarningTick?.(Math.max(0, expireAtMs - elapsed))
      }
    }

    runCheck()
    const interval = setInterval(runCheck, pollMs)

    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        runCheck()
      }
    }
    const onFocus = () => runCheck()

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible)
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus)
    }

    return () => {
      clearInterval(interval)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible)
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus)
      }
    }
  }, [enabled, lastApiCallRef, warningAtMs, expireAtMs, pollMs])

  const reset = React.useCallback(() => {
    lastApiCallRef.current = Date.now()
    warnedRef.current = false
    expiredRef.current = false
  }, [lastApiCallRef])

  return { reset }
}
