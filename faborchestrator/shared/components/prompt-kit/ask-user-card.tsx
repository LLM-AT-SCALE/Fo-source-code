"use client"

/**
 * Clickable clarifying questions.
 *
 * Rendered for the `ask_user` tool: instead of writing "which site — A, B or
 * both?" as a bullet list the user has to retype an answer to, the model sends
 * the question and its options as data and this card lets the user pick one
 * with a click or the keyboard.
 *
 * Keyboard, matching what people expect from a picker:
 *   ↑ / ↓        move between options (wraps; the last row is "type your own")
 *   1 – 9        pick that option directly
 *   Enter        pick the highlighted option (toggle it, when several may be picked)
 *   Space        toggle, when several may be picked
 *   ← / →        switch question, when there are several
 *
 * The pick goes back as an ordinary user message, so the conversation reads
 * naturally and nothing new has to be persisted. Once a later message exists
 * the card locks and shows what was answered.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, CornerDownLeft, PenLine } from "lucide-react"
import { cn } from "@/shared/lib/utils"

export interface AskUserOption {
  label: string
  description?: string
}

export interface AskUserQuestion {
  question: string
  header?: string
  options: AskUserOption[]
  multiSelect?: boolean
}

interface Answer {
  picked: number[]
  other: string
}

const emptyAnswer = (): Answer => ({ picked: [], other: "" })

function answerText(q: AskUserQuestion, a: Answer): string {
  const parts = a.picked
    .slice()
    .sort((x, y) => x - y)
    .map((i) => q.options[i]?.label)
    .filter(Boolean) as string[]
  if (a.other.trim()) parts.push(a.other.trim())
  return parts.join(", ")
}

function isAnswered(a: Answer): boolean {
  return a.picked.length > 0 || a.other.trim().length > 0
}

/** Validate the tool input: it arrives from the model and may be partial while streaming. */
export function parseAskUserInput(input: unknown): AskUserQuestion[] | null {
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs) || qs.length === 0) return null
  const out: AskUserQuestion[] = []
  for (const q of qs) {
    const question = typeof q?.question === "string" ? q.question.trim() : ""
    const options = Array.isArray(q?.options)
      ? (q.options as unknown[])
          .map((o) => {
            const oo = o as { label?: unknown; description?: unknown }
            return {
              label: typeof oo?.label === "string" ? oo.label.trim() : "",
              description: typeof oo?.description === "string" ? oo.description.trim() : undefined,
            }
          })
          .filter((o) => o.label)
      : []
    if (!question || options.length < 2) return null
    out.push({
      question,
      header: typeof q?.header === "string" && q.header.trim() ? q.header.trim() : undefined,
      options,
      multiSelect: q?.multiSelect === true,
    })
  }
  return out
}

interface AskUserCardProps {
  questions: AskUserQuestion[]
  /** True when this is the open question: the latest message and the stream has ended. */
  active: boolean
  /** The reply that answered it, once one exists. */
  answeredText?: string
  onAnswer: (text: string) => void
}

