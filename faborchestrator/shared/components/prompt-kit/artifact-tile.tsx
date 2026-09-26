"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/shared/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/components/ui/collapsible"
import { cn } from "@/shared/lib/utils"
import {
  ChevronDown,
  Loader2,
  FileText,
  GitGraph,
} from "lucide-react"
import type { Artifact } from "@/shared/lib/artifacts"
import { getArtifactExtension, getArtifactMimeType } from "@/shared/lib/artifacts"

interface ArtifactTileProps {
  artifact: Artifact
  isStreaming: boolean
  onOpenPreview: () => void
  /**
   * Download this artifact some other way than writing the content it holds.
   *
   * The default is right whenever the tile's content IS the file. It is wrong
   * when the two differ: the PRD tile holds MARKDOWN and is labelled DOCX
   * because the conversion happens on the server, so the default would hand
   * over a .docx-named file full of markdown.
   *
   * Optional: omitted, the built-in download is used unchanged.
   */
  onDownload?: () => void
  className?: string
}

function getTypeLabel(artifact: Artifact): string {
  switch (artifact.renderStrategy) {
    case 'sandpack': return 'REACT'
    case 'markdown-render': return 'MD'
    case 'mermaid-diagram': return 'MERMAID'
    /* The file's own language, not the highlighter's fallback. Without this a
       CMF XML export and a master-data JSON file were both labelled HTML —
       wrong about both, on the one line that says what the file IS. */
    case 'syntax-highlight': return artifact.language ?? 'CODE'
    case 'iframe-html':
      /* The mock screen arrives as HTML because that is how it is rendered;
         calling it HTML describes the transport rather than the artifact. */
      if (artifact.language === 'screen') return 'SCREEN'
      return artifact.language === 'xml' ? 'SVG' : 'HTML'
    default: return 'HTML'
  }
}

function getCategoryLabel(artifact: Artifact): string {
  switch (artifact.renderStrategy) {
    case 'markdown-render': return 'Document'
    case 'mermaid-diagram': return 'Diagram'
    /* A rendering of the page is not code to read; it is something to look at,
       and the category line is what tells the reader which. */
    case 'iframe-html':
      return artifact.language === 'screen' ? 'Preview' : 'Code'
    default: return 'Code'
  }
}

// SVG icon for the tilted card — matches the Phosphor "Code" light icon
function CodeBracketIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256" className={className}>
      <path d="M67.84,92.61,25.37,128l42.47,35.39a6,6,0,1,1-7.68,9.22l-48-40a6,6,0,0,1,0-9.22l48-40a6,6,0,0,1,7.68,9.22Zm176,30.78-48-40a6,6,0,1,0-7.68,9.22L230.63,128l-42.47,35.39a6,6,0,1,0,7.68,9.22l48-40a6,6,0,0,0,0-9.22Zm-81.79-89A6,6,0,0,0,154.36,38l-64,176A6,6,0,0,0,94,221.64a6.15,6.15,0,0,0,2,.36,6,6,0,0,0,5.64-3.95l64-176A6,6,0,0,0,162.05,34.36Z" />
    </svg>
  )
}

// Mermaid/diagram icon for the tilted card
function DiagramIcon({ className }: { className?: string }) {
  return <GitGraph className={className} width={20} height={20} />
}

// Document icon for the tilted card
function DocumentIcon({ className }: { className?: string }) {
  return <FileText className={className} width={20} height={20} />
}

function getTiltedIcon(artifact: Artifact) {
  const cls = "text-muted-foreground"
  switch (artifact.renderStrategy) {
    case 'markdown-render': return <DocumentIcon className={cls} />
    case 'mermaid-diagram': return <DiagramIcon className={cls} />
    default: return <CodeBracketIcon className={cls} />
  }
}

