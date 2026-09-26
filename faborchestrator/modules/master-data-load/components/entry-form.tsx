"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Loader2,
  Plus,
  Trash2,
  Send,
  CheckCircle2,
  Copy,
  ArrowDownToLine,
} from "lucide-react"
import { cmfFetch } from "@/modules/master-data-load/lib/cmf/client-auth"
import { cn } from "@/shared/lib/utils"

/**
 * Inline data-entry form rendered inside the chat in place of a tool-call
 * disclosure. Backed by `renderEntryForm`'s output: a list of field specs (with
 * type, mandatory, FK target). FK columns lazy-load their dropdown options from
 * /api/modeling-agent/chat/parent-options/[targetType].
 *
 * On Submit, the rows are serialized into a structured user message
 * (`__entry_form__` marker so the assistant's system prompt can route it) and
 * handed back via `onSubmit`. After submission the form collapses to a
 * "Submitted" chip and disables further edits.
 */

type FormField = {
  name: string
  scalarType: string | null
  mandatory: boolean
  isKey: boolean
  maxLength: number | null
  regex: string | null
  referenceTargetType: string | null
}

type CellStatus =
  | "ok"
  | "fk-resolved"
  | "fk-fuzzy"
  | "fk-missing"
  | "fk-unknown"
  | "required-missing"
  | "too-long"
  | "regex-fail"

type PrefilledCell = {
  value: string
  status?: CellStatus
  message?: string
  suggestions?: string[]
}

type PrefilledRow = Record<string, PrefilledCell>

export type FormSpec = {
  objectType: string
  initialRows?: number
  fields: FormField[]
  /** From prefillFormFromInput — when present, the form opens with these
   *  rows pre-populated and color-coded by status. */
  prefilledRows?: PrefilledRow[] | null
}

type Row = Record<string, string>
type CellMeta = { status?: CellStatus; message?: string; suggestions?: string[] }
type RowMeta = Record<string, CellMeta>

const NUMERIC_TYPES = new Set([
  "BigInt",
  "Int",
  "SmallInt",
  "TinyInt",
  "Decimal",
  "Numeric",
  "Float",
  "Real",
  "Money",
  "SmallMoney",
])

function inputTypeFor(field: FormField): "text" | "number" | "date" | "checkbox" {
  if (!field.scalarType) return "text"
  if (NUMERIC_TYPES.has(field.scalarType)) return "number"
  if (field.scalarType === "Bit") return "checkbox"
  if (/date|time/i.test(field.scalarType)) return "date"
  return "text"
}

type ParentOptions = {
  loading: boolean
  options: string[]
  truncated?: boolean
  error?: string
}

