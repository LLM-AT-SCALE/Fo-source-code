"use client"

import { useState } from "react"
import { Download, AlertCircle } from "lucide-react"
import { Button } from "@/shared/components/ui/button"

interface PdfViewerProps {
  blobUrl: string
  filename?: string
  onDownload?: () => void
}

export function PdfViewer({ blobUrl, filename, onDownload }: PdfViewerProps) {
  const [loadError, setLoadError] = useState(false)

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertCircle className="h-10 w-10 text-muted-foreground" />
          <div>
            <h3 className="font-medium text-sm">Unable to display PDF</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Your browser may not support inline PDF rendering.
            </p>
          </div>
          {onDownload && (
            <Button variant="default" size="sm" onClick={onDownload}>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download {filename || "PDF"}
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <iframe
      src={blobUrl}
      className="h-full w-full border-0"
      title={filename || "PDF Preview"}
      onError={() => setLoadError(true)}
    />
  )
}
