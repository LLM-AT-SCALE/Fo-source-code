"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Loader2, AlertCircle, RefreshCw } from "lucide-react"
import { Button } from "@/shared/components/ui/button"

interface MermaidViewerProps {
  content: string
  isDarkMode?: boolean
}

export function MermaidViewer({ content, isDarkMode = false }: MermaidViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const renderDiagram = useCallback(async () => {
    if (!containerRef.current || !content.trim()) return

    setLoading(true)
    setError(null)

    try {
      const mermaid = (await import("mermaid")).default

      mermaid.initialize({
        startOnLoad: false,
        theme: isDarkMode ? "dark" : "default",
        securityLevel: "strict",
        fontFamily: "inherit",
      })

      const id = `mermaid-${Date.now()}`
      const { svg } = await mermaid.render(id, content.trim())

      if (containerRef.current) {
        containerRef.current.innerHTML = svg
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to render diagram")
    } finally {
      setLoading(false)
    }
  }, [content, isDarkMode])

  useEffect(() => {
    renderDiagram()
  }, [renderDiagram])

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center px-6">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <span className="text-sm text-destructive">{error}</span>
          <Button variant="outline" size="sm" onClick={renderDiagram}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-auto flex items-center justify-center p-4">
      <div ref={containerRef} className="max-w-full [&_svg]:max-w-full [&_svg]:h-auto" />
    </div>
  )
}
