"use client"

import * as React from "react"
import { Clock, LogIn } from "lucide-react"
import { motion, AnimatePresence } from "motion/react"
import { Button } from "@/shared/components/ui/button"
import { cn } from "@/shared/lib/utils"

interface SessionExpiredModalProps {
  open: boolean
  /** Seconds until the auto-redirect fires. Default 5. */
  autoRedirectSeconds?: number
  /** Where to send the user. Default "/". */
  redirectTo?: string
  /** Token-storage keys to clear before redirecting. */
  storageKeys?: string[]
}

/**
 * Friendly full-screen overlay that appears once the server replies
 * with `{ type: "SESSION_TIMEOUT" }`. Replaces the raw JSON-error UX.
 *
 * Behaviour:
 *  - Locks scroll while open
 *  - Shows a polite headline + body, animated clock icon
 *  - Counts down and auto-redirects to the login page
 *  - "Log in now" button skips the countdown
 */
export function SessionExpiredModal({
  open,
  autoRedirectSeconds = 5,
  redirectTo = "/",
  storageKeys = ["llmatscale_auth_token", "llmatscale_user", "llmatscale_session"],
}: SessionExpiredModalProps) {
  const [secondsLeft, setSecondsLeft] = React.useState(autoRedirectSeconds)

  React.useEffect(() => {
    if (!open) return
    setSecondsLeft(autoRedirectSeconds)
    const id = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0))
    }, 1000)
    return () => clearInterval(id)
  }, [open, autoRedirectSeconds])

  React.useEffect(() => {
    if (!open) return
    if (secondsLeft > 0) return
    redirectNow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, open])

  React.useEffect(() => {
    if (!open) return
    document.documentElement.style.overflow = "hidden"
    return () => {
      document.documentElement.style.overflow = ""
    }
  }, [open])

  const redirectNow = React.useCallback(() => {
    try {
      for (const k of storageKeys) localStorage.removeItem(k)
    } catch {/* ignore */}
    if (typeof window !== "undefined") {
      window.location.href = redirectTo
    }
  }, [redirectTo, storageKeys])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          aria-modal
          role="dialog"
          aria-labelledby="session-expired-title"
          aria-describedby="session-expired-body"
          className="fixed inset-0 z-[100] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-background/85 backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          {/* Card */}
          <motion.div
            className={cn(
              "relative z-10 w-full max-w-md mx-4 rounded-2xl border border-border bg-card text-card-foreground shadow-2xl",
              "p-8 text-center"
            )}
            initial={{ y: 24, opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
          >
            {/* Animated icon */}
            <motion.div
              className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/40"
              animate={{ scale: [1, 1.06, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            >
              <Clock className="h-8 w-8 text-amber-600 dark:text-amber-400" strokeWidth={1.8} />
            </motion.div>

            <h2 id="session-expired-title" className="text-xl font-semibold tracking-tight">
              You&apos;ve been signed out
            </h2>
            <p id="session-expired-body" className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Your session expired after a period of inactivity. Please sign in again to continue
              where you left off.
            </p>

            {/* Countdown */}
            <p className="mt-5 text-xs text-muted-foreground/80">
              {secondsLeft > 0 ? (
                <>Redirecting to sign in in <span className="font-mono font-semibold text-foreground">{secondsLeft}s</span>…</>
              ) : (
                <>Redirecting…</>
              )}
            </p>

            {/* Progress bar */}
            <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted">
              <motion.div
                className="h-full bg-amber-500 dark:bg-amber-400"
                initial={{ width: "100%" }}
                animate={{ width: `${(secondsLeft / autoRedirectSeconds) * 100}%` }}
                transition={{ duration: 1, ease: "linear" }}
              />
            </div>

            {/* CTA */}
            <Button
              type="button"
              size="lg"
              className="mt-6 w-full gap-2"
              onClick={redirectNow}
            >
              <LogIn className="h-4 w-4" />
              Log in now
            </Button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
