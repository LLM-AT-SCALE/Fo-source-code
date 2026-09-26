"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { PageLoadingSkeleton } from "@/shared/components/ui/skeleton-loaders"

const AUTH_TOKEN_KEY = "llmatscale_auth_token"
const AUTH_SESSION_KEY = "llmatscale_auth_session"

/**
 * Client gate for the Back-end Agent: asks /api/backend-agent/access whether the
 * signed-in user may proceed.
 *
 * That route answers YES for everyone while the agent is open — see
 * `modules/coding-agent/lib/access.ts`. This component does not know or care which rule
 * produced the answer, which is why switching enforcement on later needs no
 * change here.
 *
 * The same shape as `ModelingAccessGate`, deliberately — two agents behaving
 * differently at the door would be a difference an administrator has to learn
 * for no reason. The chat route enforces the rule independently; a gate in the
 * browser is a courtesy so the engineer is TOLD why, never a control.
 */
export function BackendAccessGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [state, setState] = useState<"loading" | "ok" | "denied">("loading")

  useEffect(() => {
    if (typeof window === "undefined") return
    const token = localStorage.getItem(AUTH_TOKEN_KEY)
    if (!token || !localStorage.getItem(AUTH_SESSION_KEY)) {
      router.replace("/")
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/backend-agent/access", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        })
        if (cancelled) return
        if (res.status === 401) {
          router.replace("/")
          return
        }
        const data = await res.json().catch(() => ({ enabled: false }))
        setState(data.enabled ? "ok" : "denied")
      } catch {
        if (!cancelled) setState("denied")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [router])

  if (state === "loading") return <PageLoadingSkeleton />
  if (state === "denied") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-xl font-semibold">
          The Coding Agent isn&apos;t enabled for your role
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Ask an administrator to enable the Coding Agent for your role in Admin Console → Roles.
        </p>
        <button
          onClick={() => router.push("/home")}
          className="mt-2 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
        >
          Back to home
        </button>
      </div>
    )
  }
  return <>{children}</>
}
