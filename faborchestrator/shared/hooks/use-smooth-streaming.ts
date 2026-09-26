"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"

interface UseSmoothStreamingOptions {
  /** Characters to reveal per tick (default: 3) */
  charsPerTick?: number
  /** Milliseconds between ticks (default: 16 for ~60fps) */
  tickInterval?: number
  /** Whether streaming is active (default: true) */
  isStreaming?: boolean
  /** Callback when streaming completes */
  onComplete?: () => void
  /** Adaptive speed - increases when far behind (default: true) */
  adaptiveSpeed?: boolean
  /** Maximum characters to catch up per tick when behind (default: 20) */
  maxCatchUpChars?: number
}

/**
 * Hook for smooth text streaming animation
 * Buffers incoming text and reveals it gradually for a smoother reading experience
 * Optimized for performance with requestAnimationFrame
 */
export function useSmoothStreaming(
  targetText: string,
  options: UseSmoothStreamingOptions = {}
) {
  const {
    charsPerTick = 3,
    tickInterval = 16, // ~60fps
    isStreaming = true,
    onComplete,
    adaptiveSpeed = true,
    maxCatchUpChars = 20,
  } = options

  // Respect reduced-motion preference: skip character-by-character reveal
  const prefersReducedMotion = useMemo(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  [])

  const [displayedText, setDisplayedText] = useState("")
  const displayedLengthRef = useRef(0)
  const animationFrameRef = useRef<number | null>(null)
  const lastTickRef = useRef(0)
  const completedRef = useRef(false)
  const targetTextRef = useRef(targetText)

  // Keep targetText in a ref to avoid closure issues
  targetTextRef.current = targetText

  const animate = useCallback((timestamp: number) => {
    // Throttle updates based on tickInterval
    if (timestamp - lastTickRef.current < tickInterval) {
      animationFrameRef.current = requestAnimationFrame(animate)
      return
    }
    lastTickRef.current = timestamp

    const currentLength = displayedLengthRef.current
    const targetLength = targetTextRef.current.length

    if (currentLength < targetLength) {
      // Calculate how many chars to add
      let charsToAdd = charsPerTick

      if (adaptiveSpeed) {
        const behind = targetLength - currentLength
        // Smooth adaptive catch-up: use behind/3 for faster convergence
        // This prevents the "stuck then burst" feeling
        charsToAdd = Math.min(
          Math.max(charsPerTick, Math.ceil(behind / 3)),
          maxCatchUpChars
        )
      }

      const newLength = Math.min(currentLength + charsToAdd, targetLength)
      displayedLengthRef.current = newLength
      setDisplayedText(targetTextRef.current.slice(0, newLength))

      animationFrameRef.current = requestAnimationFrame(animate)
    } else if (!completedRef.current && !isStreaming) {
      // Streaming done and we've caught up
      completedRef.current = true
      onComplete?.()
      // Don't schedule another frame -- we're done
    }
    // When caught up but still streaming, let the loop stop.
    // The useEffect watching targetText will restart it when new content arrives.
  }, [charsPerTick, tickInterval, isStreaming, onComplete, adaptiveSpeed, maxCatchUpChars])

  useEffect(() => {
    // If user prefers reduced motion, skip animation entirely
    if (prefersReducedMotion) {
      displayedLengthRef.current = targetText.length
      setDisplayedText(targetText)
      if (!isStreaming && !completedRef.current) {
        completedRef.current = true
        onComplete?.()
      }
      return
    }

    // Reset completion state when text changes
    if (targetText.length > 0) {
      completedRef.current = false
    }

    // Start animation
    animationFrameRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [animate, targetText, prefersReducedMotion, isStreaming, onComplete])

  // When streaming stops, smoothly catch up to the end
  useEffect(() => {
    if (!isStreaming && displayedLengthRef.current < targetText.length) {
      // Use rAF for smoother catch-up instead of fixed delay
      const raf = requestAnimationFrame(() => {
        displayedLengthRef.current = targetText.length
        setDisplayedText(targetText)
        if (!completedRef.current) {
          completedRef.current = true
          onComplete?.()
        }
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [isStreaming, targetText, onComplete])

  const progress = useMemo(() =>
    targetText.length > 0 ? displayedLengthRef.current / targetText.length : 1,
    [targetText.length]
  )

  return {
    displayedText,
    isComplete: displayedLengthRef.current >= targetText.length && !isStreaming,
    progress,
    /** Number of characters displayed */
    displayedLength: displayedLengthRef.current,
    /** Total characters in target text */
    targetLength: targetText.length,
  }
}

/**
 * Typing cursor effect - visibility driven by CSS .animate-smooth-blink
 * No JS interval needed; the CSS animation handles the blink.
 */
export function useTypingCursor(isTyping: boolean) {
  // Cursor visibility is handled by CSS .animate-smooth-blink
  // No need for a JS setInterval that causes React re-renders every 530ms
  return isTyping ? "|" : ""
}
