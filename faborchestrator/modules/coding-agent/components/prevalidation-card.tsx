"use client"

/**
 * THE PRE-VALIDATION REPORT, IN THE CONVERSATION.
 *
 * Every column, label, action and query the requirement names is resolved
 * against the delivered corpus and the CMF schema before anybody types. This
 * renders that answer.
 *
 * WHY IT LIVES IN THE TRANSCRIPT AND NOT IN THE SIDE PANEL
 *   It is about the message directly above it. The model has just said what the
 *   document asks for and what it does not settle; this says which of those the
 *   evidence already answers. Behind a tab it is a document somebody might open;
 *   in the thread it is the next thing they read.
 *
 * WHY A TABLE, AND WHY A RULED ONE
 *   Thirty-odd findings across four dimensions is a comparison. Ruled cells let
 *   the eye track a row across four columns without losing it — which is the
 *   whole reason to tabulate rather than list.
 *
 * REGISTER: LABELS, NOT SENTENCES.
 *   Headings and status chips are terms — `Element`, `Resolved`, `Action`. The
 *   finding text comes from the resolver and is left exactly as written: it
 *   carries the reasoning, and a second phrasing of the same fact in the view
 *   is a second thing to keep true.
 *
 * PROVENANCE IS NOT RENDERED.
 *   `evidence` is still populated and still load-bearing — it is the field the
 *   demotion invariant tests, so a `resolved` finding that cannot cite an
 *   artifact is downgraded rather than trusted. It is simply not shown: the
 *   report states determinations, and where a determination came from is the
 *   resolver's business, not the reader's.
 *
 * UNRESOLVED SORTS FIRST and carries a left accent — it is the only group that
 * asks anything of the reader, and placing it beneath the settled rows hides it.
 */
import { useState } from "react"
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, HelpCircle, Loader2 } from "lucide-react"

import { cn } from "@/shared/lib/utils"

interface PreValidationFinding {
  dimension: string
  subject: string
  state: "resolved" | "assumed" | "missing"
  detail: string
  evidence?: string
  closes?: string
}

export interface PreValidationReport {
  document: string
  counts: { resolved: number; assumed: number; missing: number }
  findings: PreValidationFinding[]
  /**
   * Client evidence the resolver could not consult because it is not installed
   * on the server — one plain sentence each, ending with how to provision it.
   * Shown above the findings: without the delivered exports every query and
   * page reads as unresolved, and that is a fact about the machine, not the
   * requirement.
   */
  notices?: string[]
}

const ORDER: Record<PreValidationFinding["state"], number> = {
  missing: 0, assumed: 1, resolved: 2,
}

const STATE = {
  missing: {
    label: "Unresolved",
    Icon: HelpCircle,
    accent: "border-l-amber-500",
    tint: "bg-amber-50/50 dark:bg-amber-950/15",
    chip: "bg-amber-100 text-amber-900 ring-amber-600/20 dark:bg-amber-900/40 dark:text-amber-100 dark:ring-amber-400/20",
    dot: "bg-amber-500",
  },
  assumed: {
    label: "Assumed",
    Icon: AlertTriangle,
    accent: "border-l-sky-500",
    tint: "",
    chip: "bg-sky-100 text-sky-900 ring-sky-600/20 dark:bg-sky-900/40 dark:text-sky-100 dark:ring-sky-400/20",
    dot: "bg-sky-500",
  },
  resolved: {
    label: "Resolved",
    Icon: CheckCircle2,
    accent: "border-l-emerald-500",
    tint: "",
    chip: "bg-emerald-100 text-emerald-900 ring-emerald-600/20 dark:bg-emerald-900/40 dark:text-emerald-100 dark:ring-emerald-400/20",
    dot: "bg-emerald-500",
  },
} as const

