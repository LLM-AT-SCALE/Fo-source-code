"use client"

import * as React from "react"
import { setWasmSource } from "@extend-ai/react-xlsx"

import { Skeleton } from "@/shared/components/ui/skeleton"
import { XlsxViewerPreview } from "@/shared/components/ui/xlsx-viewer"

interface XlsxViewerProps {
  arrayBuffer: ArrayBuffer
  isDarkMode: boolean
  filename?: string
}

// Workers cannot resolve a root-relative URL on their own. Pass an absolute
// same-origin URL while still serving the parser from Next.js public assets.
if (typeof window !== "undefined") {
  setWasmSource(new URL("/duke_sheets_wasm_bg.wasm", window.location.origin))
}

function SpreadsheetLoadingState() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-4">
      <Skeleton className="h-8 w-full" />
      <div className="grid flex-1 grid-cols-4 gap-1.5">
        {Array.from({ length: 24 }, (_, index) => (
          <Skeleton key={index} className="min-h-8" />
        ))}
      </div>
    </div>
  )
}

export function XlsxViewer({
  arrayBuffer,
  isDarkMode,
  filename,
}: XlsxViewerProps) {
  const [workbookUrl, setWorkbookUrl] = React.useState<string>()
  const [viewerIsDark, setViewerIsDark] = React.useState(isDarkMode)

  React.useEffect(() => {
    setViewerIsDark(isDarkMode)
  }, [isDarkMode])

  React.useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([arrayBuffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
    )
    setWorkbookUrl(url)

    return () => URL.revokeObjectURL(url)
  }, [arrayBuffer])

  if (!workbookUrl) {
    return <SpreadsheetLoadingState />
  }

  return (
    <XlsxViewerPreview
      className="h-full min-h-0 w-full"
      fileName={filename ?? "workbook.xlsx"}
      isDark={viewerIsDark}
      onIsDarkChange={setViewerIsDark}
      showDownload={false}
      showToolbar
      showUpload={false}
      src={workbookUrl}
    />
  )
}