export function EntryForm({
  spec,
  onSubmit,
  disabled,
}: {
  spec: FormSpec
  onSubmit: (text: string) => void
  disabled?: boolean
}) {
  const initial = Math.max(1, spec.initialRows ?? 1)
  const [rows, setRows] = useState<Row[]>(() => seedRows(spec, initial))
  const [meta, setMeta] = useState<RowMeta[]>(() => seedMeta(spec, initial))
  const [submitted, setSubmitted] = useState(false)
  const [parentOpts, setParentOpts] = useState<Record<string, ParentOptions>>({})

  // Lazy-load FK dropdown options on mount.
  const fkTargets = useMemo(() => {
    const set = new Set<string>()
    for (const f of spec.fields) if (f.referenceTargetType) set.add(f.referenceTargetType)
    return [...set]
  }, [spec.fields])

  useEffect(() => {
    let cancelled = false
    for (const target of fkTargets) {
      setParentOpts((prev) => ({
        ...prev,
        [target]: prev[target] ?? { loading: true, options: [] },
      }))
      void cmfFetch(`/api/modeling-agent/chat/parent-options/${encodeURIComponent(target)}`)
        .then((r) => r.json())
        .then((data: { options?: string[]; truncated?: boolean; error?: string }) => {
          if (cancelled) return
          setParentOpts((prev) => ({
            ...prev,
            [target]: {
              loading: false,
              options: data.options ?? [],
              truncated: !!data.truncated,
              error: data.error,
            },
          }))
        })
        .catch(() => {
          if (cancelled) return
          setParentOpts((prev) => ({
            ...prev,
            [target]: { loading: false, options: [], error: "Failed to load" },
          }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [fkTargets])

  const setCell = (rowIdx: number, fieldName: string, value: string) => {
    setRows((prev) =>
      prev.map((r, i) => (i === rowIdx ? { ...r, [fieldName]: value } : r)),
    )
    // Once the user edits a cell, drop its pre-fill status — the validation
    // status only reflected the original prefill snapshot.
    setMeta((prev) =>
      prev.map((m, i) =>
        i === rowIdx ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== fieldName)) : m,
      ),
    )
  }
  const addRow = () => {
    setRows((prev) => [...prev, emptyRow(spec.fields)])
    setMeta((prev) => [...prev, {}])
  }
  const duplicateRow = (idx: number) => {
    setRows((prev) => insertAt(prev, idx + 1, { ...prev[idx] }))
    // Cloned row inherits the source row's status — user can re-edit any cell.
    setMeta((prev) => insertAt(prev, idx + 1, { ...prev[idx] }))
  }
  const removeRow = (idx: number) => {
    setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))
    setMeta((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))
  }
  /** Copy a single cell's value into the same column on every other row. */
  const applyToAll = (sourceIdx: number, fieldName: string) => {
    const v = (rows[sourceIdx]?.[fieldName] ?? "").trim()
    if (!v) return
    setRows((prev) => prev.map((r) => ({ ...r, [fieldName]: v })))
    setMeta((prev) =>
      prev.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== fieldName))),
    )
  }
  /** User accepted a fuzzy/missing FK suggestion — write it in. */
  const acceptSuggestion = (rowIdx: number, fieldName: string, suggestion: string) => {
    setCell(rowIdx, fieldName, suggestion)
  }

  const validationErrors = useMemo(() => {
    const errs: { row: number; column: string; message: string }[] = []
    rows.forEach((row, i) => {
      for (const f of spec.fields) {
        const v = (row[f.name] ?? "").trim()
        if (f.mandatory && !v) {
          errs.push({ row: i + 1, column: f.name, message: "Required" })
        }
      }
    })
    return errs
  }, [rows, spec.fields])

  const handleSubmit = () => {
    if (submitted || disabled) return
    if (validationErrors.length > 0) return
    // Drop empty rows (all blank cells).
    const cleaned = rows.filter((r) =>
      spec.fields.some((f) => (r[f.name] ?? "").trim().length > 0),
    )
    if (cleaned.length === 0) return
    // Structured message so the assistant's system prompt can route it.
    const text = [
      `__entry_form__: submitted ${cleaned.length} ${cleaned.length === 1 ? "row" : "rows"} for ${spec.objectType}.`,
      "",
      "```json",
      JSON.stringify({ objectType: spec.objectType, rows: cleaned }, null, 2),
      "```",
    ].join("\n")
    setSubmitted(true)
    onSubmit(text)
  }

  if (submitted) {
    const filledCount = rows.filter((r) =>
      spec.fields.some((f) => (r[f.name] ?? "").trim().length > 0),
    ).length
    return (
      <div className="my-2 inline-flex items-center gap-2 rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm">
        <CheckCircle2 className="size-4 text-emerald-600" />
        <span className="font-medium">Submitted</span>
        <span className="text-muted-foreground">
          {filledCount} {filledCount === 1 ? "row" : "rows"} for {spec.objectType}
        </span>
      </div>
    )
  }

  return (
    <div className="my-3 w-full overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <p className="text-sm font-semibold">Enter rows for {spec.objectType}</p>
          <p className="text-xs text-muted-foreground">
            Fill in the {spec.fields.filter((f) => f.mandatory).length} required field
            {spec.fields.filter((f) => f.mandatory).length === 1 ? "" : "s"} per row, then submit.
          </p>
        </div>
        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-transparent px-3 text-xs font-medium hover:bg-muted disabled:opacity-50 cursor-pointer"
        >
          <Plus className="size-3.5" />
          Add row
        </button>
      </div>

      {/* Vertical card layout: one card per row, one label:input pair per line.
         Kills the horizontal scroll for wide objects like User (12 fields). */}
      <div className="flex flex-col gap-3 p-3">
        {rows.map((row, rowIdx) => (
          <div
            key={rowIdx}
            className="rounded-lg border border-border bg-background"
          >
            <div className="flex items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5">
              <span className="text-xs font-semibold text-muted-foreground">
                Row {rowIdx + 1}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => duplicateRow(rowIdx)}
                  disabled={disabled}
                  title="Duplicate this row"
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 cursor-pointer"
                  aria-label="Duplicate row"
                >
                  <Copy className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeRow(rowIdx)}
                  disabled={disabled || rows.length === 1}
                  title="Remove this row"
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 cursor-pointer"
                  aria-label="Remove row"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-2 px-3 py-2.5">
              {spec.fields.map((f) => {
                const cellMeta = meta[rowIdx]?.[f.name]
                return (
                  <div key={f.name} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
                    <label
                      htmlFor={`row-${rowIdx}-field-${f.name}`}
                      title={f.scalarType ?? ""}
                      className="text-xs font-medium text-foreground sm:w-40 sm:shrink-0 sm:pt-2"
                    >
                      {f.name}
                      {f.mandatory && <span className="text-destructive ml-0.5">*</span>}
                      {f.referenceTargetType && (
                        <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                          → {f.referenceTargetType}
                        </span>
                      )}
                    </label>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <div className="flex-1">
                          <FieldInput
                            field={f}
                            value={row[f.name] ?? ""}
                            onChange={(v) => setCell(rowIdx, f.name, v)}
                            parents={f.referenceTargetType ? parentOpts[f.referenceTargetType] : undefined}
                            disabled={disabled}
                            status={cellMeta?.status}
                            statusMessage={cellMeta?.message}
                          />
                        </div>
                        {(row[f.name] ?? "").trim() !== "" && rows.length > 1 && (
                          <button
                            type="button"
                            onClick={() => applyToAll(rowIdx, f.name)}
                            disabled={disabled}
                            title={`Apply "${row[f.name]}" to all rows`}
                            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 cursor-pointer shrink-0"
                            aria-label="Apply value to all rows"
                          >
                            <ArrowDownToLine className="size-3" />
                          </button>
                        )}
                      </div>
                      {cellMeta?.suggestions && cellMeta.suggestions.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {cellMeta.suggestions.slice(0, 3).map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={() => acceptSuggestion(rowIdx, f.name, s)}
                              disabled={disabled}
                              title={`Use "${s}"`}
                              className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium hover:bg-muted disabled:opacity-30 cursor-pointer"
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-3 py-2">
        <div className="text-xs text-muted-foreground">
          {validationErrors.length > 0 ? (
            <span className="text-destructive">
              {validationErrors.length} required field{validationErrors.length === 1 ? "" : "s"} still empty
            </span>
          ) : (
            <span>* required · references load from CMF</span>
          )}
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || validationErrors.length > 0}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium cursor-pointer",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          <Send className="size-3.5" />
          Submit
        </button>
      </div>

      {/* Hint shown below the form so the user knows they can extend it. */}
      <div className="border-t border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        Need an optional field that&apos;s not shown above? Just tell me which one
        in the chat and I&apos;ll add it to the form.
      </div>
    </div>
  )
}

function emptyRow(fields: FormField[]): Row {
  const r: Row = {}
  for (const f of fields) r[f.name] = ""
  return r
}

function insertAt<T>(arr: T[], idx: number, item: T): T[] {
  const next = arr.slice()
  next.splice(idx, 0, item)
  return next
}

function seedRows(spec: FormSpec, fallback: number): Row[] {
  if (spec.prefilledRows && spec.prefilledRows.length > 0) {
    return spec.prefilledRows.map((pr) => {
      const r: Row = {}
      for (const f of spec.fields) r[f.name] = pr[f.name]?.value ?? ""
      return r
    })
  }
  return Array.from({ length: fallback }, () => emptyRow(spec.fields))
}

function seedMeta(spec: FormSpec, fallback: number): RowMeta[] {
  if (spec.prefilledRows && spec.prefilledRows.length > 0) {
    return spec.prefilledRows.map((pr) => {
      const m: RowMeta = {}
      for (const f of spec.fields) {
        const cell = pr[f.name]
        if (!cell) continue
        m[f.name] = {
          status: cell.status,
          message: cell.message,
          suggestions: cell.suggestions,
        }
      }
      return m
    })
  }
  return Array.from({ length: fallback }, () => ({}))
}

/** Tailwind classes per status. We use only ring + bg so the input border
 *  itself stays clickable / focusable as normal. */
function statusClasses(status?: CellStatus): string {
  if (!status || status === "ok") return ""
  if (status === "fk-resolved") return "ring-1 ring-emerald-500/60 bg-emerald-500/5"
  if (status === "fk-fuzzy" || status === "fk-unknown")
    return "ring-1 ring-amber-500/60 bg-amber-500/5"
  // fk-missing / required-missing / too-long / regex-fail
  return "ring-1 ring-destructive/60 bg-destructive/5"
}

function FieldInput({
  field,
  value,
  onChange,
  parents,
  disabled,
  status,
  statusMessage,
}: {
  field: FormField
  value: string
  onChange: (v: string) => void
  parents?: ParentOptions
  disabled?: boolean
  status?: CellStatus
  statusMessage?: string
}) {
  const inputType = inputTypeFor(field)
  const baseClass =
    "w-full min-w-[8rem] h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
  const cls = cn(baseClass, statusClasses(status))
  const title = statusMessage ?? field.scalarType ?? ""

  // FK column → <select> populated from parent-options endpoint.
  if (field.referenceTargetType && parents) {
    if (parents.loading) {
      return (
        <div className={cn(baseClass, "flex items-center gap-1.5 text-muted-foreground")}>
          <Loader2 className="size-3 animate-spin" />
          <span className="text-xs">Loading…</span>
        </div>
      )
    }
    // Fall back to a typeable input when we can't offer a usable dropdown:
    //   - `truncated`: the parent table was too big to enumerate cheaply.
    //   - `error`: CMF was unreachable (VPN blip, SQL down). Without this the
    //     user would be stuck staring at an empty "— select —" with no way to
    //     enter the value at all.
    if (parents.truncated || parents.error) {
      return (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={
            parents.error
              ? `Type a ${field.referenceTargetType} name (couldn't reach CMF)`
              : `Type a ${field.referenceTargetType} name`
          }
          maxLength={field.maxLength ?? undefined}
          className={cls}
          title={
            parents.error
              ? `Couldn't load ${field.referenceTargetType} options from CMF — type the value instead. It still must exist in CMF (or be in this file) at load time.`
              : title
          }
          list={`opts-${field.referenceTargetType}`}
        />
      )
    }
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        title={title}
        className={cn(cls, "appearance-none pr-6 cursor-pointer")}
      >
        <option value="">— select —</option>
        {parents.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }

  if (inputType === "checkbox") {
    return (
      <input
        type="checkbox"
        checked={value === "true" || value === "1"}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
        disabled={disabled}
        title={title}
        className="size-4 rounded border-input cursor-pointer"
      />
    )
  }

  return (
    <input
      type={inputType}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      maxLength={field.maxLength ?? undefined}
      pattern={field.regex ?? undefined}
      title={title}
      className={cls}
    />
  )
}
