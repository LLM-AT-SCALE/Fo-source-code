"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { ArtifactPreview } from "@/shared/components/artifact-preview"
import type { Artifact } from "@/shared/lib/artifacts"

type AnimPhase = 'entering' | 'visible' | 'exiting'

interface ArtifactPanelWrapperProps {
  artifact: Artifact
  artifacts: Artifact[]
  currentIndex: number
  isStreaming: boolean
  onClose: () => void
  onNavigate: (index: number) => void
  onFetchFileContent?: (fileId: string, mimeType?: string) => Promise<string>
  onFetchFileArrayBuffer?: (fileId: string) => Promise<ArrayBuffer>
  fileContentCache?: (fileId: string) => { content?: string; blobUrl?: string; loading: boolean; error?: string } | null
  /** Whether the panel is logically open (true) or closing (false) */
  isOpen: boolean
  /** Called when exit animation completes and the panel can be fully unmounted */
  onExitComplete: () => void
  /** Id of the assistant message the artifact came from (needed to pin it for scheduling). */
  messageId?: string
}

/**
 * Wraps ArtifactPreview with animation lifecycle management.
 *
 * The problem: When showArtifactPreview goes false, the Panel unmounts immediately,
 * which means no exit animation is possible and the PanelGroup recalculates layout
 * abruptly. This wrapper manages a 3-phase animation lifecycle:
 *
 *   entering (250ms) -> visible (steady state) -> exiting (200ms) -> unmount
 *
 * During 'entering', heavy content is deferred (ArtifactPreview shows skeleton).
 * During 'exiting', the panel stays mounted with pointer-events:none while the
 * CSS transition slides it out, then calls onExitComplete to trigger actual unmount.
 */
export function ArtifactPanelWrapper({
  artifact,
  artifacts,
  currentIndex,
  isStreaming,
  onClose,
  onNavigate,
  onFetchFileContent,
  onFetchFileArrayBuffer,
  fileContentCache,
  isOpen,
  onExitComplete,
  messageId,
}: ArtifactPanelWrapperProps) {
  const [phase, setPhase] = useState<AnimPhase>('entering')
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  // On mount: entering -> visible after one frame (triggers CSS transition)
  useEffect(() => {
    // Use double-rAF to ensure the browser has painted the initial state
    // before transitioning. This guarantees the CSS transition runs.
    let raf2: number
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (phaseRef.current === 'entering') {
          setPhase('visible')
        }
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, []) // Only run on mount

  // When isOpen goes false, start exit animation
  useEffect(() => {
    if (!isOpen && phaseRef.current !== 'exiting') {
      setPhase('exiting')
    }
  }, [isOpen])

  const handleExitComplete = useCallback(() => {
    onExitComplete()
  }, [onExitComplete])

  return (
    <ArtifactPreview
      artifact={artifact}
      artifacts={artifacts}
      currentIndex={currentIndex}
      isStreaming={isStreaming}
      onClose={onClose}
      onNavigate={onNavigate}
      onFetchFileContent={onFetchFileContent}
      onFetchFileArrayBuffer={onFetchFileArrayBuffer}
      fileContentCache={fileContentCache}
      animationPhase={phase}
      onExitComplete={handleExitComplete}
      messageId={messageId}
    />
  )
}
