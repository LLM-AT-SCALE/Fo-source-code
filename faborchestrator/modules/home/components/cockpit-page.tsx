"use client"

import { CockpitNav } from "./cockpit-nav"
import { CockpitHero } from "./cockpit-hero"
import { CockpitAsk } from "./cockpit-ask"
import { AgentCards } from "./agent-cards"
import { CockpitFooterStats } from "./cockpit-footer-stats"
import { useMcpHealth } from "@/shared/hooks/use-mcp-health"
import { useUserActivity } from "../lib/use-user-activity"
import type { AuthedUser } from "./types"

// V2 design system — Plus Jakarta Sans, line-height normal (matches 2_Cockpit.html).
export const COCKPIT_FONT =
    "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"

export function CockpitPage({ user }: { user: AuthedUser | null }) {
    // One fetch each per page: the user's own recent work and the health of their data servers.
    const { activity, loading: activityLoading } = useUserActivity({ intervalMs: 60000 })
    const { summary: health } = useMcpHealth({ intervalMs: 60000 })

    // Root layout locks <html>/<body> to overflow-hidden for the chat sidebar
    // pattern, so this page owns its own vertical scroll. The nav is sticky
    // within this scroll container, exactly like the HTML mockup.
    return (
        <div
            className="cockpit-v2 h-full overflow-y-auto"
            style={{ fontFamily: COCKPIT_FONT, background: "var(--page-surface)", color: "var(--text-ink)", lineHeight: "normal" }}
        >
            <CockpitNav user={user} />
            <div className="mx-auto w-full max-w-[1180px] px-[26px] pb-[48px] pt-[38px]">
                {/* HERO */}
                <div className="text-center">
                    <CockpitHero />
                    <CockpitAsk />
                </div>
                {/* THE NUCLEUS */}
                <AgentCards health={health} activity={activity} />
                {/* LIVE OPS + RECENT */}
                <CockpitFooterStats activity={activity} loading={activityLoading} health={health} />
            </div>
        </div>
    )
}
