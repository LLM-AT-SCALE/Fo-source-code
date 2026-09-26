"use client"

import { useState } from "react"
import { Plug, PlugZap, AlertCircle, Trash2, Edit, RefreshCw, ChevronDown, ChevronUp } from "lucide-react"
import { Button } from "@/shared/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card"
import { Badge } from "@/shared/components/ui/badge"
import { cn } from "@/shared/lib/utils"

type McpConnectionStatus = "connected" | "disconnected" | "error"

export interface McpConnectionData {
  id: string
  name: string
  serverUrl: string
  authType: "none" | "api_key" | "oauth"
  status: McpConnectionStatus
  lastError?: string | null
  isActive: boolean
  availableTools?: { name: string; description?: string }[]
  lastConnectedAt?: string | null
  source?: "personal" | "role"
  canDelete?: boolean
  /** The agent this connection belongs to (shared/lib/agents.ts). */
  agent?: string
}

interface McpConnectionCardProps {
  connection: McpConnectionData
  onConnect: (id: string) => Promise<void>
  onDisconnect: (id: string) => Promise<void>
  onEdit: (connection: McpConnectionData) => void
  onDelete: (id: string) => Promise<void>
  /** Personal connections only: whether this user may edit / test / delete them (admin-configured). */
  canEdit?: boolean
  onRefresh: (id: string) => Promise<void>
}

export function McpConnectionCard({
  connection,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  canEdit = true,
  onRefresh,
}: McpConnectionCardProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [showTools, setShowTools] = useState(false)

  const handleConnect = async () => {
    setIsLoading(true)
    try {
      if (connection.status === "connected") {
        await onDisconnect(connection.id)
      } else {
        await onConnect(connection.id)
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleRefresh = async () => {
    setIsLoading(true)
    try {
      await onRefresh(connection.id)
    } finally {
      setIsLoading(false)
    }
  }

  const handleDelete = async () => {
    if (confirm(`Are you sure you want to delete "${connection.name}"?`)) {
      await onDelete(connection.id)
    }
  }

  const statusConfig = {
    connected: {
      color: "bg-status-connected",
      text: "Connected",
      icon: PlugZap,
    },
    disconnected: {
      color: "bg-status-disconnected",
      text: "Disconnected",
      icon: Plug,
    },
    error: {
      color: "bg-status-error",
      text: "Error",
      icon: AlertCircle,
    },
  }

  const status = statusConfig[connection.status]
  const StatusIcon = status.icon

  return (
    <Card className="relative">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={cn("h-3 w-3 rounded-full", status.color)} />
            <CardTitle className="text-base">{connection.name}</CardTitle>
          </div>
          <div className="flex items-center gap-1">
            {connection.source !== "role" && canEdit && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleRefresh}
                disabled={isLoading || connection.status !== "connected"}
                title="Refresh tools"
              >
                <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
              </Button>
            )}
            {connection.source !== "role" && canEdit && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onEdit(connection)}
                  title="Edit connection"
                >
                  <Edit className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={handleDelete}
                  title="Delete connection"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
            {connection.source === "role" && (
              <Badge variant="secondary" className="text-xs" title={canEdit ? "Assigned by your administrator — you can switch it off for yourself" : "Assigned by your administrator — always connected"}>Managed</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">URL:</span>
            <span className="font-mono text-xs truncate max-w-[200px]">{connection.serverUrl}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Auth:</span>
            <Badge variant="outline" className="text-xs">
              {connection.authType === "none" ? "None" : connection.authType === "api_key" ? "API Key" : "OAuth"}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Status:</span>
            <div className="flex items-center gap-1.5">
              <StatusIcon className="h-3.5 w-3.5" />
              <span>{status.text}</span>
            </div>
          </div>
          {connection.lastConnectedAt && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Last connected:</span>
              <span className="text-xs">{new Date(connection.lastConnectedAt).toLocaleString()}</span>
            </div>
          )}
        </div>

        {connection.lastError && connection.status === "error" && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {connection.lastError}
          </div>
        )}

        {connection.availableTools && connection.availableTools.length > 0 && (
          <div className="space-y-2">
            <Button
              variant="ghost"
              onClick={() => setShowTools(!showTools)}
              className="flex h-auto w-full items-center justify-between rounded-none border-0 bg-transparent p-0 text-sm font-medium hover:bg-transparent hover:text-primary active:scale-100 dark:hover:bg-transparent"
            >
              <span>Available Tools ({connection.availableTools.length})</span>
              {showTools ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
            {showTools && (
              <div className="max-h-48 overflow-y-auto space-y-1.5 rounded-md bg-muted/50 p-2">
                {connection.availableTools.map((tool) => (
                  <div key={tool.name} className="text-xs">
                    <span className="font-medium">{tool.name}</span>
                    {tool.description && (
                      <span className="text-muted-foreground ml-1">- {tool.description}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {canEdit && (
          <Button
            variant={connection.status === "connected" ? "outline" : "default"}
            className="w-full"
            onClick={handleConnect}
            disabled={isLoading}
          >
            {isLoading ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <StatusIcon className="mr-2 h-4 w-4" />
            )}
            {connection.status === "connected" ? "Disconnect" : "Connect"}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
