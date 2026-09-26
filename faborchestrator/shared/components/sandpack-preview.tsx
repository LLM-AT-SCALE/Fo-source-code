"use client"

import { useState, useEffect, useCallback, memo, Component } from "react"
import type { ReactNode } from "react"
import dynamic from "next/dynamic"
import { Loader2, RefreshCw, AlertTriangle } from "lucide-react"
import { Button } from "@/shared/components/ui/button"
import { detectDependencies, detectTypeScript } from "@/shared/lib/sandpack-deps"

// Eagerly preload the Sandpack module so it's cached for when we need it
let sandpackModulePromise: Promise<typeof import("@codesandbox/sandpack-react")> | null = null

function preloadSandpack() {
  if (!sandpackModulePromise) {
    sandpackModulePromise = import("@codesandbox/sandpack-react")
  }
  return sandpackModulePromise
}

// Start preloading on module load (client-side only)
// Delay slightly so it doesn't compete with critical page resources
if (typeof window !== "undefined") {
  setTimeout(preloadSandpack, 2000)
}

// Dynamic imports using the preloaded module
const SandpackProvider = dynamic(
  () => preloadSandpack().then((mod) => mod.SandpackProvider),
  { ssr: false }
)

const SandpackPreview = dynamic(
  () => preloadSandpack().then((mod) => mod.SandpackPreview),
  { ssr: false }
)

// Tailwind CDN HTML template — injected as custom index.html
// Ensures all Tailwind utility classes work in Sandpack previews
const TAILWIND_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script src="https://cdn.tailwindcss.com"><\/script>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      html, body, #root { margin: 0; padding: 0; height: 100%; width: 100%; }
      body { font-family: system-ui, -apple-system, sans-serif; }
    </style>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`

// --- Error Boundary ---

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class SandpackErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode; onRetry: () => void }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full w-full flex items-center justify-center bg-muted/30 p-6">
          <div className="flex flex-col items-center gap-3 text-center max-w-sm">
            <AlertTriangle className="h-8 w-8 text-amber-500" />
            <p className="text-sm font-medium">Preview failed to render</p>
            <p className="text-xs text-muted-foreground">
              {this.state.error?.message || "An unexpected error occurred"}
            </p>
            <Button
              variant="default"
              onClick={() => {
                this.setState({ hasError: false, error: null })
                this.props.onRetry()
              }}
              className="flex h-auto items-center gap-1.5 border-0 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-none transition-colors active:scale-100 [&_svg:not([class*='size-'])]:size-3"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// --- Loading fallback ---

function SandpackLoadingFallback() {
  return (
    <div className="h-full w-full bg-muted/30 p-4 space-y-3 flex flex-col">
      <div className="flex items-center gap-2 border-b pb-2">
        <div className="h-3 w-3 rounded-full bg-muted animate-pulse" />
        <div
          className="h-3 w-3 rounded-full bg-muted animate-pulse"
          style={{ animationDelay: "75ms" }}
        />
        <div
          className="h-3 w-3 rounded-full bg-muted animate-pulse"
          style={{ animationDelay: "150ms" }}
        />
        <div className="h-4 w-32 ml-2 rounded bg-muted animate-pulse" />
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Loading preview...</span>
        </div>
      </div>
    </div>
  )
}

// --- Main component ---

interface SandpackPreviewWrapperProps {
  content: string
  template?: "react" | "react-ts" | "vanilla" | "vanilla-ts"
  theme?: "light" | "dark"
}

export const SandpackPreviewWrapper = memo(function SandpackPreviewWrapper({
  content,
  template = "react",
  theme = "light",
}: SandpackPreviewWrapperProps) {
  const [retryKey, setRetryKey] = useState(0)
  const [isReady, setIsReady] = useState(false)

  // Auto-detect TypeScript if template is plain react
  const isTS =
    template === "react-ts" || (template === "react" && detectTypeScript(content))
  const resolvedTemplate = isTS ? "react-ts" : template

  // Entry file based on template
  const entryFile = resolvedTemplate === "react-ts" ? "/App.tsx" : "/App.jsx"

  // Detect external dependencies from imports
  const detectedDeps = detectDependencies(content)
  const hasExternalDeps = Object.keys(detectedDeps).length > 0

  // Build files object with Tailwind HTML template
  const files: Record<string, string> = {
    [entryFile]: content,
    "/public/index.html": TAILWIND_INDEX_HTML,
  }

  // Build custom setup with detected dependencies
  const customSetup = hasExternalDeps ? { dependencies: detectedDeps } : undefined

  const handleRetry = useCallback(() => {
    setRetryKey((k) => k + 1)
  }, [])

  // Use a simple hash of content for the provider key so it re-initializes on content change
  // Combined with retryKey for manual retry support
  const contentKey = content.length + content.charCodeAt(0) + content.charCodeAt(Math.min(100, content.length - 1))

  // Mark ready after initial mount to avoid layout flash
  useEffect(() => {
    const timer = setTimeout(() => setIsReady(true), 50)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="h-full w-full sandpack-container" style={{ minHeight: 0 }}>
      <SandpackErrorBoundary onRetry={handleRetry}>
        {!isReady ? (
          <SandpackLoadingFallback />
        ) : (
          <SandpackProvider
            key={`${retryKey}-${contentKey}-${resolvedTemplate}`}
            template={resolvedTemplate}
            files={files}
            customSetup={customSetup}
            theme={theme}
          >
            <SandpackPreview
              showNavigator={false}
              showRefreshButton={false}
              style={{
                height: "100%",
                width: "100%",
                minHeight: 0,
                flex: 1,
              }}
            />
          </SandpackProvider>
        )}
      </SandpackErrorBoundary>
    </div>
  )
}) as React.NamedExoticComponent<SandpackPreviewWrapperProps> & {
  Loading: typeof SandpackLoadingFallback
}

// Re-export loading fallback for use during dynamic loading
SandpackPreviewWrapper.Loading = SandpackLoadingFallback