export function AskUserCard({ questions, active, answeredText, onAnswer }: AskUserCardProps) {
  const [tab, setTab] = useState(0)
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(emptyAnswer))
  const [cursor, setCursor] = useState(0)
  const [sent, setSent] = useState(false)

  const rowRefs = useRef<Array<HTMLElement | null>>([])
  const otherRef = useRef<HTMLInputElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  const multiQuestion = questions.length > 1
  const q = questions[tab]
  const a = answers[tab] ?? emptyAnswer()
  const otherRow = q.options.length // the "type your own" row sits after the options
  const locked = !active || sent || answeredText !== undefined
  const allAnswered = answers.every(isAnswered)

  const focusRow = useCallback((i: number) => {
    setCursor(i)
    const el = i === otherRow ? otherRef.current : rowRefs.current[i]
    el?.focus({ preventScroll: true })
  }, [otherRow])

  // Take focus when the question appears, so arrow keys work straight away.
  useEffect(() => {
    if (locked) return
    const t = setTimeout(() => {
      rowRefs.current[0]?.focus({ preventScroll: true })
      cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }, 60)
    return () => clearTimeout(t)
    // Only on becoming the open question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked])

  // Switching question returns the highlight to its first option.
  useEffect(() => {
    if (locked) return
    setCursor(0)
    rowRefs.current[0]?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const submit = useCallback((final: Answer[]) => {
    if (sent) return
    const text = multiQuestion
      ? questions.map((qq, i) => `${qq.header || qq.question}: ${answerText(qq, final[i])}`).join("\n")
      : answerText(questions[0], final[0])
    if (!text.trim()) return
    setSent(true)
    onAnswer(text)
  }, [sent, multiQuestion, questions, onAnswer])

  /** A question is settled: move to the next open one, or send when none are left. */
  const advance = useCallback((next: Answer[]) => {
    const open = next.findIndex((x, i) => i > tab && !isAnswered(x))
    const anyOpen = open >= 0 ? open : next.findIndex((x) => !isAnswered(x))
    if (anyOpen >= 0) setTab(anyOpen)
    else if (!multiQuestion) submit(next)
    // Several questions: stay put and let the Submit button take it from here,
    // so the user can review every answer before it goes.
  }, [tab, multiQuestion, submit])

  const pick = useCallback((i: number) => {
    if (locked) return
    const next = answers.map((x) => ({ ...x, picked: [...x.picked] }))
    const cur = next[tab]
    if (q.multiSelect) {
      cur.picked = cur.picked.includes(i) ? cur.picked.filter((p) => p !== i) : [...cur.picked, i]
      setAnswers(next)
      return
    }
    cur.picked = [i]
    cur.other = ""
    setAnswers(next)
    advance(next)
  }, [locked, answers, tab, q.multiSelect, advance])

  const commitOther = useCallback(() => {
    if (locked || !a.other.trim()) return
    const next = answers.map((x) => ({ ...x, picked: [...x.picked] }))
    if (!q.multiSelect) next[tab].picked = []
    setAnswers(next)
    advance(next)
  }, [locked, a.other, answers, q.multiSelect, tab, advance])

  const setOther = (text: string) => {
    setAnswers((prev) => prev.map((x, i) => (i === tab ? { ...x, other: text } : x)))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (locked) return
    const inOther = e.target === otherRef.current
    const rows = otherRow + 1

    if (e.key === "ArrowDown") {
      e.preventDefault()
      focusRow((cursor + 1) % rows)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      focusRow((cursor - 1 + rows) % rows)
    } else if (multiQuestion && !inOther && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault()
      setTab((t) => (e.key === "ArrowRight" ? (t + 1) % questions.length : (t - 1 + questions.length) % questions.length))
    } else if (!inOther && /^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1
      if (i < q.options.length) {
        e.preventDefault()
        setCursor(i)
        pick(i)
      }
    } else if (inOther && e.key === "Enter") {
      e.preventDefault()
      commitOther()
    }
  }

  // ── Answered: a compact record of what was asked and what came back ──
  if (answeredText !== undefined || sent) {
    const shown = answeredText ?? (multiQuestion
      ? questions.map((qq, i) => `${qq.header || qq.question}: ${answerText(qq, answers[i])}`).join("\n")
      : answerText(questions[0], answers[0]))
    return (
      <div className="my-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm">
        {questions.map((qq, i) => (
          <p key={i} className="text-muted-foreground">{qq.question}</p>
        ))}
        <div className="mt-1.5 flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
          <span className="whitespace-pre-wrap font-medium text-foreground">{shown}</span>
        </div>
      </div>
    )
  }

  // ── Open question ──
  return (
    <div
      ref={cardRef}
      className={cn(
        "my-3 overflow-hidden rounded-xl border bg-card shadow-sm transition-opacity",
        !active && "pointer-events-none opacity-60",
      )}
      onKeyDown={onKeyDown}
    >
      {multiQuestion && (
        <div className="flex flex-wrap gap-1 border-b bg-muted/30 px-3 py-2" role="tablist" aria-label="Questions">
          {questions.map((qq, i) => {
            const done = isAnswered(answers[i])
            return (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === tab}
                tabIndex={-1}
                onClick={() => setTab(i)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  i === tab ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {done ? (
                  <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-500" aria-hidden />
                ) : (
                  <span className="tabular-nums">{i + 1}</span>
                )}
                <span className="max-w-[10rem] truncate">{qq.header || `Question ${i + 1}`}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="px-4 pb-3 pt-3.5">
        <p className="text-[15px] font-medium leading-snug text-foreground">{q.question}</p>
        {q.multiSelect && <p className="mt-0.5 text-xs text-muted-foreground">Pick all that apply</p>}

        <div
          className="mt-3 space-y-1.5"
          role={q.multiSelect ? "group" : "radiogroup"}
          aria-label={q.question}
        >
          {q.options.map((opt, i) => {
            const selected = a.picked.includes(i)
            const highlighted = cursor === i
            return (
              <button
                key={i}
                ref={(el) => { rowRefs.current[i] = el }}
                type="button"
                role={q.multiSelect ? "checkbox" : "radio"}
                aria-checked={selected}
                tabIndex={highlighted ? 0 : -1}
                onClick={() => { setCursor(i); pick(i) }}
                onFocus={() => setCursor(i)}
                onKeyDown={(e) => {
                  if (e.key === " " && q.multiSelect) { e.preventDefault(); pick(i) }
                  if (e.key === "Enter") { e.preventDefault(); pick(i) }
                }}
                className={cn(
                  "group/opt flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-colors",
                  selected
                    ? "border-primary/60 bg-primary/[0.06]"
                    : "border-border hover:border-foreground/25 hover:bg-muted/50",
                  highlighted && "ring-2 ring-primary/40 ring-offset-1 ring-offset-background",
                )}
              >
                <span
                  className={cn(
                    "mt-px flex h-5 min-w-5 shrink-0 items-center justify-center rounded border px-1 text-[11px] font-medium tabular-nums",
                    q.multiSelect && "rounded-[5px]",
                    selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted/60 text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {selected && q.multiSelect ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-5 text-foreground">{opt.label}</span>
                  {opt.description && (
                    <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{opt.description}</span>
                  )}
                </span>
                {!q.multiSelect && highlighted && (
                  <CornerDownLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
                )}
              </button>
            )
          })}

          {/* Always possible to answer in your own words. */}
          <div
            className={cn(
              "flex items-center gap-3 rounded-lg border border-dashed px-3 py-2 transition-colors",
              cursor === otherRow ? "border-primary/50 ring-2 ring-primary/40 ring-offset-1 ring-offset-background" : "border-border",
            )}
          >
            <PenLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={otherRef}
              value={a.other}
              onChange={(e) => setOther(e.target.value)}
              onFocus={() => setCursor(otherRow)}
              tabIndex={cursor === otherRow ? 0 : -1}
              placeholder="Something else… type it and press Enter"
              className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
              aria-label="Type a different answer"
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-4 py-2">
        <p className="text-[11px] text-muted-foreground">
          <Kbd>↑</Kbd><Kbd>↓</Kbd> move
          <span className="mx-1.5">·</span>
          <Kbd>1</Kbd>–<Kbd>{Math.min(9, q.options.length)}</Kbd> pick
          <span className="mx-1.5">·</span>
          <Kbd>Enter</Kbd> {q.multiSelect ? "toggle" : "choose"}
          {multiQuestion && (
            <>
              <span className="mx-1.5">·</span>
              <Kbd>←</Kbd><Kbd>→</Kbd> questions
            </>
          )}
        </p>
        {(q.multiSelect || multiQuestion) && (
          <FooterAction
            label={multiQuestion ? (allAnswered ? "Submit answers" : "Next") : "Continue"}
            disabled={multiQuestion ? !isAnswered(a) && !allAnswered : !isAnswered(a)}
            onClick={() => {
              if (multiQuestion && allAnswered) submit(answers)
              else if (multiQuestion) advance(answers)
              else submit(answers)
            }}
          />
        )}
      </div>
    </div>
  )
}

function FooterAction({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
      <CornerDownLeft className="h-3 w-3" aria-hidden />
    </button>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-background px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}
