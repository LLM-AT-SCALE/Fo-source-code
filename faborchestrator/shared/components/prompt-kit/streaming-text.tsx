"use client"

import * as React from "react"
import { useSmoothStreaming, useTypingCursor } from "@/shared/hooks/use-smooth-streaming"
import { Markdown } from "@/shared/components/prompt-kit/markdown"
import type { Components } from "react-markdown"
import { cn } from "@/shared/lib/utils"

interface StreamingTextProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The full text content (can be partial during streaming) */
  content: string
  /** Whether the content is still streaming */
  isStreaming?: boolean
  /** Render as markdown */
  markdown?: boolean
  /** Characters to reveal per animation tick */
  charsPerTick?: number
  /** Show typing cursor at end */
  showCursor?: boolean
  /** Cursor style - 'block' shows a block cursor, 'line' shows a thin line, 'pulse-dot' shows a pulsing dot */
  cursorStyle?: "block" | "line" | "pulse-dot"
  /** Callback when text display catches up to content */
  onDisplayComplete?: () => void
  /** Enable adaptive speed to catch up when behind */
  adaptiveSpeed?: boolean
  /** Custom markdown components to merge into the Markdown renderer */
  markdownComponents?: Partial<Components>
}

/**
 * StreamingText component for smooth text animation
 * Creates a natural typing effect instead of chunky updates
 * Optimized for performance with requestAnimationFrame
 */
export function StreamingText({
  content,
  isStreaming = false,
  markdown = false,
  charsPerTick = 6,
  showCursor = true,
  cursorStyle = "pulse-dot",
  onDisplayComplete,
  adaptiveSpeed = true,
  markdownComponents,
  className,
  ...props
}: StreamingTextProps) {
  const { displayedText, isComplete } = useSmoothStreaming(content, {
    charsPerTick,
    isStreaming,
    onComplete: onDisplayComplete,
    adaptiveSpeed,
    maxCatchUpChars: 40,
  })

  // useTypingCursor now returns a static "|" when active (no JS interval).
  // The blink animation is handled purely by CSS .animate-smooth-blink.
  const cursor = useTypingCursor(isStreaming && !isComplete)

  // For non-streaming content, show immediately
  const textToShow = isStreaming ? displayedText : content
  const shouldShowCursor = showCursor && isStreaming && !isComplete
  const usePulseDot = cursorStyle === "pulse-dot" && isStreaming && !isComplete

  // Memoize cursor element -- stable now that cursor doesn't toggle via JS
  const cursorEl = React.useMemo(() => {
    // pulse-dot uses CSS ::after, no element needed
    if (!shouldShowCursor || cursorStyle === "pulse-dot") return null

    if (cursorStyle === "line") {
      return (
        <span
          className="inline-block w-0.5 h-[1.1em] bg-primary ml-0.5 align-middle animate-smooth-blink"
          aria-hidden="true"
        />
      )
    }

    return (
      <span
        className="inline-block text-primary ml-0.5 animate-smooth-blink font-mono"
        aria-hidden="true"
      >
        {cursor || "|"}
      </span>
    )
  }, [shouldShowCursor, cursorStyle, cursor])

  if (markdown) {
    return (
      <div className={cn("relative", usePulseDot && "streaming-pulse-dot", className)} {...props}>
        <Markdown components={markdownComponents}>{textToShow}</Markdown>
        {cursorEl}
      </div>
    )
  }

  return (
    <div className={cn("relative", usePulseDot && "streaming-pulse-dot", className)} {...props}>
      <span className="whitespace-pre-wrap">{textToShow}</span>
      {cursorEl}
    </div>
  )
}

/**
 * Simple streaming wrapper that just adds smooth fade-in for new content
 * Uses CSS transitions instead of JavaScript animation - lighter weight
 */
export function SmoothContent({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-slide-up-fade",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/**
 * Typing indicator - three animated dots
 * Used to show the AI is "thinking"
 */
export function TypingIndicator({
  className,
  text = "Thinking",
  showText = true,
}: {
  className?: string
  text?: string
  showText?: boolean
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 bg-primary/60 rounded-full"
            style={{
              animation: "typing 1.4s infinite ease-in-out",
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}
      </div>
      {showText && (
        <span className="text-sm text-muted-foreground animate-gentle-pulse">
          {text}
        </span>
      )}
    </div>
  )
}

/**
 * Progressive reveal wrapper
 * Wraps children and reveals them with a stagger animation
 */
export function ProgressiveReveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode
  delay?: number
  className?: string
}) {
  return (
    <div
      className={cn("animate-slide-up-fade", className)}
      style={{
        animationDelay: `${delay}ms`,
        animationFillMode: "both",
      }}
    >
      {children}
    </div>
  )
}

/**
 * Shimmer text effect - text with a moving highlight
 * Good for loading states or drawing attention
 */
export function ShimmerText({
  children,
  className,
  duration = 2,
}: {
  children: React.ReactNode
  className?: string
  duration?: number
}) {
  return (
    <span
      className={cn(
        "bg-gradient-to-r from-foreground via-primary to-foreground bg-[length:200%_100%] bg-clip-text text-transparent animate-shimmer",
        className
      )}
      style={{ animationDuration: `${duration}s` }}
    >
      {children}
    </span>
  )
}

/**
 * Streaming code block - optimized for code streaming
 * Shows code as it arrives with line-by-line reveal
 */
export function StreamingCode({
  code,
  language: _language = "plaintext",
  isStreaming = false,
  className,
}: {
  code: string
  language?: string
  isStreaming?: boolean
  className?: string
}) {
  const { displayedText, isComplete } = useSmoothStreaming(code, {
    charsPerTick: 8, // Faster for code
    isStreaming,
    adaptiveSpeed: true,
    maxCatchUpChars: 50,
  })

  const textToShow = isStreaming ? displayedText : code
  const lines = textToShow.split("\n")

  return (
    <div className={cn("font-mono text-sm", className)}>
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="select-none pr-4 text-right text-muted-foreground/50 min-w-[3em]">
            {i + 1}
          </span>
          <span className="flex-1">
            {line || " "}
            {isStreaming && i === lines.length - 1 && !isComplete && (
              <span
                className="inline-block h-2 w-2 rounded-full bg-primary ml-1 align-middle"
                style={{ animation: "pulse-dot 1.2s ease-in-out infinite" }}
              />
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