export function PreValidationCard({
  report, running, error,
}: {
  report: PreValidationReport | null
  running: boolean
  error: string | null
}) {
  /* Collapsed to what requires action. The resolved rows are the evidence the
     counts are real, so they stay reachable — but twenty-two of them between the
     reply and the input buries the conversation. */
  const [showAll, setShowAll] = useState(false)

  if (running && !report) {
    return (
      <div className="my-3 flex items-center gap-2.5 rounded-lg border bg-muted/30 px-3.5 py-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Validating requirement against artifacts…
      </div>
    )
  }

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3.5 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/20">
        <b>Pre-validation unavailable</b>
        <span className="ml-2 text-muted-foreground">{error}</span>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Advisory only — generation is not blocked.
        </p>
      </div>
    )
  }

  if (!report) return null

  const sorted = [...report.findings].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || a.subject.localeCompare(b.subject),
  )
  const open = sorted.filter((f) => f.state !== "resolved")
  const rows = showAll ? sorted : open
  const hidden = sorted.length - rows.length
  const total = report.counts.resolved + report.counts.assumed + report.counts.missing
  const pct = total ? Math.round((report.counts.resolved / total) * 100) : 0

  return (
    <div className="my-3 overflow-hidden rounded-xl border bg-card shadow-sm">
      {/* ── header: subject and tally ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-muted/40 px-4 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-background ring-1 ring-border">
          <CheckCircle2 className="size-3.5 text-muted-foreground" />
        </span>
        <b className="text-[13.5px]">Pre-validation</b>
        <span className="truncate text-[12px] text-muted-foreground">{report.document}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Chip kind="resolved" n={report.counts.resolved} />
          <Chip kind="assumed" n={report.counts.assumed} />
          <Chip kind="missing" n={report.counts.missing} />
        </span>
      </div>

      {/* ── what could not be consulted, before the counts it distorts ── */}
      {report.notices && report.notices.length > 0 && (
        <div className="border-b border-amber-300/60 bg-amber-50/60 px-4 py-2.5 text-[12.5px] dark:border-amber-900/50 dark:bg-amber-950/20">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" />
            <b>Client evidence not installed on this server</b>
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
            {report.notices.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      )}

      {/* ── coverage: the numbers, and the same thing as a bar ── */}
      <div className="border-b px-4 py-3">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[12.5px]">
          <Stat label="Elements" value={total} />
          <Stat label="Resolved" value={report.counts.resolved} />
          <Stat label="Assumed" value={report.counts.assumed} />
          <Stat label="Action required" value={report.counts.missing}
                emphasis={report.counts.missing > 0} />
          <span className="ml-auto text-muted-foreground">
            <b className="tabular-nums text-foreground">{pct}%</b> from artifacts
          </span>
        </div>
        {/* One bar, three segments, in the sort order of the table below it. */}
        <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
          {(["resolved", "assumed", "missing"] as const).map((k) => {
            const n = report.counts[k]
            if (!n) return null
            return (
              <span key={k} className={cn("h-full", STATE[k].dot)}
                    style={{ width: `${(n / total) * 100}%` }} />
            )
          })}
        </div>
        {/*
         * WHAT THE PERCENTAGE IS A PERCENTAGE OF.
         *
         * This card sits directly beneath a reply that lists what the document
         * leaves open. On a measured run the reply raised five such questions
         * while the card read "Action required 0 · 82% from artifacts" — because
         * the two read for different things, and the card never said so. Scanned
         * on its own it asserts a completeness it does not have.
         *
         * The denominator is the terms the requirement NAMES. An omission has no
         * term, so it can never appear here at any percentage; scope and intent
         * are not assessed at all. Stating the denominator is what makes the
         * number honest, and it is one line rather than a caveat because the
         * reader needs it before the table, not after it.
         */}
        <p className="mt-2 text-[11.5px] leading-snug text-muted-foreground">
          Coverage of terms named by the requirement — columns, labels, actions
          and queries. Scope, intent and omissions are out of its scope and are
          assessed in the reply above.
        </p>
      </div>

      {/* ── the grid ── */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[13px]">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[11%]" />
            <col className="w-[13%]" />
            <col />
          </colgroup>
          <thead>
            <tr className="bg-muted/25 text-[10.5px] uppercase tracking-wider text-muted-foreground">
              <th className="border-b border-r px-4 py-2 font-semibold">Element</th>
              <th className="border-b border-r px-3 py-2 font-semibold">Type</th>
              <th className="border-b border-r px-3 py-2 font-semibold">Status</th>
              <th className="border-b px-4 py-2 font-semibold">Finding</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => {
              const s = STATE[f.state]
              return (
                <tr
                  key={`${f.subject}-${i}`}
                  className={cn(
                    "border-b border-l-[3px] align-top transition-colors last:border-b-0 hover:bg-muted/30",
                    s.accent, s.tint,
                  )}
                >
                  <td className="border-r px-4 py-2.5 font-medium leading-snug">{f.subject}</td>
                  <td className="border-r px-3 py-2.5 capitalize text-muted-foreground">
                    {f.dimension}
                  </td>
                  <td className="border-r px-3 py-2.5">
                    <span className={cn(
                      "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5",
                      "text-[10.5px] font-semibold uppercase tracking-wide ring-1 ring-inset",
                      s.chip,
                    )}>
                      <s.Icon className="size-3" />
                      {s.label}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {/* The resolver's own wording, unaltered. */}
                    <span className="leading-snug text-muted-foreground">{f.detail}</span>
                    {f.closes && (
                      <span className="mt-1.5 flex items-start gap-1.5 text-[12px] font-medium">
                        <span className="rounded bg-foreground/8 px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                          Action
                        </span>
                        <span>{f.closes}</span>
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── the rest, on request ── */}
      {(hidden > 0 || (showAll && open.length < sorted.length)) && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="flex w-full items-center justify-center gap-1.5 border-t bg-muted/20 px-4 py-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          {showAll
            ? (<><ChevronUp className="size-3.5" />Action required only</>)
            : (<><ChevronDown className="size-3.5" />Show {hidden} resolved</>)}
        </button>
      )}
    </div>
  )
}

function Stat({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <b className={cn("tabular-nums", emphasis && "text-amber-600 dark:text-amber-400")}>
        {value}
      </b>
    </span>
  )
}

/** A count that is absent when zero, rather than a decorative nil. */
function Chip({ kind, n }: { kind: keyof typeof STATE; n: number }) {
  if (n === 0) return null
  const s = STATE[kind]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
        s.chip,
      )}
      title={`${n} ${s.label.toLowerCase()}`}
    >
      <s.Icon className="size-3" />
      <span className="tabular-nums">{n}</span>
    </span>
  )
}
