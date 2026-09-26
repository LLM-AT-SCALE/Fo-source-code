"use client"

/**
 * Pin a chat dashboard — one short dialog (see /api/fabinsight/pin-requests):
 *   1. name (prefilled from the chat, editable)
 *   2. Static (a snapshot as it is now) or Scheduled (refreshed automatically:
 *      frequency, From date, To date or No expiry)
 *   3. who can see it (All roles by default, selected roles, or only me)
 *   4. confirm.
 * An admin's pin goes live at once and opens on the Reports page; anyone else's
 * is sent to the admins for approval with these choices already filled in.
 */

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CalendarClock, Camera, Loader2, Pin } from "lucide-react"
import { Button } from "@/shared/components/ui/button"
import { cn } from "@/shared/lib/utils"
import {
  ScheduleFields,
  defaultScheduleValue,
  scheduleLabelCls,
  scheduleSelectCls,
  scheduleValueErrors,
  scheduleValueToBody,
  type ScheduleValue,
} from "@/modules/admin/components/schedule-fields"
import type { PinType, PinVisibilityMode } from "@/modules/fabinsight/lib/pin/options"

export type PinRole = { id: string; name: string }

/** Local calendar date "YYYY-MM-DD" (the date inputs' format). */
function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function PinDashboardDialog({
  defaultTitle,
  html,
  messageId,
  artifactIdentifier,
  isAdmin,
  roles,
  authHeaders,
  onClose,
}: {
  defaultTitle: string
  html: string
  messageId: string
  artifactIdentifier: string | null
  isAdmin: boolean
  roles: PinRole[]
  authHeaders: () => HeadersInit
  onClose: () => void
}) {
  const router = useRouter()
  const today = useMemo(() => localDate(), [])
  const [title, setTitle] = useState(defaultTitle)
  const [type, setType] = useState<PinType>("scheduled")
  const [schedule, setSchedule] = useState<ScheduleValue>(() => defaultScheduleValue())
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState("")
  const [noExpiry, setNoExpiry] = useState(true)
  const [who, setWho] = useState<PinVisibilityMode>("all")
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [state, setState] = useState<"idle" | "saving" | "sent">("idle")
  const [error, setError] = useState<string | null>(null)

  const saving = state === "saving"
  const scheduleOk = type === "static" || scheduleValueErrors(schedule).valid
  const datesOk = type === "static" || noExpiry || (!!to && to >= (from || today))
  const whoOk = who !== "roles" || roleIds.length > 0
  const canConfirm = !!title.trim() && scheduleOk && datesOk && whoOk && state === "idle"

  const toggleRole = (id: string) =>
    setRoleIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const confirm = async () => {
    if (!canConfirm) return
    setState("saving")
    setError(null)
    try {
      const res = await fetch("/api/fabinsight/pin-requests", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          title: title.trim(),
          html,
          messageId,
          artifactIdentifier,
          type,
          ...(type === "scheduled"
            ? { schedule: scheduleValueToBody(schedule), from: from || null, to: noExpiry ? null : to, noExpiry }
            : {}),
          visibility: { mode: who, roleIds: who === "roles" ? roleIds : [] },
        }),
      })
      // A 500 can arrive with an empty or HTML body, so never assume JSON.
      const raw = await res.text()
      let json: { error?: string | { message?: string }; status?: string; url?: string } = {}
      try { json = raw ? (JSON.parse(raw) as typeof json) : {} } catch { json = {} }
      if (!res.ok) {
        const apiMessage = typeof json.error === "string" ? json.error : json.error?.message
        throw new Error(apiMessage ?? `Could not pin this dashboard (${res.status}).`)
      }
      if (json.status === "live" && json.url) {
        toast.success(
          type === "static"
            ? "Dashboard pinned."
            : "Dashboard pinned. It shows this snapshot until automatic refresh is ready.",
        )
        onClose()
        router.push(json.url)
        return
      }
      setState("sent")
      toast.success("Sent for approval")
      setTimeout(onClose, 1800)
    } catch (e) {
      setState("idle")
      setError(e instanceof Error ? e.message : "Could not pin this dashboard.")
    }
  }

  const choice = (active: boolean) =>
    cn(
      "flex flex-1 items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:opacity-60",
      active ? "border-primary bg-primary/5" : "hover:bg-accent/40",
    )

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 backdrop-blur-sm"
      onClick={() => { if (!saving) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pin dashboard"
        className="max-h-[92%] w-[440px] max-w-[94%] overflow-y-auto rounded-lg border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2 text-sm font-medium">
          <Pin className="h-4 w-4" />
          Pin dashboard
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {isAdmin
            ? "It goes live on the Reports page as soon as you confirm."
            : "An admin approves it before it appears on the Reports page."}
        </p>

        <label className={scheduleLabelCls} htmlFor="pin-title">Name</label>
        <input
          id="pin-title"
          type="text"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setError(null) }}
          placeholder="Dashboard name"
          maxLength={120}
          autoFocus
          disabled={saving}
          className="mb-4 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />

        <p className={scheduleLabelCls}>Type</p>
        <div className="mb-4 flex gap-2">
          <button type="button" className={choice(type === "static")} disabled={saving} onClick={() => setType("static")} aria-pressed={type === "static"}>
            <Camera className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="block font-medium">Static</span>
              <span className="block text-xs text-muted-foreground">A snapshot as it is now, never refreshed</span>
            </span>
          </button>
          <button type="button" className={choice(type === "scheduled")} disabled={saving} onClick={() => setType("scheduled")} aria-pressed={type === "scheduled"}>
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="block font-medium">Scheduled</span>
              <span className="block text-xs text-muted-foreground">Refreshed automatically</span>
            </span>
          </button>
        </div>

        {type === "scheduled" && (
          <div className="mb-4 space-y-2.5 rounded-md border bg-muted/20 p-3">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <ScheduleFields value={schedule} onChange={setSchedule} disabled={saving} />
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div>
                <label className={scheduleLabelCls} htmlFor="pin-from">From</label>
                <input id="pin-from" type="date" min={today} className={scheduleSelectCls} value={from} disabled={saving} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <label className={scheduleLabelCls} htmlFor="pin-to">To</label>
                <input id="pin-to" type="date" min={from || today} className={scheduleSelectCls} value={to} disabled={saving || noExpiry} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-primary" checked={noExpiry} disabled={saving} onChange={(e) => setNoExpiry(e.target.checked)} />
              No expiry
            </label>
            {!datesOk && <p className="text-xs text-destructive">Pick a To date on or after the From date, or choose No expiry.</p>}
          </div>
        )}

        <p className={scheduleLabelCls}>Who can see it</p>
        <div className="mb-4 space-y-1.5 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="pin-who" className="accent-primary" checked={who === "all"} disabled={saving} onChange={() => setWho("all")} />
            All roles
          </label>
          {roles.length > 0 && (
            <label className="flex items-center gap-2">
              <input type="radio" name="pin-who" className="accent-primary" checked={who === "roles"} disabled={saving} onChange={() => setWho("roles")} />
              Selected roles
            </label>
          )}
          {who === "roles" && (
            <div className="ml-6 max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
              {roles.map((r) => (
                <label key={r.id} className="flex items-center gap-2">
                  <input type="checkbox" className="accent-primary" checked={roleIds.includes(r.id)} disabled={saving} onChange={() => toggleRole(r.id)} />
                  {r.name}
                </label>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2">
            <input type="radio" name="pin-who" className="accent-primary" checked={who === "me"} disabled={saving} onChange={() => setWho("me")} />
            Only me
          </label>
          {!whoOk && <p className="text-xs text-destructive">Pick at least one role.</p>}
        </div>

        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        {state === "sent" && <p className="mb-2 text-xs text-green-600">Sent for approval. An admin will review it.</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="default" size="sm" onClick={() => void confirm()} disabled={!canConfirm}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isAdmin ? "Pin dashboard" : "Send for approval"}
          </Button>
        </div>
      </div>
    </div>
  )
}
