/**
 * THE WORK PRODUCT PANEL — the PRD and the mock screen, side by side with the
 * conversation that produced them.
 *
 * Ported from the standalone app's side pane, control for control, in
 * FabOrchestrator's own primitives. What each piece is for, since a control
 * without a reason is a control nobody can safely remove:
 *
 * TABS. Both documents are always reachable. Before them the panel showed
 * whichever card you last clicked, and the only way to the other one was to
 * scroll the transcript back to its chip — which a reader comparing the spec
 * against the screen it describes did on every single comparison. Each tab
 * DISABLES itself when its content does not exist, so the panel never offers a
 * dead view; a disabled tab and a tab showing "nothing here yet" read very
 * differently, and only one of them tells you to stop clicking.
 *
 * THE VERDICT travels with the panel because the panel is where the artifact is
 * being LOOKED at. It reads the same run state the transcript does, so the two
 * can never disagree.
 *
 * THE INDEX RAIL is built from the RENDERED document rather than from the
 * markdown, so it cannot describe a document other than the one on screen.
 *
 * FULL SCREEN and CLOSE: a PRD is a document people read, and half a window is
 * not always enough. Closing is not a one-way door — the deployment-unit card in
 * the transcript puts the panel back.
 */
"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Download, Maximize2, Minimize2, X } from "lucide-react"
import { CodeBlock, CodeBlockCode } from "@/shared/components/prompt-kit/code-block"
import { formatForReading } from "@/modules/coding-agent/lib/format-for-reading"
import { Button } from "@/shared/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs"
import { Markdown } from "@/shared/components/prompt-kit/markdown"
import { cn } from "@/shared/lib/utils"

export type PanelTab = "prd" | "screen" | "code"

/** An artifact opened from the transcript: its name, its text, its language. */
export interface OpenFile {
  name: string
  language: string
  content: string
  /** set while the fetch is in flight, so the panel can say so */
  loading?: boolean
  error?: string | null
}

export interface WorkState {
  prd: string | null
  previewHtml: string | null
  hasArtifact: boolean
  page: string | null
  unit: Array<{ name: string; chars: number }>
  document: string | null
  verdict: { PASS: number; WARN: number; FAIL: number } | null
  specNewerThanArtifact: boolean
}

/** `## Heading` lines, in order. Read from the markdown the panel is rendering,
 *  so the rail and the document cannot drift apart. */
