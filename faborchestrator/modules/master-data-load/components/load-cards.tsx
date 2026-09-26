"use client"

import { useState } from "react"
import { CheckCircle2, XCircle, MinusCircle, AlertTriangle, Database, ArrowRight } from "lucide-react"
import { cn } from "@/shared/lib/utils"

/**
 * In-chat cards for the master-data LOAD flow, so the two verification stages
 * and the load confirmation read like the console wizard instead of prose:
 *   - LoadValidationCard: the result of `validateForLoad` — shows Template
 *     validation and CMF validation as TWO separate labelled checks, the record
 *     count per object type, and (when both pass) a button to load. The button
 *     sends a machine-readable `__load_confirm__:<stagingId>` message that the
 *     system prompt routes straight to loadToCmf(confirmed:true).
 *   - LoadReceiptCard: the result of `loadToCmf` — created / updated / skipped /
 *     failed, success or failure.
 */

export type ValidateForLoadResult = {
  ok?: boolean
  templateOk?: boolean
  cmfOk?: boolean
  resultCode?: number
  stagingId?: string
  filename?: string
  objectTypes?: string[]
  recordCounts?: { objectType: string; count: number }[]
  totalRecords?: number
  errors?: { objectType?: string; row?: number; column?: string; severity?: string; message: string }[]
  error?: string
}

export type LoadToCmfResult = {
  ok?: boolean
  needsConfirmation?: boolean
  cmfResult?: number
  filename?: string
  created?: number
  updated?: number
  skipped?: number
  failedCount?: number
  selectedTypes?: string[]
  recordCounts?: { objectType: string; count: number }[]
  totalRecords?: number
  errors?: string[]
  error?: string
}

/** Build the confirm payload the system prompt recognises as explicit consent. */
function loadConfirmPayload(stagingId: string, selectedTypes?: string[]): string {
  const body = selectedTypes?.length ? { stagingId, selectedTypes } : { stagingId }
  return `__load_confirm__:${JSON.stringify(body)}`
}

function CheckRow({ label, state }: { label: string; state: "pass" | "fail" | "pending" }) {
  const icon =
    state === "pass" ? (
      <CheckCircle2 className="size-4 text-emerald-600" />
    ) : state === "fail" ? (
      <XCircle className="size-4 text-destructive" />
    ) : (
      <MinusCircle className="size-4 text-muted-foreground" />
    )
  const text = state === "pass" ? "passed" : state === "fail" ? "failed" : "not run"
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium">{label}</span>
      </div>
      <span
        className={cn(
          "text-xs font-semibold",
          state === "pass" && "text-emerald-600",
          state === "fail" && "text-destructive",
          state === "pending" && "text-muted-foreground",
        )}
      >
        {text}
      </span>
    </div>
  )
}

