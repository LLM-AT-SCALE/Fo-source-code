/**
 * GET /api/user/activity — what the cockpit shows about the signed-in user's own work.
 * Business language only: every string here is shown as-is on the landing page.
 */
import type { AgentKey } from "@/shared/lib/agents"

export type ActivityItem = {
  agent: AgentKey
  /** Agent name as shown on the row (AGENT_LABELS). */
  label: string
  /** One line: the conversation title, "Package X validated", "Dashboard Y · pending approval". */
  description: string
  /** ISO timestamp the row is sorted by; the browser renders it as "2 min". */
  at: string
  /** Where clicking the row goes. */
  href: string
  /** Work still in progress (a load running, a dashboard being prepared) — shown with the pulse dot. */
  active?: boolean
}

export type AgentUsage = {
  conversations: number
  lastActiveAt: string | null
}

export type UserActivity = {
  items: ActivityItem[]
  agents: Record<AgentKey, AgentUsage>
  totals: {
    conversations: number
    conversationsThisWeek: number
    /** Dashboards the user can open on the Reports page. */
    dashboards: number
    /** The user's own dashboard requests still waiting for an admin. */
    dashboardsPending: number
    /** Master Data Load validations and loads the user has run. */
    dataLoads: number
    /** Outcome of the user's latest data load, in plain words, or null when there is none. */
    lastDataLoad: { text: string; ok: boolean | null } | null
  }
}
