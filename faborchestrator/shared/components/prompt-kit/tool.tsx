"use client"

import { Button } from "@/shared/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/components/ui/collapsible"
import { cn } from "@/shared/lib/utils"
import {
  CheckCircle,
  ChevronDown,
  Loader2,
  Settings,
  XCircle,
} from "lucide-react"
import LoadingState from "@/shared/components/prompt-kit/loading-state"
import { useState } from "react"
import { stripMcpToolKey } from "@/modules/mcp/lib/mcp-tool-key"

// PromptKit-aligned tool states
export type ToolState =
  | "input-streaming"   // Tool input is being streamed
  | "input-available"   // Tool input ready, waiting for execution
  | "output-available"  // Tool executed successfully
  | "output-error"      // Tool execution failed

// PromptKit ToolPart interface
export type ToolPart = {
  type: string
  state: ToolState
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  toolCallId?: string
  errorText?: string
  /** Measured execution time, persisted with the message so reloaded history
   *  still shows what the call cost. Absent for provider-executed tools. */
  durationMs?: number
  /** Step this call belonged to. Calls sharing a step ran CONCURRENTLY, so a
   *  group's real cost is the sum over steps of each step's slowest call. */
  stepNumber?: number
}

export type ToolProps = {
  toolPart: ToolPart
  defaultOpen?: boolean
  className?: string
}