export function ArtifactTile({
  artifact,
  isStreaming,
  onOpenPreview,
  onDownload,
  className,
}: ArtifactTileProps) {
  // Collapsed by default; user can manually expand during streaming. Auto-collapse when streaming ends.
  const [userCollapsed, setUserCollapsed] = useState(true)
  const isOpen = isStreaming ? !userCollapsed : false
  const codeRef = useRef<HTMLPreElement>(null)

  // Auto-scroll code during streaming — throttled to avoid layout thrashing
  const scrollRafRef = useRef<number>(0)
  useEffect(() => {
    if (isStreaming && isOpen && codeRef.current) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = requestAnimationFrame(() => {
        if (codeRef.current) {
          codeRef.current.scrollTop = codeRef.current.scrollHeight
        }
      })
    }
    return () => cancelAnimationFrame(scrollRafRef.current)
  }, [artifact.content, isStreaming, isOpen])

  const typeLabel = getTypeLabel(artifact)
  const categoryLabel = getCategoryLabel(artifact)

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation()
    /* The caller's handler replaces this one entirely rather than running
       alongside it — two downloads from one click is not a fallback. */
    if (onDownload) { onDownload(); return }
    const ext = getArtifactExtension(artifact)
    const mime = getArtifactMimeType(artifact)
    const blob = new Blob([artifact.content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${artifact.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}${ext}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ─── Completed state: card tile with tilted icon ───
  if (!isStreaming) {
    return (
      <div
        className={cn(
          "group/artifact-block my-2 w-full max-w-[720px]",
          "flex items-center text-left rounded-lg overflow-hidden",
          "border border-border/50 transition-colors duration-300",
          "h-[71px] px-4",
          "hover:bg-muted/50 hover:border-border cursor-pointer",
          className
        )}
        onClick={onOpenPreview}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpenPreview() }}
        aria-label="Preview contents"
      >
        <div className="flex flex-1 items-center justify-between w-full h-full">
          <div className="flex flex-1 gap-2 min-w-0 h-full items-center">
            {/* Animated tilted file icon */}
            <div className="flex items-end w-[68px] h-full relative shrink-0 overflow-hidden">
              <div className={cn(
                "absolute left-2 right-2 flex flex-col items-center justify-start",
                "w-[52px] h-full pt-4 rounded-t-lg",
                "border border-border bg-gradient-to-b from-card to-transparent",
                "select-none transition-transform duration-300 ease-out",
                "translate-y-[19%] -rotate-[5.7deg]",
                "group-hover/artifact-block:scale-[1.035]",
                "group-hover/artifact-block:-rotate-[3.7deg]",
                "group-hover/artifact-block:duration-400",
                "group-hover/artifact-block:ease-[cubic-bezier(0,0.9,0.5,1.35)]",
                "backface-hidden will-change-transform"
              )}>
                {getTiltedIcon(artifact)}
              </div>
            </div>

            {/* Text content */}
            <div className="flex flex-col gap-1 py-4 min-w-0 flex-1">
              <div className="leading-tight text-sm font-medium line-clamp-1 text-foreground">
                {artifact.title}
              </div>
              <div className="text-xs line-clamp-1 text-muted-foreground">
                {categoryLabel}<span className="opacity-50 mx-1">·</span>{typeLabel}
              </div>
            </div>
          </div>

          {/* Download button */}
          <div className="flex min-w-0 items-center justify-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="lg"
              className={cn(
                "relative shrink-0 select-none",
                "border-border bg-transparent text-foreground font-medium",
                "px-4 min-w-[5rem]",
                "active:scale-[0.985] whitespace-nowrap transition-transform duration-100 text-sm",
                "hover:bg-muted/80 dark:hover:bg-muted/80"
              )}
              type="button"
              aria-label="Download"
              onClick={handleDownload}
            >
              Download
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ─── Streaming state: collapsible with live code ───
  return (
    <div
      className={cn(
        "my-2 w-full max-w-[720px] overflow-hidden rounded-lg border border-border bg-card",
        className
      )}
    >
      <Collapsible open={isOpen} onOpenChange={(open) => setUserCollapsed(!open)}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto min-h-[56px] w-full justify-between rounded-none px-3 py-3 font-normal hover:bg-muted"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Loader2 className="h-4 w-4 animate-spin text-status-info shrink-0" />
              <span className="text-sm font-medium truncate">
                {artifact.title}
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-status-info-muted text-status-info-foreground shrink-0">
                Generating...
              </span>
            </div>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform duration-200 shrink-0",
                isOpen && "rotate-180"
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border bg-muted/30">
            <pre
              ref={codeRef}
              className="max-h-48 overflow-auto p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words"
            >
              {artifact.content}
              <span
                className="inline-block h-2 w-2 rounded-full bg-primary ml-1 align-middle"
                style={{ animation: "pulse-dot 1.2s ease-in-out infinite" }}
                aria-hidden="true"
              />
            </pre>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
