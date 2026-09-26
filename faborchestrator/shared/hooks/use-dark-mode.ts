"use client"

import { useState, useEffect } from "react"

/**
 * Shared hook to detect dark mode from the <html> class.
 * Uses a single MutationObserver per component instance.
 */
export function useDarkMode(): boolean {
  const [isDarkMode, setIsDarkMode] = useState(false)

  useEffect(() => {
    const checkDarkMode = () => {
      setIsDarkMode(document.documentElement.classList.contains("dark"))
    }
    checkDarkMode()

    const observer = new MutationObserver(checkDarkMode)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [])

  return isDarkMode
}