const Tool = ({ toolPart, defaultOpen = false, className }: ToolProps) => {
  // Default to closed, only open if explicitly requested or still streaming
  const [isOpen, setIsOpen] = useState(defaultOpen && toolPart.state === "input-streaming")

  const { state, input, output, toolCallId } = toolPart

  const getStateIcon = () => {
    switch (state) {
      case "input-streaming":
        return <Loader2 className="h-4 w-4 animate-spin text-status-info" />
      case "input-available":
        return <Settings className="h-4 w-4 text-status-warning" />
      case "output-available":
        return <CheckCircle className="h-4 w-4 text-status-success" />
      case "output-error":
        return <XCircle className="h-4 w-4 text-status-error" />
      default:
        return <Settings className="text-muted-foreground h-4 w-4" />
    }
  }

  const getStateBadge = () => {
    const baseClasses = "px-2 py-1 rounded-full text-xs font-medium"
    switch (state) {
      case "input-streaming":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-status-info-muted text-status-info-foreground"
            )}
          >
            Processing
          </span>
        )
      case "input-available":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-status-warning-muted text-status-warning-foreground"
            )}
          >
            Ready
          </span>
        )
      case "output-available":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-status-success-muted text-status-success-foreground"
            )}
          >
            Completed
          </span>
        )
      case "output-error":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-status-error-muted text-status-error-foreground"
            )}
          >
            Error
          </span>
        )
      default:
        return (
          <span
            className={cn(
              baseClasses,
              "bg-muted text-muted-foreground"
            )}
          >
            Pending
          </span>
        )
    }
  }

  const formatToolName = (name: string) => {
    const knownNames: Record<string, string> = {
      'web_search': 'Web Search',
      'web_fetch': 'Web Fetch',
      'code_execution': 'Code Execution',
    };
    if (knownNames[name]) return knownNames[name];
    // Convert snake_case or camelCase to Title Case
    return stripMcpToolKey(name) // Remove mcp_<conn8>__ / mcp_ prefix
      .replace(/_/g, " ")
      .replace(/([A-Z])/g, " $1")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim()
  }

  const formatValue = (value: unknown): string => {
    if (value === null) return "null"
    if (value === undefined) return "undefined"
    if (typeof value === "string") return value
    if (typeof value === "object") {
      return JSON.stringify(value, null, 2)
    }
    return String(value)
  }

  // Detect if data is tabular (array of objects with consistent keys)
  const isTabularData = (data: unknown): data is Record<string, unknown>[] => {
    if (!Array.isArray(data) || data.length === 0) return false
    if (typeof data[0] !== "object" || data[0] === null) return false
    const firstKeys = Object.keys(data[0] as Record<string, unknown>)
    if (firstKeys.length === 0) return false
    // Check at least first few rows have the same structure
    return data.slice(0, 3).every(
      (row) => typeof row === "object" && row !== null && Object.keys(row as Record<string, unknown>).length > 0
    )
  }

  // Drop the `_mcp` provenance stamp (connection id, server URL) before the
  // output reaches the card: it is bookkeeping for the audit trail, not data
  // for the user, and it must not break single-key table detection below.
  const withoutMcpMeta = (data: Record<string, unknown>): Record<string, unknown> => {
    if (Array.isArray(data) || !("_mcp" in data)) return data
    const { _mcp: _omit, ...rest } = data
    void _omit
    return rest
  }

  // Extract tabular data from various output shapes
  const getTabularData = (data: Record<string, unknown>): Record<string, unknown>[] | null => {
    // Direct array (already tabular)
    if (Array.isArray(data) && isTabularData(data)) return data
    // Common wrapper keys: rows, data, results, records, items, content
    for (const key of ["rows", "data", "results", "records", "items"]) {
      if (data[key] && isTabularData(data[key])) return data[key] as Record<string, unknown>[]
    }
    // Single-key wrapper containing an array
    const keys = Object.keys(data)
    if (keys.length === 1 && isTabularData(data[keys[0]])) {
      return data[keys[0]] as Record<string, unknown>[]
    }
    return null
  }

  const renderTable = (rows: Record<string, unknown>[]) => {
    const columns = Object.keys(rows[0])
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  className="bg-muted border-border whitespace-nowrap border px-3 py-1.5 text-left text-xs font-semibold"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={i % 2 === 0 ? "" : "bg-muted/30"}>
                {columns.map((col) => (
                  <td
                    key={col}
                    className="border-border max-w-xs truncate border px-3 py-1.5"
                    title={String(row[col] ?? "")}
                  >
                    {row[col] === null ? (
                      <span className="text-muted-foreground italic">null</span>
                    ) : (
                      String(row[col] ?? "")
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-muted-foreground mt-1 text-xs">
          {rows.length} row{rows.length !== 1 ? "s" : ""}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "border-border my-3 w-full overflow-hidden rounded-lg border",
        className
      )}
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="bg-background h-auto w-full justify-between rounded-b-none px-3 py-2 font-normal"
          >
            <div className="flex items-center gap-2">
              {getStateIcon()}
              <span className="font-mono text-sm font-medium">
                {formatToolName(toolPart.type)}
              </span>
              {getStateBadge()}
            </div>
            <ChevronDown className={cn("h-4 w-4 transition-transform duration-200 ease-out", isOpen ? "rotate-180" : "rotate-0")} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent
          className={cn(
            "border-border border-t",
            "overflow-hidden"
          )}
        >
          <div className="bg-background space-y-3 p-3">
            {input && Object.keys(input).length > 0 && (
              <div>
                <h4 className="text-muted-foreground mb-2 text-sm font-medium">
                  Input
                </h4>
                <div className="bg-muted/50 rounded border p-2 font-mono text-sm">
                  {Object.entries(input).map(([key, value]) => (
                    <div key={key} className="mb-1 last:mb-0">
                      <span className="text-blue-600 dark:text-blue-400">{key}:</span>{" "}
                      <span className="text-foreground break-all">
                        {typeof value === "string" && value.length > 200
                          ? `"${value.substring(0, 200)}..."`
                          : formatValue(value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {output && (
              <div>
                <h4 className="text-muted-foreground mb-2 text-sm font-medium">
                  Output
                </h4>
                {(() => {
                  const shown = withoutMcpMeta(output)
                  const tableRows = getTabularData(shown)
                  if (tableRows) {
                    return (
                      <div className="bg-muted/50 max-h-80 overflow-auto rounded border p-2 text-sm">
                        {renderTable(tableRows)}
                      </div>
                    )
                  }
                  return (
                    <div className="bg-muted/50 max-h-60 overflow-auto rounded border p-2 font-mono text-sm">
                      <pre className="whitespace-pre-wrap break-all">
                        {formatValue(shown)}
                      </pre>
                    </div>
                  )
                })()}
              </div>
            )}

            {state === "output-error" && toolPart.errorText && (
              <div>
                <h4 className="mb-2 text-sm font-medium text-status-error">Error</h4>
                <div className="bg-status-error-muted rounded border border-status-error/20 p-2 text-sm text-status-error-foreground">
                  {toolPart.errorText}
                </div>
              </div>
            )}

            {state === "input-streaming" && (
              <LoadingState label={`Preparing ${formatToolName(toolPart.type)}`} />
            )}

            {state === "input-available" && (
              <LoadingState label={`Running ${formatToolName(toolPart.type)}`} />
            )}

            {toolCallId && (
              <div className="text-muted-foreground border-t border-border pt-2 text-xs">
                <span className="font-mono">Call ID: {toolCallId.substring(0, 16)}...</span>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/**
 * Convert AI SDK tool-invocation part to PromptKit ToolPart
 */
export function convertToToolPart(part: {
  type: "tool-invocation"
  toolInvocationId: string
  toolName: string
  args: Record<string, unknown>
  state: "partial-call" | "call" | "result"
  result?: unknown
}): ToolPart {
  // Map AI SDK states to PromptKit states
  let state: ToolState
  let errorText: string | undefined
  let output: Record<string, unknown> | undefined

  switch (part.state) {
    case "partial-call":
      state = "input-streaming"
      break
    case "call":
      state = "input-available"
      break
    case "result":
      // Check if result is an error
      if (part.result && typeof part.result === "object" && "error" in part.result) {
        state = "output-error"
        errorText = String((part.result as { error: unknown }).error)
      } else if (part.result && typeof part.result === "string") {
        try {
          const parsed = JSON.parse(part.result)
          if (parsed.error) {
            state = "output-error"
            errorText = parsed.error
          } else {
            state = "output-available"
            output = parsed
          }
        } catch {
          state = "output-available"
          output = { result: part.result }
        }
      } else {
        state = "output-available"
        output = part.result as Record<string, unknown>
      }
      break
    default:
      state = "input-streaming"
  }

  return {
    type: part.toolName,
    state,
    input: part.args,
    output,
    toolCallId: part.toolInvocationId,
    errorText,
  }
}

/**
 * Extract tool invocations from message parts and convert to ToolPart format
 * Handles AI SDK v3 format where tool parts have:
 * - type: "tool-<toolName>" (e.g., "tool-getWeather") OR "tool-invocation"
 * - state: "input-streaming" | "input-available" | "output-available" | "output-error"
 * - toolCallId: string
 * - input: object (for input states)
 * - output: unknown (for output states)
 */
export function extractToolParts(parts: unknown[]): ToolPart[] {
  if (!Array.isArray(parts)) {
    return []
  }

  const toolParts: ToolPart[] = []

  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue

    const p = part as Record<string, unknown>
    const partType = p.type as string

    // Skip non-tool parts
    if (!partType) continue

    // AI SDK v3 format: type starts with "tool-" OR is "tool-invocation"
    const isToolPart = partType.startsWith("tool-") ||
                       partType === "tool-invocation" ||
                       partType === "tool-call" ||
                       partType === "tool-result"

    if (isToolPart) {
      // Extract tool name from type (remove "tool-" prefix if present)
      let toolName: string
      if (partType.startsWith("tool-") && partType !== "tool-invocation" && partType !== "tool-call" && partType !== "tool-result") {
        toolName = partType.substring(5) // Remove "tool-" prefix
      } else {
        toolName = (p.toolName as string) || (p.name as string) || 'unknown_tool'
      }

      // Extract properties - AI SDK v3 uses input/output directly, not args/result
      const toolCallId = (p.toolCallId as string) || (p.toolInvocationId as string) || (p.id as string) || ''
      const input = (p.input as Record<string, unknown>) || (p.args as Record<string, unknown>) || {}
      const rawOutput = p.output !== undefined ? p.output : p.result

      // AI SDK v3 state values are already in PromptKit format
      const sdkState = (p.state as string) || 'input-available'

      // Convert state
      let promptKitState: ToolState
      let errorText: string | undefined
      let output: Record<string, unknown> | undefined

      switch (sdkState) {
        case "input-streaming":
        case "partial-call":
          promptKitState = "input-streaming"
          break
        case "input-available":
        case "call":
          promptKitState = "input-available"
          break
        case "output-available":
        case "result":
          // Check if output is an error
          if (rawOutput && typeof rawOutput === "object" && "error" in (rawOutput as object)) {
            promptKitState = "output-error"
            errorText = String((rawOutput as { error: unknown }).error)
          } else if (rawOutput && typeof rawOutput === "object" && "isError" in (rawOutput as object) && (rawOutput as { isError: boolean }).isError) {
            promptKitState = "output-error"
            const content = (rawOutput as { content?: Array<{ text?: string }> }).content
            errorText = content?.[0]?.text || 'Tool execution failed'
          } else if (rawOutput && typeof rawOutput === "string") {
            try {
              const parsed = JSON.parse(rawOutput)
              if (parsed.error) {
                promptKitState = "output-error"
                errorText = parsed.error
              } else {
                promptKitState = "output-available"
                output = parsed
              }
            } catch {
              promptKitState = "output-available"
              output = { result: rawOutput }
            }
          } else if (rawOutput !== undefined) {
            promptKitState = "output-available"
            output = typeof rawOutput === "object" ? rawOutput as Record<string, unknown> : { result: rawOutput }
          } else {
            promptKitState = "output-available"
            output = undefined
          }
          break
        case "output-error":
          promptKitState = "output-error"
          errorText = (p.errorText as string) || 'Tool execution failed'
          break
        default:
          promptKitState = "input-streaming"
      }

      toolParts.push({
        type: toolName,
        state: promptKitState,
        input: Object.keys(input).length > 0 ? input : undefined,
        output,
        toolCallId,
        errorText,
        ...(typeof p.durationMs === 'number' ? { durationMs: p.durationMs } : {}),
        ...(typeof p.stepNumber === 'number' ? { stepNumber: p.stepNumber } : {}),
      })
    }
  }

  return toolParts
}

export { Tool }
