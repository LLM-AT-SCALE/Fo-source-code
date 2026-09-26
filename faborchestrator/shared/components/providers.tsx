"use client"

import * as React from "react"
import { MotionConfig } from "motion/react"
import { ErrorBoundary } from "./error-boundary"
import { SessionExpiredModal } from "./session-expired-modal"
import { SessionWarningBanner } from "./session-warning-banner"
import { useIdleTimeout } from "@/shared/hooks/use-idle-timeout"

interface ProvidersProps {
  children: React.ReactNode
}

const TWO_MIN_MS = 2 * 60 * 1000

/**
 * Global providers wrapper component
 * Includes error boundary, theme provider, idle timer, and global UX
 * for the session-expired flow (warning banner + full-screen modal).
 */
export function Providers({ children }: ProvidersProps) {
  const [sessionExpired, setSessionExpired] = React.useState(false)
  const [warningOpen, setWarningOpen] = React.useState(false)
  const [warningRemainingMs, setWarningRemainingMs] = React.useState(TWO_MIN_MS)
  const lastApiCallRef = React.useRef<number>(Date.now())
  const isOnLoginPage =
    typeof window !== "undefined" && window.location.pathname === "/"

  // Reset banner/modal state whenever we land on the login page. The
  // Providers component is in app/layout.tsx and stays mounted across
  // page transitions, so a soft navigation from /chat → / (e.g. clicking
  // the sidebar Logout button while the 28-min warning was open) would
  // otherwise leave `warningOpen` or `sessionExpired` stuck at true on
  // the login page.
  React.useEffect(() => {
    if (!isOnLoginPage) return
    setWarningOpen(false)
    setSessionExpired(false)
    setWarningRemainingMs(TWO_MIN_MS)
  }, [isOnLoginPage])

  // Helper — atomic "log this client out now" so every code path
  // (server 401, client clock, modal redirect) does the same thing in
  // the same order: clear storage first, then surface the modal. The
  // order matters: if we set the modal state but leave the token in
  // localStorage, a stray fetch that sneaks through the wrapper would
  // still authenticate.
  const markSessionExpired = React.useCallback(() => {
    try {
      localStorage.removeItem("llmatscale_auth_token")
      localStorage.removeItem("llmatscale_auth_session")
      localStorage.removeItem("llmatscale_user")
    } catch {/* ignore */}
    setWarningOpen(false)
    setSessionExpired(true)
  }, [])

  // Patch window.fetch — three jobs:
  // 1. Stamp `lastApiCallRef.current` on every successful authed request
  //    so the proactive client timer stays aligned with the server clock.
  // 2. Detect ANY 401 on an authed call → log the client out immediately.
  //    Previously we only treated SESSION_TIMEOUT-envelope 401s as session
  //    expiry; that left non-envelope 401s (e.g. token-not-found, race
  //    conditions, body-already-consumed responses) silently ignored, so
  //    the user kept seeing "logged in" UX after eviction.
  // 3. Suppress all subsequent authed fetches once we've decided the
  //    session is dead — keeps the chat from spamming 401s and prevents
  //    fetch-wrapper-bypassing transports from re-arming the user.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    if (isOnLoginPage) return

    const original = window.fetch.bind(window)
    let triggered = false

    const detectAuth = (args: Parameters<typeof fetch>): boolean => {
      try {
        const init = (args[1] || {}) as RequestInit
        const headers = new Headers(init.headers)
        if (headers.has("Authorization")) return true
        if (
          typeof args[0] === "object" &&
          args[0] !== null &&
          "headers" in args[0] &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (args[0] as any).headers?.has?.("Authorization")
        ) return true
      } catch {/* ignore */}
      return false
    }

    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const hasAuth = detectAuth(args)

      // Once expired, short-circuit any further authed fetches with a
      // synthetic 401 so transports (like the AI SDK) see a clean error
      // instead of a real server response that might re-authenticate.
      if (triggered && hasAuth) {
        return new Response(
          JSON.stringify({ error: { type: "SESSION_TIMEOUT", message: "Session expired" } }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        )
      }

      const res = await original(...args)

      if (res.ok && hasAuth) {
        lastApiCallRef.current = Date.now()
      }

      if (!triggered && hasAuth && res.status === 401) {
        // Treat ANY authed 401 as session expiry. The server's requireAuth
        // returns the SESSION_TIMEOUT envelope on idle eviction, but we no
        // longer require the envelope — the 401+hasAuth combo is enough.
        triggered = true
        markSessionExpired()
      }
      return res
    }

    return () => {
      window.fetch = original
    }
  }, [isOnLoginPage, markSessionExpired])

  // Proactive idle timer — fires modal/warning even if the user is sitting
  // idle and never makes another request. Aligned with the server's
  // last_activity_at via the fetch wrapper above.
  useIdleTimeout({
    lastApiCallRef,
    enabled: !isOnLoginPage && !sessionExpired,
    warningAtMs: 28 * 60 * 1000,
    expireAtMs: 30 * 60 * 1000,
    pollMs: 10_000,
    onWarning: () => setWarningOpen(true),
    onWarningTick: (remaining) => setWarningRemainingMs(remaining),
    onExpire: () => {
      // Client clock is authoritative — clear storage immediately so any
      // fetch that sneaks past the wrapper (or fires during the modal's
      // 5-sec countdown) cannot re-authenticate.
      markSessionExpired()
    },
    onActivityAfterWarning: () => {
      setWarningOpen(false)
    },
  })

  // "Stay logged in" → make any cheap authed request to bump server activity.
  // The fetch wrapper will see it succeed and reset lastApiCallRef.
  const handleStayLoggedIn = React.useCallback(async () => {
    const token =
      typeof window !== "undefined"
        ? localStorage.getItem("llmatscale_auth_token")
        : null
    if (!token) {
      setWarningOpen(false)
      return
    }
    try {
      await fetch("/api/auth/me", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {/* ignore */}
    setWarningOpen(false)
  }, [])

  // (Previously: a visibilitychange handler here pinged /api/auth/me to
  // force a server-side eviction check. Removed — that ping was
  // poisonous. When the user tabbed back at e.g. minute 27, the ping
  // succeeded (gap < 30 min), bumped server's last_activity_at to NOW,
  // and the patched fetch wrapper bumped lastApiCallRef to NOW too. So
  // both clocks reset and the 28/30-min thresholds were never reached.
  // The hook's own visibilitychange re-check (runs `runCheck()` without
  // firing a fetch) handles the "tab was background past 30 min, now
  // visible — fire modal" case correctly. And any real user action
  // (sending a chat, etc.) still hits the server → 401 → modal flow.)

  // Initialize theme from localStorage on mount
  React.useEffect(() => {
    const savedTheme = localStorage.getItem("llmatscale_theme")
    if (savedTheme === "dark") {
      document.documentElement.classList.add("dark")
    } else if (savedTheme === "system") {
      // Only follow the OS when the user has explicitly chosen "system".
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
      document.documentElement.classList.toggle("dark", prefersDark)
    } else {
      // Default (and explicit "light") → light.
      document.documentElement.classList.remove("dark")
    }

    // Apply the admin-controlled global platform color theme. This is locked
    // from the admin console — it overrides any local preference. "claude"
    // clears the attribute (base :root = Claude); every other theme sets it.
    fetch("/api/platform-theme", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const theme = (d && d.colorTheme) || "fab-blue"
        if (theme === "claude") {
          document.documentElement.removeAttribute("data-theme")
        } else {
          document.documentElement.setAttribute("data-theme", theme)
        }
      })
      .catch(() => { /* keep the static default from layout.tsx */ })

    // Apply saved font size
    const savedFontSize = localStorage.getItem("llmatscale_font_size")
    if (savedFontSize) {
      document.documentElement.style.setProperty("--base-font-size", `${savedFontSize}px`)
    }
  }, [])

  // Listen for system theme changes when in "system" mode
  React.useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")

    const handleChange = (e: MediaQueryListEvent) => {
      const savedTheme = localStorage.getItem("llmatscale_theme")
      if (savedTheme === "system") {
        if (e.matches) {
          document.documentElement.classList.add("dark")
        } else {
          document.documentElement.classList.remove("dark")
        }
      }
    }

    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [])

  // SidebarProvider in FullChatApp already has h-svh - no extra wrapper needed
  return (
    <MotionConfig reducedMotion="user">
      <ErrorBoundary
        onError={(error, errorInfo) => {
          // Log to console in development
          console.error("Application error:", error)
          console.error("Component stack:", errorInfo.componentStack)

          // In production, you might want to send this to an error tracking service
          // Example: Sentry.captureException(error, { extra: { componentStack: errorInfo.componentStack } })
        }}
      >
        {children}
        <SessionWarningBanner
          open={warningOpen && !sessionExpired && !isOnLoginPage}
          msRemaining={warningRemainingMs}
          onStayLoggedIn={handleStayLoggedIn}
          onDismiss={() => setWarningOpen(false)}
        />
        <SessionExpiredModal open={sessionExpired && !isOnLoginPage} autoRedirectSeconds={5} />
      </ErrorBoundary>
    </MotionConfig>
  )
}

/**
 * Hook to detect network status
 */
export function useNetworkStatus() {
  const [isOnline, setIsOnline] = React.useState(true)

  React.useEffect(() => {
    setIsOnline(navigator.onLine)

    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)

    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  return isOnline
}

/**
 * Hook to detect reduced motion preference
 */
export function useReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(false)

  React.useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    setPrefersReducedMotion(mediaQuery.matches)

    const handleChange = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches)
    }

    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [])

  return prefersReducedMotion
}
