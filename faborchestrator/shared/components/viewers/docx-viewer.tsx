"use client"

import { useState, useEffect, useRef } from "react"
import { AlertCircle, Download } from "lucide-react"
import { Button } from "@/shared/components/ui/button"

interface DocxViewerProps {
  arrayBuffer: ArrayBuffer
  isDarkMode: boolean
  filename?: string
  onDownload?: () => void
}

export function DocxViewer({ arrayBuffer, isDarkMode, filename, onDownload }: DocxViewerProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let cancelled = false

    async function convert() {
      try {
        setLoading(true)
        setError(null)
        const mammoth = await import("mammoth")
        const result = await mammoth.convertToHtml({ arrayBuffer })
        if (!cancelled) {
          setHtml(result.value)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render document")
          setLoading(false)
        }
      }
    }

    convert()
    return () => { cancelled = true }
  }, [arrayBuffer])

  if (loading) {
    return (
      <div className="h-full p-6 space-y-4">
        <div className="h-6 w-1/3 rounded bg-muted animate-pulse" />
        <div className="space-y-2">
          <div className="h-4 w-full rounded bg-muted animate-pulse" />
          <div className="h-4 w-5/6 rounded bg-muted animate-pulse" style={{ animationDelay: "75ms" }} />
          <div className="h-4 w-4/6 rounded bg-muted animate-pulse" style={{ animationDelay: "150ms" }} />
        </div>
        <div className="h-24 w-full rounded-lg bg-muted animate-pulse" style={{ animationDelay: "200ms" }} />
        <div className="space-y-2">
          <div className="h-4 w-full rounded bg-muted animate-pulse" style={{ animationDelay: "250ms" }} />
          <div className="h-4 w-2/3 rounded bg-muted animate-pulse" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertCircle className="h-10 w-10 text-destructive" />
          <div>
            <h3 className="font-medium text-sm">Failed to render document</h3>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </div>
          {onDownload && (
            <Button variant="default" size="sm" onClick={onDownload}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download {filename || "file"}
            </Button>
          )}
        </div>
      </div>
    )
  }

  const bgColor = isDarkMode ? "#1a1a1a" : "#ffffff"
  const textColor = isDarkMode ? "#e0e0e0" : "#1a1a1a"
  const linkColor = isDarkMode ? "#60a5fa" : "#2563eb"

  const styledHtml = `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6;
    padding: 32px;
    margin: 0;
    background: ${bgColor};
    color: ${textColor};
    max-width: 800px;
    margin: 0 auto;
  }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  td, th { border: 1px solid ${isDarkMode ? "#444" : "#ddd"}; padding: 8px; }
  th { background: ${isDarkMode ? "#2a2a2a" : "#f5f5f5"}; }
  a { color: ${linkColor}; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
  p { margin: 0.5em 0; }
  ul, ol { padding-left: 1.5em; }
</style>
</head>
<body>${html}</body>
</html>`

  return (
    <iframe
      ref={iframeRef}
      srcDoc={styledHtml}
      className="h-full w-full border-0"
      sandbox="allow-same-origin"
      title={filename || "DOCX Preview"}
    />
  )
}
