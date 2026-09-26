"use client"

import { useEffect, useCallback, useRef } from "react"

interface KeyboardShortcut {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  description: string
  action: () => void
}

export interface UseKeyboardShortcutsOptions {
  enabled?: boolean
  shortcuts: KeyboardShortcut[]
}

/**
 * Custom hook for managing keyboard shortcuts
 *
 * @example
 * ```tsx
 * useKeyboardShortcuts({
 *   shortcuts: [
 *     { key: 'k', ctrlKey: true, description: 'New chat', action: handleNewChat },
 *     { key: 'Escape', description: 'Clear input', action: handleClearInput },
 *   ],
 * })
 * ```
 */
export function useKeyboardShortcuts({
  enabled = true,
  shortcuts,
}: UseKeyboardShortcutsOptions) {
  const shortcutsRef = useRef(shortcuts)

  // Update ref when shortcuts change
  useEffect(() => {
    shortcutsRef.current = shortcuts
  }, [shortcuts])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return

      // Some keydown events carry no `key` (autofill, IME composition, and
      // programmatically-dispatched events); bail before touching it.
      if (!event.key) return

      // Don't trigger shortcuts when typing in inputs (except Escape)
      const target = event.target as HTMLElement
      const isTyping =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable

      for (const shortcut of shortcutsRef.current) {
        const keyMatches = event.key.toLowerCase() === shortcut.key.toLowerCase()
        const ctrlMatches = shortcut.ctrlKey ? event.ctrlKey || event.metaKey : !event.ctrlKey && !event.metaKey
        const shiftMatches = shortcut.shiftKey ? event.shiftKey : !event.shiftKey
        const altMatches = shortcut.altKey ? event.altKey : !event.altKey

        // Special handling for modifier key shortcuts (Ctrl/Cmd)
        const hasModifier = shortcut.ctrlKey || shortcut.metaKey || shortcut.altKey

        // Allow Escape to work even when typing
        const isEscape = shortcut.key.toLowerCase() === "escape"

        if (keyMatches && ctrlMatches && shiftMatches && altMatches) {
          // If typing and it's not Escape and no modifier, skip
          if (isTyping && !isEscape && !hasModifier) {
            continue
          }

          event.preventDefault()
          shortcut.action()
          return
        }
      }
    },
    [enabled]
  )

  useEffect(() => {
    if (!enabled) return

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [enabled, handleKeyDown])

  return {
    shortcuts: shortcutsRef.current,
  }
}

// Common keyboard shortcuts for chat applications
export const CHAT_SHORTCUTS = {
  newChat: { key: "k", ctrlKey: true, description: "New chat" },
  clearInput: { key: "Escape", description: "Clear input / Close panel" },
  focusInput: { key: "/", description: "Focus input" },
  toggleSidebar: { key: "b", ctrlKey: true, description: "Toggle sidebar" },
  openSettings: { key: ",", ctrlKey: true, description: "Open settings" },
  search: { key: "f", ctrlKey: true, description: "Search conversations" },
  copyLastResponse: { key: "c", ctrlKey: true, shiftKey: true, description: "Copy last response" },
  regenerate: { key: "r", ctrlKey: true, shiftKey: true, description: "Regenerate response" },
} as const
