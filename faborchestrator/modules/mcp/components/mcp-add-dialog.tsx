"use client"

import { useState } from "react"
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react"
import { Button } from "@/shared/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog"
import { Input } from "@/shared/components/ui/input"
import { Label } from "@/shared/components/ui/label"
import { cn } from "@/shared/lib/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/components/ui/select"
import { AGENT_KEYS, AGENT_LABELS, type AgentKey } from "@/shared/lib/agents"

interface McpAddDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (data: {
    name: string
    serverUrl: string
    authType: "none" | "api_key" | "oauth"
    oauthClientId?: string
    oauthClientSecret?: string
    apiKey?: string
    /** The one agent this connector is for; fixed once created. */
    agent: AgentKey
  }) => Promise<void>
  /** Pre-selected agent (e.g. the settings page's current group). */
  defaultAgent?: AgentKey
  editData?: {
    id: string
    name: string
    serverUrl: string
    authType: "none" | "api_key" | "oauth"
  } | null
}

export function McpAddDialog({ open, onOpenChange, onAdd, editData, defaultAgent = "fabinsight" }: McpAddDialogProps) {
  const [agent, setAgent] = useState<AgentKey>(defaultAgent)
  const [name, setName] = useState(editData?.name || "")
  const [serverUrl, setServerUrl] = useState(editData?.serverUrl || "")
  const [authType, setAuthType] = useState<"none" | "api_key" | "oauth">(editData?.authType || "none")
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [oauthClientId, setOauthClientId] = useState("")
  const [oauthClientSecret, setOauthClientSecret] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const isEditing = !!editData

  const validate = () => {
    const newErrors: Record<string, string> = {}

    if (!name.trim()) {
      newErrors.name = "Name is required"
    }

    if (!serverUrl.trim()) {
      newErrors.serverUrl = "Server URL is required"
    } else {
      try {
        new URL(serverUrl)
      } catch {
        newErrors.serverUrl = "Invalid URL format"
      }
    }

    if (authType === "oauth") {
      if (!oauthClientId.trim()) {
        newErrors.oauthClientId = "OAuth Client ID is required"
      }
      if (!oauthClientSecret.trim()) {
        newErrors.oauthClientSecret = "OAuth Client Secret is required"
      }
    }

    if (authType === "api_key" && !apiKey.trim()) {
      newErrors.apiKey = "API Key is required"
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setIsLoading(true)
    try {
      await onAdd({
        name: name.trim(),
        serverUrl: serverUrl.trim(),
        authType,
        agent,
        ...(authType === "oauth" && {
          oauthClientId: oauthClientId.trim(),
          oauthClientSecret: oauthClientSecret.trim(),
        }),
        ...(authType === "api_key" && {
          apiKey: apiKey.trim(),
        }),
      })
      // Reset form
      setName("")
      setServerUrl("")
      setAuthType("none")
      setOauthClientId("")
      setOauthClientSecret("")
      setApiKey("")
      setShowAdvanced(false)
      onOpenChange(false)
    } catch (error) {
      console.error("Error adding MCP connection:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset form when closing
      setName(editData?.name || "")
      setServerUrl(editData?.serverUrl || "")
      setAuthType(editData?.authType || "none")
      setOauthClientId("")
      setOauthClientSecret("")
      setApiKey("")
      setShowAdvanced(false)
      setErrors({})
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit MCP Connector" : "Add Custom Connector"}</DialogTitle>
          <DialogDescription>
            Connect to a remote MCP server to extend Claude&apos;s capabilities with custom tools.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="mcp-agent">Agent</Label>
            <Select value={agent} onValueChange={(v) => setAgent(v as AgentKey)} disabled={isEditing}>
              <SelectTrigger id="mcp-agent" aria-label="Agent this connector is for">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_KEYS.map((k) => <SelectItem key={k} value={k}>{AGENT_LABELS[k]}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Only this agent will see the connector. It cannot be moved to another agent later.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="My MCP Server"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={cn(errors.name && "border-destructive")}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="serverUrl">Remote MCP Server URL</Label>
            <Input
              id="serverUrl"
              placeholder="https://mcp.example.com/api"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              className={cn(errors.serverUrl && "border-destructive")}
            />
            {errors.serverUrl && <p className="text-xs text-destructive">{errors.serverUrl}</p>}
          </div>

          <div className="space-y-2">
            <Label>Authentication Type</Label>
            <div className="flex gap-2">
              {(["none", "api_key", "oauth"] as const).map((type) => (
                <Button
                  key={type}
                  type="button"
                  variant={authType === type ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setAuthType(type)
                    if (type !== "none") setShowAdvanced(true)
                  }}
                >
                  {type === "none" ? "None" : type === "api_key" ? "API Key" : "OAuth"}
                </Button>
              ))}
            </div>
          </div>

          {authType !== "none" && (
            <div className="space-y-4">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex h-auto w-full items-center justify-between rounded-none border-0 bg-transparent p-0 text-sm font-medium hover:bg-transparent active:scale-100 dark:hover:bg-transparent"
              >
                <span>Authentication Settings</span>
                {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>

              {showAdvanced && (
                <div className="space-y-4 rounded-md border p-4">
                  {authType === "api_key" && (
                    <div className="space-y-2">
                      <Label htmlFor="apiKey">API Key</Label>
                      <Input
                        id="apiKey"
                        type="password"
                        placeholder="Enter API key"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        className={cn(errors.apiKey && "border-destructive")}
                      />
                      {errors.apiKey && <p className="text-xs text-destructive">{errors.apiKey}</p>}
                    </div>
                  )}

                  {authType === "oauth" && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="oauthClientId">OAuth Client ID</Label>
                        <Input
                          id="oauthClientId"
                          placeholder="Enter OAuth Client ID"
                          value={oauthClientId}
                          onChange={(e) => setOauthClientId(e.target.value)}
                          className={cn(errors.oauthClientId && "border-destructive")}
                        />
                        {errors.oauthClientId && (
                          <p className="text-xs text-destructive">{errors.oauthClientId}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="oauthClientSecret">OAuth Client Secret</Label>
                        <Input
                          id="oauthClientSecret"
                          type="password"
                          placeholder="Enter OAuth Client Secret"
                          value={oauthClientSecret}
                          onChange={(e) => setOauthClientSecret(e.target.value)}
                          className={cn(errors.oauthClientSecret && "border-destructive")}
                        />
                        {errors.oauthClientSecret && (
                          <p className="text-xs text-destructive">{errors.oauthClientSecret}</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <p className="font-medium text-amber-700 dark:text-amber-400">Security Notice</p>
              <p className="text-muted-foreground">
                Only connect to MCP servers from developers you trust. Connected servers can execute
                tools and access data on your behalf.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? "Adding..." : isEditing ? "Save Changes" : "Add Connector"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
