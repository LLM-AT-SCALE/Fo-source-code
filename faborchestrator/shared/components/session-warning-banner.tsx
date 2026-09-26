"use client"

import * as React from "react"
import { Clock, RefreshCw, X } from "lucide-react"
import { motion, AnimatePresence } from "motion/react"
import { Button } from "@/shared/components/ui/button"
import { cn } from "@/shared/lib/utils"

interface SessionWarningBannerProps {
  open: boolean
  /** Live ms-remaining number, updated by the parent on each tick. */
  msRemaining: number
  /** Called when the user clicks "Stay logged in". Should make an
   *  authed API request that bumps server `last_activity_at`. */
  onStayLoggedIn: () => void
  onDismiss?: () => void
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m > 0) return `${m} min ${s.toString().padStart(2, "0")} sec`
  return `${s} sec`
}

/**
 * Soft warning that appears at the 28-min mark — 2 min before idle
 * eviction. Non-blocking (chat stays usable underneath). Auto-clears
 * when the user clicks anywhere in the chat (because that triggers
 * an authed API call which resets the timer).
 */
export function SessionWarningBanner({
  open,
  msRemaining,
  onStayLoggedIn,
  onDismiss,
}: SessionWarningBannerProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="alert"
          aria-live="polite"
          initial={{ y: -24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -24, opacity: 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 28 }}
          className={cn(
            "fixed top-4 left-1/2 -translate-x-1/2 z-[60] w-[min(540px,calc(100vw-32px))]",
            "rounded-xl border border-amber-300 dark:border-amber-700/60",
            "bg-amber-50/95 dark:bg-amber-950/40 backdrop-blur",
            "shadow-lg p-3 pl-4"
          )}
        >
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" strokeWidth={1.8} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                You&apos;ll be signed out in {formatRemaining(msRemaining)}
              </p>
              <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-200/70">
                Your session has been inactive. Click anywhere or stay logged in to keep it alive.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onStayLoggedIn}
              className="gap-1.5 border-amber-300 dark:border-amber-700 bg-white dark:bg-amber-950/40 text-amber-900 dark:text-amber-100 hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Stay logged in
            </Button>
            {onDismiss && (
              <Button
                type="button"
                variant="ghost"
                onClick={onDismiss}
                aria-label="Dismiss"
                className="h-auto w-auto rounded-md border-0 bg-transparent p-1 text-amber-800/70 hover:bg-amber-100 active:scale-100 dark:text-amber-300/70 dark:hover:bg-amber-900/40"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