export function LoadValidationCard({
  result,
  interactive,
  onConfirm,
}: {
  result: ValidateForLoadResult
  interactive: boolean
  onConfirm: (payload: string) => void
}) {
  const [submitted, setSubmitted] = useState(false)

  // The tool itself couldn't run (file missing, connectivity).
  if (result.error) {
    return (
      <div className="my-3 w-full overflow-hidden rounded-xl border border-destructive/30 bg-destructive/5">
        <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
          <AlertTriangle className="size-4 text-destructive" />
          <span className="font-medium">Couldn&apos;t validate this file.</span>
          <span className="text-muted-foreground">{result.error}</span>
        </div>
      </div>
    )
  }

  const templateOk = !!result.templateOk
  // CMF is only attempted once the template check passes; otherwise it's "not run".
  const cmfState: "pass" | "fail" | "pending" = !templateOk ? "pending" : result.cmfOk ? "pass" : "fail"
  const bothPass = templateOk && !!result.cmfOk
  const counts = result.recordCounts ?? []
  const total = result.totalRecords ?? counts.reduce((n, c) => n + c.count, 0)
  const errors = result.errors ?? []

  return (
    <div className="my-3 w-full overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Database className="size-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Validation{result.filename ? ` — ${result.filename}` : ""}</p>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
            bothPass ? "bg-emerald-600/10 text-emerald-600" : "bg-destructive/10 text-destructive",
          )}
        >
          {bothPass ? "Ready to load" : "Not ready"}
        </span>
      </div>

      {/* Two verification stages, clearly labelled */}
      <div className="divide-y divide-border">
        <CheckRow label="Template validation" state={templateOk ? "pass" : "fail"} />
        <CheckRow label="CMF validation" state={cmfState} />
      </div>

      {/* Per-object-type record counts */}
      {counts.length > 0 && (
        <div className="border-t border-border">
          <div className="max-h-56 overflow-y-auto">
            {counts.map((c) => (
              <div key={c.objectType} className="flex items-center justify-between px-3 py-1.5 text-sm">
                <span className="text-foreground">{c.objectType}</span>
                <span className="text-muted-foreground">
                  {c.count} record{c.count === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-border bg-muted/30 px-3 py-2 text-sm font-semibold">
            <span>Total</span>
            <span>
              {total} record{total === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}

      {/* Errors, listed precisely */}
      {errors.length > 0 && (
        <div className="border-t border-border bg-destructive/5 px-3 py-2">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-destructive">
            <AlertTriangle className="size-3.5" /> {errors.length} issue{errors.length === 1 ? "" : "s"} to fix
          </p>
          <ul className="flex flex-col gap-1">
            {errors.slice(0, 12).map((e, i) => (
              <li key={i} className="text-xs text-foreground">
                <span className="font-medium">{e.objectType ?? "File"}</span>
                {e.row != null ? ` · row ${e.row}` : ""}
                {e.column ? ` · ${e.column}` : ""}: <span className="text-muted-foreground">{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Footer: confirm to load, or a fix hint. Once the load has been
          requested (button pressed this render, or a later message means it was
          already sent), show a static "requested" state — NOT an infinite
          spinner — because the outcome arrives as a separate receipt card. */}
      <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-3 py-2.5">
        {bothPass ? (
          submitted || !interactive ? (
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 text-emerald-600" /> Load requested — see the result below.
            </span>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">
                Both checks passed. Loading commits to CMF.
              </span>
              <button
                type="button"
                disabled={!interactive || !result.stagingId}
                onClick={() => {
                  if (!result.stagingId) return
                  setSubmitted(true)
                  onConfirm(loadConfirmPayload(result.stagingId, result.objectTypes))
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40 cursor-pointer"
              >
                Load {total} record{total === 1 ? "" : "s"}
                <ArrowRight className="size-3.5" />
              </button>
            </>
          )
        ) : (
          <span className="text-xs text-muted-foreground">
            Fix the {errors.length ? `${errors.length} issue${errors.length === 1 ? "" : "s"}` : "issues"} above, then re-validate before loading.
          </span>
        )}
      </div>
    </div>
  )
}

export function LoadReceiptCard({ result }: { result: LoadToCmfResult }) {
  // A refusal (confirmation missing) isn't a receipt — nothing to show here; the
  // assistant will have re-asked. A hard error shows a small failure card.
  if (result.needsConfirmation) return null
  if (result.error) {
    return (
      <div className="my-3 w-full overflow-hidden rounded-xl border border-destructive/30 bg-destructive/5">
        <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
          <XCircle className="size-4 text-destructive" />
          <span className="font-medium">Load failed.</span>
          <span className="text-muted-foreground">{result.error}</span>
        </div>
      </div>
    )
  }

  const ok = !!result.ok
  const stats: { label: string; value: number; tone?: "bad" }[] = [
    { label: "Created", value: result.created ?? 0 },
    { label: "Updated", value: result.updated ?? 0 },
    { label: "Skipped", value: result.skipped ?? 0 },
    { label: "Failed", value: result.failedCount ?? 0, tone: "bad" },
  ]
  const errors = result.errors ?? []

  return (
    <div className={cn("my-3 w-full overflow-hidden rounded-xl border bg-card", ok ? "border-emerald-600/30" : "border-destructive/30")}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-destructive" />}
        <p className="text-sm font-semibold">
          {ok ? "Loaded into CMF" : "Load failed"}
          {result.filename ? ` — ${result.filename}` : ""}
        </p>
      </div>

      <div className="grid grid-cols-4 divide-x divide-border">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col items-center gap-0.5 px-2 py-2.5">
            <span className={cn("text-lg font-semibold", s.tone === "bad" && s.value > 0 && "text-destructive")}>{s.value}</span>
            <span className="text-[11px] text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>

      {!ok && (
        <div className="border-t border-border bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
          CMF loads as one atomic batch — any failure rolls the whole load back, so nothing was committed.
        </div>
      )}

      {errors.length > 0 && (
        <div className="border-t border-border px-3 py-2">
          <ul className="flex flex-col gap-1">
            {errors.slice(0, 10).map((e, i) => (
              <li key={i} className="text-xs text-foreground">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