function headingsOf(md: string): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = []
  for (const line of md.split("\n")) {
    const m = /^(#{1,3})\s+(.*\S)\s*$/.exec(line)
    if (!m) continue
    const text = m[2]!.replace(/[*_`]/g, "")
    out.push({ id: text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), text })
  }
  return out
}

function Verdict({ v }: { v: NonNullable<WorkState["verdict"]> }) {
  const tone = v.FAIL
    ? "bg-destructive/10 text-destructive"
    : v.WARN
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
  return (
    <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", tone)}>
      {v.PASS} passed
      {v.WARN ? ` · ${v.WARN} warning${v.WARN === 1 ? "" : "s"}` : ""}
      {v.FAIL ? ` · ${v.FAIL} failing` : ""}
    </span>
  )
}

export function WorkPanel({
  work,
  tab,
  onTab,
  expanded,
  onToggleExpand,
  onClose,
  onDownloadUnit,
  onDownloadPrd,
  file,
}: {
  work: WorkState
  tab: PanelTab
  onTab: (t: PanelTab) => void
  /** the artifact being read, when the reader clicked one */
  file: OpenFile | null
  expanded: boolean
  onToggleExpand: () => void
  onClose: () => void
  onDownloadUnit: () => void
  onDownloadPrd: () => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const headings = useMemo(() => (work.prd ? headingsOf(work.prd) : []), [work.prd])

  /*
   * Escape leaves full screen — the overlay covers the whole window, so it is
   * the only thing the key could sensibly mean.
   *
   * THE PANEL IS FOCUSED WHEN IT OPENS, and that is load-bearing rather than a
   * courtesy. The Screen tab renders a SANDBOXED iframe, and a keydown inside
   * one never reaches the parent document: with focus left wherever it happened
   * to be, opening the screen full-screen and pressing Escape did nothing at
   * all. Focusing the panel means the key lands on us.
   *
   * If the reader then clicks INTO the preview, Escape stops working again.
   * That is the sandbox boundary and not something this side can reach across —
   * which is exactly why the minimise button stays, rather than the key being
   * the only way out.
   */
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!expanded) return
    rootRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggleExpand()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [expanded, onToggleExpand])

  /* A REAL WORD FILE, BUILT ON THE SERVER.
     The PRD is what an engineer forwards, comments on and takes into a review.
     Markdown is not that, and neither is HTML renamed: Word opens an HTML file
     as a web page, where comments and tracked changes do not behave. The server
     converts the same markdown the panel is rendering, so the file that leaves
     and the document on screen cannot drift. */
  const downloadPrd = () => onDownloadPrd()

  const downloadText = (name: string, content: string) => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }))
    const a = document.createElement("a")
    a.href = url
    a.download = name.replace(/[^A-Za-z0-9._-]+/g, "_")
    a.click()
    URL.revokeObjectURL(url)
  }

  const title =
    tab === "code" ? (file?.name ?? "Code")
      : tab === "prd" ? "PRD"
      : "Mock screen"
  const subtitle =
    tab === "code"
      ? file?.error
        ? file.error
        : file?.loading
          ? "opening"
          /* No character count. It answers a question nobody asked, and it was
             the first thing truncated in a narrow panel — so the subtitle's only
             job became showing half a number. */
          : "exactly what the deployment unit contains"
      : tab === "prd"
        ? (work.document ?? "written from the requirement")
        : work.specNewerThanArtifact
          ? "drawn from the current spec — newer than the generated page"
          : "wireframe, not a CMF rendering"

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => onTab(v as PanelTab)}
      className="flex h-full min-h-0 flex-col outline-none"
      ref={rootRef}
      tabIndex={-1}
    >
      {/* row 1 — which document, and how it scored */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <TabsList>
          <TabsTrigger value="prd" disabled={!work.prd}>
            PRD
          </TabsTrigger>
          <TabsTrigger value="screen" disabled={!work.previewHtml}>
            Screen
          </TabsTrigger>
          {/* NOT RENDERED until an artifact has been opened. Disabling it was
              not enough: a greyed-out Code tab sits beside the PRD for the whole
              specification step, advertising a view that does not exist yet. The
              panel should offer what it has. */}
          {file && <TabsTrigger value="code">Code</TabsTrigger>}
        </TabsList>
        {work.verdict && <Verdict v={work.verdict} />}
      </div>

      {/* row 2 — what you are looking at, and what you can do with it */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
        <b className="text-sm">{title}</b>
        <span className="truncate text-[11.5px] text-muted-foreground">{subtitle}</span>
        <span className="ml-auto flex items-center gap-1">
          {tab === "prd" && work.prd && (
            <Button variant="ghost" size="icon" className="size-8" onClick={downloadPrd}
                    title="Download the PRD as Word" aria-label="Download the PRD">
              <Download className="size-4" />
            </Button>
          )}
          {tab === "code" && file && !file.loading && !file.error && (
            <Button variant="ghost" size="icon" className="size-8"
                    onClick={() => downloadText(file.name, file.content)}
                    title={`Download ${file.name}`} aria-label="Download this file">
              <Download className="size-4" />
            </Button>
          )}
          {work.hasArtifact && (
            <Button variant="outline" size="sm" onClick={onDownloadUnit}>
              Download unit
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-8" onClick={onToggleExpand}
                  aria-pressed={expanded}
                  title={expanded ? "Leave full screen" : "Expand to full screen"}
                  aria-label={expanded ? "Leave full screen" : "Expand to full screen"}>
            {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={onClose}
                  title="Close" aria-label="Close">
            <X className="size-4" />
          </Button>
        </span>
      </div>

      <TabsContent value="prd" className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0">
          {/* The index rail. Hidden on a short document, where it would be a
              second copy of what is already on screen. */}
          {headings.length > 2 && (
            <nav aria-label="PRD sections"
                 className="hidden w-52 shrink-0 overflow-auto border-r px-3 py-5 lg:block">
              {headings.map((h) => (
                <button
                  key={h.id}
                  onClick={() => {
                    setActive(h.id)
                    /* FOUND BY ITS TEXT, not by an anchor id.
                       The rail was querying `[data-h="…"]`, and the markdown
                       renderer emits no such attribute — so every entry
                       silently scrolled nowhere. The renderer does not give us
                       ids to hook, and adding a custom renderer to plant them
                       would fork the component the rest of the app shares, so
                       the headings are matched on the words the rail is already
                       showing. Same source, so the two cannot disagree. */
                    const wanted = h.text.trim().toLowerCase()
                    const body = bodyRef.current
                    const hit = [...(body?.querySelectorAll("h1, h2, h3") ?? [])].find(
                      (n) => (n.textContent ?? "").trim().toLowerCase() === wanted,
                    )
                    /* SCROLLED EXPLICITLY, not by `scrollIntoView`.
                       That worked in the side panel and did nothing in full
                       screen — measured: the heading sat at 4823px in a 950px
                       viewport and did not move, though the container reported
                       clientHeight 837 against scrollHeight 5029 and so could
                       plainly scroll. Moving the container by the measured
                       offset does not depend on how the browser chooses to walk
                       ancestors, and behaves the same in both layouts. */
                    if (body && hit) {
                      const delta = hit.getBoundingClientRect().top - body.getBoundingClientRect().top
                      body.scrollTo({ top: body.scrollTop + delta, behavior: "smooth" })
                    }
                  }}
                  className={cn(
                    "block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted",
                    active === h.id ? "text-foreground font-medium" : "text-muted-foreground",
                  )}
                >
                  {h.text}
                </button>
              ))}
            </nav>
          )}
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto px-6 py-5">
            {work.prd ? (
              <Markdown className="prose prose-sm dark:prose-invert max-w-none">
                {work.prd}
              </Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">
                The PRD appears here once it is written.
              </p>
            )}
          </div>
        </div>
      </TabsContent>

      <TabsContent value="code" className="min-h-0 flex-1 overflow-auto p-4">
        {file?.loading ? (
          <p className="text-sm text-muted-foreground">Opening {file.name}…</p>
        ) : file?.error ? (
          <p className="text-sm text-destructive">{file.error}</p>
        ) : file ? (
          /* FORMATTED FOR READING, not rewritten. A CMF export is a single line
             — the one measured here was 43,784 characters on line 1 of 1 — so
             the panel showed one line and a horizontal scrollbar. Line breaks
             and indentation are inserted between tags on a copy; the bytes on
             disk and in the deployment unit are untouched, which matters because
             the reason to open this is to check the real thing. */
          <CodeBlock className="max-w-full overflow-x-auto">
            <CodeBlockCode
              code={formatForReading(file.content, file.language)}
              language={file.language}
            />
          </CodeBlock>
        ) : (
          <p className="text-sm text-muted-foreground">
            Click any artifact in the conversation to read it here.
          </p>
        )}
      </TabsContent>

      <TabsContent value="screen" className="min-h-0 flex-1 p-0">
        {work.previewHtml ? (
          <iframe
            title="Mock screen"
            className="h-full w-full border-0"
            sandbox=""
            srcDoc={work.previewHtml}
          />
        ) : (
          <p className="p-6 text-sm text-muted-foreground">
            The screen is drawn from the requirement, before any code exists.
          </p>
        )}
      </TabsContent>
    </Tabs>
  )
}
