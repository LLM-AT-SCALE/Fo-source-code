"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { CockpitPage } from "@/modules/home/components/cockpit-page"
import { PageLoadingSkeleton } from "@/shared/components/ui/skeleton-loaders"
import { AUTH_TOKEN_KEY, hasLocalToken, clearAuthStorage } from "@/shared/lib/client-session"

import type { AuthedUser } from "@/modules/home/components/types"
// Kept for existing importers; the type itself lives with the cockpit components.
export type { AuthedUser }

export default function HomePage() {
    const router = useRouter()
    const [user, setUser] = useState<AuthedUser | null>(null)
    const [validated, setValidated] = useState<boolean | null>(null)

    useEffect(() => {
        if (typeof window === "undefined") return
        if (!hasLocalToken()) {
            clearAuthStorage()
            router.replace("/")
            return
        }
        const token = localStorage.getItem(AUTH_TOKEN_KEY)!
        let cancelled = false
        ;(async () => {
            try {
                const res = await fetch("/api/auth/me", {
                    method: "GET",
                    headers: { Authorization: `Bearer ${token}` },
                    cache: "no-store",
                })
                if (cancelled) return
                if (res.status === 401) {
                    clearAuthStorage()
                    router.replace("/")
                    return
                }
                const data = await res.json()
                setUser(data.user as AuthedUser)
                setValidated(true)
            } catch {
                if (!cancelled) setValidated(true)
            }
        })()
        return () => { cancelled = true }
    }, [router])

    if (validated !== true) return <PageLoadingSkeleton />
    return <CockpitPage user={user} />
}
