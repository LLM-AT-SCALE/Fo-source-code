"use client"

import React from "react"
import { RefreshCw, Home, Bug, Frown, Sparkles } from "lucide-react"
import { Button } from "@/shared/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/shared/components/ui/card"
import { motion } from "motion/react"
import { FabOrchClientError } from "@/shared/lib/errors/client"

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

/**
 * Error Boundary component to catch and handle React errors gracefully
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Error caught by boundary:", error, errorInfo)
    this.setState({ errorInfo })
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <ErrorFallback
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          onRetry={this.handleRetry}
        />
      )
    }

    return this.props.children
  }
}

interface ErrorFallbackProps {
  error: Error | null
  errorInfo?: React.ErrorInfo | null
  onRetry?: () => void
  title?: string
  description?: string
}

// Friendly error messages to add personality
const friendlyMessages = [
  "Oops! I tripped over a digital rock.",
  "Something got tangled in the wires.",
  "I need a moment to collect my thoughts.",
  "Even AIs have off days sometimes.",
  "My circuits got a bit confused there.",
]

/**
 * Default error fallback UI component with friendly messaging
 */
function ErrorFallback({
  error,
  errorInfo,
  onRetry,
  title = "Something went wrong",
  description,
}: ErrorFallbackProps) {
  const [showDetails, setShowDetails] = React.useState(false)
  // FabOrch errors carry a canonical user-facing message — show it verbatim.
  const fabOrchEnvelope = error instanceof FabOrchClientError ? error.envelope : null
  const friendlyMessage = React.useMemo(() => {
    if (fabOrchEnvelope) return fabOrchEnvelope.message
    return description || friendlyMessages[Math.floor(Math.random() * friendlyMessages.length)]
  }, [description, fabOrchEnvelope])

  return (
    <div className="flex min-h-[400px] items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 200, damping: 20 }}
      >
        <Card className="w-full max-w-md border-destructive/20">
          <CardHeader className="text-center">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 25, delay: 0.1 }}
              className="mx-auto mb-4 relative"
            >
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-destructive/20 to-destructive/10">
                <Frown className="h-8 w-8 text-destructive" />
              </div>
              <motion.div
                className="absolute -top-1 -right-1"
                animate={{ rotate: [0, 10, -10, 0] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                <Sparkles className="h-4 w-4 text-destructive/50" />
              </motion.div>
            </motion.div>
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription className="mt-2">{friendlyMessage}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && !fabOrchEnvelope && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="rounded-lg bg-muted/50 p-3 border border-border"
              >
                <p className="font-mono text-sm text-muted-foreground break-words">
                  {error.message || "Unknown error"}
                </p>
              </motion.div>
            )}
            {fabOrchEnvelope && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="rounded-lg bg-muted/50 p-3 border border-border space-y-1"
              >
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {fabOrchEnvelope.type} · {fabOrchEnvelope.priority}
                </p>
                <p className="font-mono text-[11px] text-muted-foreground break-all">
                  errorId: {fabOrchEnvelope.errorId}
                </p>
              </motion.div>
            )}
            {showDetails && errorInfo && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="max-h-40 overflow-auto rounded-lg bg-muted/30 p-3 border border-border"
              >
                <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap">
                  {errorInfo.componentStack}
                </pre>
              </motion.div>
            )}
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <div className="flex w-full gap-2">
              {onRetry && (
                <Button onClick={onRetry} className="flex-1 gap-2">
                  <RefreshCw className="h-4 w-4" />
                  Try Again
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => window.location.href = "/"}
                className="flex-1 gap-2"
              >
                <Home className="h-4 w-4" />
                Go Home
              </Button>
            </div>
            {errorInfo && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDetails(!showDetails)}
                className="w-full gap-2 text-muted-foreground"
              >
                <Bug className="h-4 w-4" />
                {showDetails ? "Hide" : "Show"} Technical Details
              </Button>
            )}
          </CardFooter>
        </Card>
      </motion.div>
    </div>
  )
}
