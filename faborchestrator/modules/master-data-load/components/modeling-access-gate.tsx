"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { PageLoadingSkeleton } from "@/shared/components/ui/skeleton-loaders"

const AUTH_TOKEN_KEY = "llmatscale_auth_token"
const AUTH_SESSION_KEY = "llmatscale_auth_session"

/**
 * Client gate for Modeling Agent routes: verifies the signed-in user's role has
 * the `modeling_agent` permission (via /api/modeling-agent/access) before
 * rendering children. Shared by the chat and loader pages.
 */
export function ModelingAccessGate({ children }: { children: React.ReactNode }) {
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
        const res = await fetch("/api/modeling-agent/access", {
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
        <h1 className="text-xl font-semibold">Modeling Agent isn&apos;t enabled for your role</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Ask an administrator to enable the Modeling Agent for your role in Admin Console → Roles.
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
