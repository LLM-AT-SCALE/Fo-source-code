"use client"

import { useEffect, useState, useCallback } from "react"
import {
  Settings,
  Palette,
  Key,
  Plug,
  SlidersHorizontal,
  Sliders,
  X,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  Moon,
  Sun,
  Monitor,
  Loader2,
  Brain,
  Trash2,
  FileText, Plus } from "lucide-react"
import { Button } from "@/shared/components/ui/button"
import { Input } from "@/shared/components/ui/input"
import { Textarea } from "@/shared/components/ui/textarea"
import { Switch } from "@/shared/components/ui/switch"
import { Slider } from "@/shared/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select"
import { McpConnectionCard, type McpConnectionData } from "@/modules/mcp/components/mcp-connection-card"
import { McpAddDialog } from "@/modules/mcp/components/mcp-add-dialog"
import { AGENT_KEYS, AGENT_LABELS, agentKeyFrom, type AgentKey } from "@/shared/lib/agents"
import { cn } from "@/shared/lib/utils"

const AUTH_TOKEN_KEY = "llmatscale_auth_token"
const THEME_KEY = "llmatscale_theme"
const FONT_SIZE_KEY = "llmatscale_font_size"
const CODE_THEME_KEY = "llmatscale_code_theme"
const INSTRUCTIONS_KEY = "llmatscale_custom_instructions"

type Theme = "light" | "dark" | "system"
type CodeTheme = "github-dark" | "one-dark-pro" | "dracula"

type SettingsTab = "general" | "appearance" | "api-keys" | "mcp" | "memory" | "instructions" | "advanced"

const SETTINGS_TABS: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "instructions", label: "Instructions Tuning", icon: SlidersHorizontal },
  { id: "advanced", label: "Advanced", icon: Sliders },
]

const CLAUDE_MODELS = [
  { id: "claude-sonnet-5", name: "FabOrchestrator 1" },
  { id: "claude-opus-5", name: "FabOrchestrator 2" },
  { id: "claude-fable-5", name: "FabOrchestrator 3" },
  { id: "claude-fable-5-1", name: "FabOrchestrator 4" },
]

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  defaultTab?: SettingsTab
  currentModel?: string
  onDefaultModelChange?: (modelId: string) => void
}

export function SettingsModal({ open, onClose, defaultTab = "general", currentModel, onDefaultModelChange }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab)

  // Sync activeTab when defaultTab changes (e.g. opening from MCP connectors)
  useEffect(() => {
    setActiveTab(defaultTab)
  }, [defaultTab])

  // Profile state
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMessage, setProfileMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  // Password state
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [passwordChanging, setPasswordChanging] = useState(false)
  const [passwordMessage, setPasswordMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  // Anthropic API Key state
  const [anthropicApiKey, setAnthropicApiKey] = useState("")
  const [apiKeyTestStatus, setApiKeyTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle")
  const [apiKeyTestMessage, setApiKeyTestMessage] = useState("")
  const [hasExistingApiKey, setHasExistingApiKey] = useState(false)
  const [maskedApiKey, setMaskedApiKey] = useState("")

  // Appearance state
  const [theme, setTheme] = useState<Theme>("light")
  const [fontSize, setFontSize] = useState(16)
  const [codeTheme, setCodeTheme] = useState<CodeTheme>("github-dark")

  // General settings
  const [defaultModel, setDefaultModel] = useState(currentModel || "claude-opus-4-8")

  // Sync defaultModel when currentModel prop changes (e.g. model changed from chat)
  useEffect(() => {
    if (currentModel) setDefaultModel(currentModel)
  }, [currentModel])
  const [sendWithEnter, setSendWithEnter] = useState(true)
  const [showCodeResults, setShowCodeResults] = useState(true)

  // Instructions Tuning state
  const [customInstructions, setCustomInstructions] = useState("")
  const [instructionsSaving, setInstructionsSaving] = useState(false)
  const [instructionsMessage, setInstructionsMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  // Memory state
  interface MemoryFileData {
    id: string
    path: string
    content: string
    scope: string
    createdAt: string
    updatedAt: string
  }
  const [userMemoryFiles, setUserMemoryFiles] = useState<MemoryFileData[]>([])
  const [globalMemoryFiles, setGlobalMemoryFiles] = useState<MemoryFileData[]>([])
  const [memoryLoading, setMemoryLoading] = useState(true)
  const [expandedMemory, setExpandedMemory] = useState<string | null>(null)
  const [memoryDeleting, setMemoryDeleting] = useState<string | null>(null)

  // MCP state
  const [connections, setConnections] = useState<McpConnectionData[]>([])
  const [mcpLoading, setMcpLoading] = useState(true)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingConnection, setEditingConnection] = useState<McpConnectionData | null>(null)
  // Role-driven MCP capabilities: no `mcp` permission → the tab is not shown at all;
  // personal editing only when the admin enabled it for the role.
  const [mcpAccess, setMcpAccess] = useState<{ enabled: boolean; canEditPersonal: boolean; canAddPersonal: boolean }>({ enabled: true, canEditPersonal: false, canAddPersonal: false })

  const getAuthHeaders = useCallback(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY) || ""
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }
  }, [])

  // Reset to default tab when opened
  useEffect(() => {
    if (open) {
      setActiveTab(defaultTab)
    }
  }, [open, defaultTab])

  // Load data when modal opens
  useEffect(() => {
    if (!open) return

    // Load theme preferences (color theme is admin-controlled — not loaded here)
    const savedTheme = localStorage.getItem(THEME_KEY) as Theme | null
    const savedFontSize = localStorage.getItem(FONT_SIZE_KEY)
    const savedCodeTheme = localStorage.getItem(CODE_THEME_KEY) as CodeTheme | null
    if (savedTheme) setTheme(savedTheme)
    if (savedFontSize) setFontSize(parseInt(savedFontSize))
    if (savedCodeTheme) setCodeTheme(savedCodeTheme)

    // Load profile and settings
    loadUserProfile()
    loadAnthropicConfig()
    fetchConnections()
    fetchMemoryFiles()
    loadCustomInstructions()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const loadUserProfile = async () => {
    try {
      const res = await fetch("/api/auth/me", { headers: getAuthHeaders() })
      if (res.ok) {
        const data = await res.json()
        setName(data.user.name || "")
        setEmail(data.user.email || "")
      }
    } catch (error) {
      console.error("Error loading profile:", error)
    }
  }

  const loadAnthropicConfig = async () => {
    try {
      const res = await fetch("/api/user/anthropic", { headers: getAuthHeaders() })
      if (res.ok) {
        const data = await res.json()
        setHasExistingApiKey(data.hasApiKey)
        setMaskedApiKey(data.maskedKey || "")
      }
    } catch (error) {
      console.error("Error loading Anthropic config:", error)
    }
  }

  const fetchConnections = async () => {
    try {
      const [res, accessRes] = await Promise.all([
        fetch("/api/mcp/connections?agent=all", { headers: getAuthHeaders() }),
        fetch("/api/mcp/access", { headers: getAuthHeaders() }),
      ])
      if (accessRes.ok) {
        const a = await accessRes.json()
        setMcpAccess({ enabled: !!a.enabled, canEditPersonal: !!a.canEditPersonal, canAddPersonal: !!a.canAddPersonal })
      }
      if (res.ok) {
        const data = await res.json()
        setConnections(Array.isArray(data) ? data : [])
      }
    } catch (error) {
      console.error("Error fetching MCP connections:", error)
    } finally {
      setMcpLoading(false)
    }
  }

  // Memory
  const fetchMemoryFiles = async () => {
    setMemoryLoading(true)
    try {
      const res = await fetch("/api/memory", { headers: getAuthHeaders() })
      if (res.ok) {
        const data = await res.json()
        setUserMemoryFiles(data.userFiles || [])
        setGlobalMemoryFiles(data.globalFiles || [])
      }
    } catch (error) {
      console.error("Error fetching memory files:", error)
    } finally {
      setMemoryLoading(false)
    }
  }

  const handleDeleteMemory = async (path: string, scope: string) => {
    setMemoryDeleting(path)
    try {
      const res = await fetch("/api/memory", {
        method: "DELETE",
        headers: getAuthHeaders(),
        body: JSON.stringify({ path }),
      })
      if (res.ok) {
        if (scope === "global") {
          setGlobalMemoryFiles(prev => prev.filter(f => f.path !== path))
        } else {
          setUserMemoryFiles(prev => prev.filter(f => f.path !== path))
        }
        if (expandedMemory === path) setExpandedMemory(null)
      }
    } catch (error) {
      console.error("Error deleting memory file:", error)
    } finally {
      setMemoryDeleting(null)
    }
  }

  const handleClearMemory = async (scope?: "user" | "global") => {
    const label = scope === "global" ? "global" : scope === "user" ? "personal" : "all"
    if (!confirm(`Are you sure you want to clear ${label} memory? This cannot be undone.`)) return
    try {
      const res = await fetch("/api/memory", {
        method: "DELETE",
        headers: getAuthHeaders(),
        body: JSON.stringify({ all: true, scope }),
      })
      if (res.ok) {
        if (!scope || scope === "user") setUserMemoryFiles([])
        if (!scope || scope === "global") setGlobalMemoryFiles([])
        setExpandedMemory(null)
      }
    } catch (error) {
      console.error("Error clearing memory:", error)
    }
  }

  // Instructions
  const loadCustomInstructions = () => {
    const saved = localStorage.getItem(INSTRUCTIONS_KEY)
    if (saved) setCustomInstructions(saved)
  }

  const handleSaveInstructions = () => {
    setInstructionsSaving(true)
    setInstructionsMessage(null)
    try {
      localStorage.setItem(INSTRUCTIONS_KEY, customInstructions)
      setInstructionsMessage({ type: "success", text: "Instructions saved successfully" })
    } catch {
      setInstructionsMessage({ type: "error", text: "Failed to save instructions" })
    } finally {
      setInstructionsSaving(false)
    }
  }

  // Theme
  const applyTheme = (newTheme: Theme) => {
    const root = document.documentElement
    if (newTheme === "dark") {
      root.classList.add("dark")
    } else if (newTheme === "light") {
      root.classList.remove("dark")
    } else {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
      if (prefersDark) root.classList.add("dark")
      else root.classList.remove("dark")
    }
  }

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme)
    localStorage.setItem(THEME_KEY, newTheme)
    applyTheme(newTheme)
  }

  const handleFontSizeChange = (newSize: number) => {
    setFontSize(newSize)
    localStorage.setItem(FONT_SIZE_KEY, String(newSize))
    document.documentElement.style.setProperty("--base-font-size", `${newSize}px`)
  }

  const handleCodeThemeChange = (newCodeTheme: CodeTheme) => {
    setCodeTheme(newCodeTheme)
    localStorage.setItem(CODE_THEME_KEY, newCodeTheme)
  }

  // Profile save
  const handleSaveProfile = async () => {
    setProfileSaving(true)
    setProfileMessage(null)
    try {
      const res = await fetch("/api/user/settings", {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({ name }),
      })
      if (res.ok) {
        setProfileMessage({ type: "success", text: "Profile updated successfully" })
      } else {
        const data = await res.json()
        setProfileMessage({ type: "error", text: data.error || "Failed to update profile" })
      }
    } catch {
      setProfileMessage({ type: "error", text: "Network error. Please try again." })
    } finally {
      setProfileSaving(false)
    }
  }

  // Password change
  const handleChangePassword = async () => {
    setPasswordChanging(true)
    setPasswordMessage(null)
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ type: "error", text: "New passwords do not match" })
      setPasswordChanging(false)
      return
    }
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (res.ok) {
        setPasswordMessage({ type: "success", text: "Password changed successfully" })
        setCurrentPassword("")
        setNewPassword("")
        setConfirmPassword("")
      } else {
        const data = await res.json()
        setPasswordMessage({ type: "error", text: data.error || "Failed to change password" })
      }
    } catch {
      setPasswordMessage({ type: "error", text: "Network error. Please try again." })
    } finally {
      setPasswordChanging(false)
    }
  }

  // Anthropic API key
  const handleTestAnthropicKey = async () => {
    setApiKeyTestStatus("testing")
    setApiKeyTestMessage("")
    try {
      const res = await fetch("/api/user/anthropic/test", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ apiKey: anthropicApiKey }),
      })
      const data = await res.json()
      if (res.ok) {
        setApiKeyTestStatus("success")
        setApiKeyTestMessage("API key is valid!")
      } else {
        setApiKeyTestStatus("error")
        setApiKeyTestMessage(data.error || "Validation failed")
      }
    } catch {
      setApiKeyTestStatus("error")
      setApiKeyTestMessage("Network error.")
    }
  }

  const handleSaveAnthropicKey = async () => {
    try {
      const res = await fetch("/api/user/anthropic", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ apiKey: anthropicApiKey }),
      })
      if (res.ok) {
        setApiKeyTestMessage("API key saved successfully")
        setApiKeyTestStatus("success")
        setHasExistingApiKey(true)
        setMaskedApiKey(anthropicApiKey.slice(0, 7) + "****" + anthropicApiKey.slice(-4))
        setAnthropicApiKey("")
      } else {
        const data = await res.json()
        setApiKeyTestMessage(data.error || "Failed to save")
        setApiKeyTestStatus("error")
      }
    } catch {
      setApiKeyTestMessage("Network error.")
      setApiKeyTestStatus("error")
    }
  }

  // MCP handlers
  const handleAddConnection = async (data: {
    name: string
    serverUrl: string
    authType: "none" | "api_key" | "oauth"
    oauthClientId?: string
    oauthClientSecret?: string
    apiKey?: string
    agent: AgentKey
  }) => {
    const res = await fetch("/api/mcp/connections", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    })
    if (res.ok) {
      await fetchConnections()
    } else {
      const error = await res.json()
      throw new Error(error.message || "Failed to add connection")
    }
  }

  const handleConnect = async (id: string) => {
    await fetch(`/api/mcp/connections/${id}/test`, { method: "POST", headers: getAuthHeaders() })
    await fetchConnections()
  }

  const handleDisconnect = async (id: string) => {
    await fetch(`/api/mcp/connections/${id}`, {
      method: "PATCH",
      headers: getAuthHeaders(),
      body: JSON.stringify({ status: "disconnected", isActive: false }),
    })
    await fetchConnections()
  }

  const handleEditConnection = (connection: McpConnectionData) => {
    setEditingConnection(connection)
    setShowAddDialog(true)
  }

  const handleDeleteConnection = async (id: string) => {
    await fetch(`/api/mcp/connections/${id}`, { method: "DELETE", headers: getAuthHeaders() })
    await fetchConnections()
  }

  const handleRefreshTools = async (id: string) => {
    await fetch(`/api/mcp/connections/${id}/discover`, { method: "POST", headers: getAuthHeaders() })
    await fetchConnections()
  }

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 animate-in fade-in-0 duration-200"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto flex w-full max-w-[820px] h-[min(640px,88vh)] rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Left sidebar */}
          <div className="flex w-[240px] shrink-0 flex-col border-r border-border p-3">
            <h2 className="mb-4 px-3 pt-1 text-lg font-semibold text-foreground">Settings</h2>
            <nav className="flex flex-col gap-0.5">
              {SETTINGS_TABS.filter((tab) => tab.id !== "mcp" || mcpAccess.enabled).map((tab) => (
                <Button
                  key={tab.id}
                  variant="ghost"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex h-auto items-center justify-start gap-3 rounded-lg border-0 px-3 py-2 text-sm font-medium transition-colors active:scale-100",
                    activeTab === tab.id
                      ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground dark:hover:bg-primary dark:hover:text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted"
                  )}
                >
                  <tab.icon className="size-4" />
                  {tab.label}
                </Button>
              ))}
            </nav>
          </div>

          {/* Right content */}
          <div className="flex flex-1 flex-col min-w-0">
            {/* Header with close button */}
            <div className="flex items-center justify-end p-3">
              <Button
                variant="ghost"
                onClick={onClose}
                className="h-auto rounded-md border-0 p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted transition-colors active:scale-100"
                type="button"
                aria-label="Close settings"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-6 pb-6">
              {/* GENERAL TAB */}
              {activeTab === "general" && (
                <div className="space-y-8">
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-5">
                      General Settings
                    </h3>

                    {/* Default Model */}
                    <div className="mb-6">
                      <label className="text-sm font-medium text-foreground mb-2 block">Default Model</label>
                      <Select
                        value={defaultModel}
                        onValueChange={(value) => {
                          setDefaultModel(value)
                          onDefaultModelChange?.(value)
                        }}
                      >
                        <SelectTrigger className="w-full h-auto rounded-lg border-border bg-background px-3 py-2.5 text-sm text-foreground">
                          <SelectValue placeholder="Select a model" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {CLAUDE_MODELS.map((m) => (
                              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Default Reasoning Level */}
                    <div className="mb-6">
                      <label className="text-sm font-medium text-foreground mb-2 block">Default Reasoning Level</label>
                      <div className="flex rounded-lg border border-border overflow-hidden">
                        {["Low", "Medium", "High"].map((level) => (
                          <Button
                            key={level}
                            variant="ghost"
                            className={cn(
                              "h-auto flex-1 rounded-none border-0 py-2.5 text-sm font-medium transition-colors active:scale-100",
                              level === "Medium"
                                ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground dark:hover:bg-primary dark:hover:text-primary-foreground"
                                : "bg-background text-foreground hover:bg-muted dark:hover:bg-muted"
                            )}
                          >
                            {level}
                          </Button>
                        ))}
                      </div>
                    </div>

                    {/* Language */}
                    <div className="mb-6">
                      <label className="text-sm font-medium text-foreground mb-2 block">Language</label>
                      <Select defaultValue="en-US">
                        <SelectTrigger className="w-full h-auto rounded-lg border-border bg-background px-3 py-2.5 text-sm text-foreground">
                          <SelectValue placeholder="Select a language" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="en-US">English (US)</SelectItem>
                            <SelectItem value="en-GB">English (UK)</SelectItem>
                            <SelectItem value="es">Spanish</SelectItem>
                            <SelectItem value="fr">French</SelectItem>
                            <SelectItem value="de">German</SelectItem>
                            <SelectItem value="ja">Japanese</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="border-t border-border" />

                  {/* Chat Behavior */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-5">
                      Chat Behavior
                    </h3>

                    <div className="space-y-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-foreground">Send with Enter</p>
                          <p className="text-xs text-muted-foreground">Use Shift+Enter for new line</p>
                        </div>
                        <Switch checked={sendWithEnter} onCheckedChange={setSendWithEnter} />
                      </div>

                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-foreground">Show code execution results</p>
                          <p className="text-xs text-muted-foreground">Display output of code blocks</p>
                        </div>
                        <Switch checked={showCodeResults} onCheckedChange={setShowCodeResults} />
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-border" />

                  {/* Account */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-5">
                      Account
                    </h3>

                    <div className="space-y-4">
                      <div>
                        <label className="text-sm font-medium text-foreground mb-1.5 block">Display Name</label>
                        <Input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="Your name"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium text-foreground mb-1.5 block">Email</label>
                        <Input value={email} disabled className="opacity-60" />
                        <p className="text-xs text-muted-foreground mt-1">Email cannot be changed</p>
                      </div>
                      {profileMessage && (
                        <div className={cn(
                          "flex items-center gap-2 rounded-md p-3 text-sm",
                          profileMessage.type === "success"
                            ? "bg-green-500/10 text-green-700 dark:text-green-400"
                            : "bg-destructive/10 text-destructive"
                        )}>
                          {profileMessage.type === "success" ? <Check className="size-4" /> : <AlertCircle className="size-4" />}
                          {profileMessage.text}
                        </div>
                      )}
                      <Button size="sm" onClick={handleSaveProfile} disabled={profileSaving}>
                        {profileSaving ? "Saving..." : "Save Changes"}
                      </Button>
                    </div>
                  </div>

                  <div className="border-t border-border" />

                  {/* Change Password */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-5">
                      Change Password
                    </h3>

                    <div className="space-y-4">
                      <div>
                        <label className="text-sm font-medium text-foreground mb-1.5 block">Current Password</label>
                        <div className="relative">
                          <Input
                            type={showCurrentPassword ? "text" : "password"}
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            className="absolute right-0 top-0 flex h-full items-center rounded-none border-0 px-3 text-muted-foreground hover:bg-transparent hover:text-foreground active:scale-100 transition-none dark:hover:bg-transparent"
                            onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                            aria-label={showCurrentPassword ? "Hide current password" : "Show current password"}
                            aria-pressed={showCurrentPassword}
                          >
                            {showCurrentPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                          </Button>
                        </div>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-foreground mb-1.5 block">New Password</label>
                        <div className="relative">
                          <Input
                            type={showNewPassword ? "text" : "password"}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            className="absolute right-0 top-0 flex h-full items-center rounded-none border-0 px-3 text-muted-foreground hover:bg-transparent hover:text-foreground active:scale-100 transition-none dark:hover:bg-transparent"
                            onClick={() => setShowNewPassword(!showNewPassword)}
                            aria-label={showNewPassword ? "Hide new password" : "Show new password"}
                            aria-pressed={showNewPassword}
                          >
                            {showNewPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                          </Button>
                        </div>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-foreground mb-1.5 block">Confirm New Password</label>
                        <Input
                          type="password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                        />
                      </div>
                      {passwordMessage && (
                        <div className={cn(
                          "flex items-center gap-2 rounded-md p-3 text-sm",
                          passwordMessage.type === "success"
                            ? "bg-green-500/10 text-green-700 dark:text-green-400"
                            : "bg-destructive/10 text-destructive"
                        )}>
                          {passwordMessage.type === "success" ? <Check className="size-4" /> : <AlertCircle className="size-4" />}
                          {passwordMessage.text}
                        </div>
                      )}
                      <Button
                        size="sm"
                        onClick={handleChangePassword}
                        disabled={passwordChanging || !currentPassword || !newPassword || !confirmPassword}
                      >
                        {passwordChanging ? "Changing..." : "Change Password"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* APPEARANCE TAB */}
              {activeTab === "appearance" && (
                <div className="space-y-8">
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-5">
                      Appearance
                    </h3>

                    {/* Theme */}
                    <div className="mb-6">
                      <label className="text-sm font-medium text-foreground mb-2 block">Theme</label>
                      <div className="flex rounded-lg border border-border overflow-hidden">
                        {([
                          { id: "light" as Theme, label: "Light", icon: Sun },
                          { id: "dark" as Theme, label: "Dark", icon: Moon },
                          { id: "system" as Theme, label: "System", icon: Monitor },
                        ]).map((t) => (
                          <Button
                            key={t.id}
                            variant="ghost"
                            onClick={() => handleThemeChange(t.id)}
                            className={cn(
                              "flex h-auto flex-1 items-center justify-center gap-2 rounded-none border-0 py-2.5 text-sm font-medium transition-colors active:scale-100",
                              theme === t.id
                                ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground dark:hover:bg-primary dark:hover:text-primary-foreground"
                                : "bg-background text-foreground hover:bg-muted dark:hover:bg-muted"
                            )}
                          >
                            <t.icon className="size-4" />
                            {t.label}
                          </Button>
                        ))}
                      </div>
                    </div>

                    {/* Color Theme — managed centrally by the administrator */}
                    <div className="mb-6">
                      <label className="text-sm font-medium text-foreground mb-2 block">Color Theme</label>
                      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[13px] text-muted-foreground">
                        The color theme is managed by your administrator and applies across the platform.
                      </div>
                    </div>

                    {/* Font Size */}
                    <div className="mb-6">
                      <label className="text-sm font-medium text-foreground mb-2 block">Font Size</label>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Small (14px)</span>
                          <span className="font-medium text-foreground">{fontSize}px</span>
                          <span>Large (20px)</span>
                        </div>
                        <Slider
                          min={14}
                          max={20}
                          step={1}
                          value={[fontSize]}
                          onValueChange={(vals) => handleFontSizeChange(vals[0])}
                          className="w-full"
                        />
                        <p className="text-center text-sm text-muted-foreground" style={{ fontSize: `${fontSize}px` }}>
                          Sample text at {fontSize}px
                        </p>
                      </div>
                    </div>

                    {/* Code Theme */}
                    <div>
                      <label className="text-sm font-medium text-foreground mb-2 block">Code Theme</label>
                      <div className="flex rounded-lg border border-border overflow-hidden">
                        {([
                          { id: "github-dark" as CodeTheme, label: "GitHub Dark" },
                          { id: "one-dark-pro" as CodeTheme, label: "One Dark Pro" },
                          { id: "dracula" as CodeTheme, label: "Dracula" },
                        ]).map((ct) => (
                          <Button
                            key={ct.id}
                            variant="ghost"
                            onClick={() => handleCodeThemeChange(ct.id)}
                            className={cn(
                              "h-auto flex-1 rounded-none border-0 py-2.5 text-sm font-medium transition-colors active:scale-100",
                              codeTheme === ct.id
                                ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground dark:hover:bg-primary dark:hover:text-primary-foreground"
                                : "bg-background text-foreground hover:bg-muted dark:hover:bg-muted"
                            )}
                          >
                            {ct.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* API KEYS TAB */}
              {activeTab === "api-keys" && (
                <div className="space-y-8">
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-5">
                      Anthropic API
                    </h3>

                    {hasExistingApiKey && (
                      <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/20">
                        <div className="flex items-center gap-2 text-green-800 dark:text-green-400">
                          <Check className="size-4" />
                          <span className="text-sm font-medium">API key configured</span>
                        </div>
                        <p className="mt-1 text-xs text-green-700 dark:text-green-500">
                          Key: {maskedApiKey}
                        </p>
                      </div>
                    )}

                    <div className="space-y-4">
                      <div>
                        <label className="text-sm font-medium text-foreground mb-1.5 block">Anthropic API Key</label>
                        <Input
                          type="password"
                          placeholder={hasExistingApiKey ? "Enter new key to update..." : "sk-ant-..."}
                          value={anthropicApiKey}
                          onChange={(e) => setAnthropicApiKey(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          Your key starts with &quot;sk-ant-&quot;.{" "}
                          <a
                            href="https://console.anthropic.com/settings/keys"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-foreground"
                          >
                            Get your API key
                          </a>
                        </p>
                      </div>

                      {apiKeyTestMessage && (
                        <div className={cn(
                          "flex items-center gap-2 rounded-md p-3 text-sm",
                          apiKeyTestStatus === "success"
                            ? "bg-green-500/10 text-green-700 dark:text-green-400"
                            : apiKeyTestStatus === "error"
                              ? "bg-destructive/10 text-destructive"
                              : "bg-muted"
                        )}>
                          {apiKeyTestStatus === "success" && <Check className="size-4" />}
                          {apiKeyTestStatus === "error" && <AlertCircle className="size-4" />}
                          {apiKeyTestMessage}
                        </div>
                      )}

                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleTestAnthropicKey}
                          disabled={apiKeyTestStatus === "testing" || !anthropicApiKey}
                        >
                          {apiKeyTestStatus === "testing" ? "Testing..." : "Test Key"}
                        </Button>
                        <Button size="sm" onClick={handleSaveAnthropicKey} disabled={!anthropicApiKey}>
                          Save Key
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* MCP TAB */}
              {activeTab === "mcp" && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      MCP Connectors
                    </h3>
                    {mcpAccess.canAddPersonal && (
                      <Button variant="outline" size="sm" onClick={() => { setEditingConnection(null); setShowAddDialog(true) }}>
                        <Plus className="mr-1.5 h-3.5 w-3.5" /> Add connector
                      </Button>
                    )}
                  </div>

                  {mcpLoading ? (
                    <div className="space-y-3 py-4">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="rounded-lg border p-4 space-y-3">
                          <div className="flex items-center gap-3">
                            <div className="h-10 w-10 shrink-0 rounded-full bg-muted animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
                            <div className="flex-1 space-y-1.5">
                              <div className="h-4 w-1/3 rounded bg-muted animate-pulse" style={{ animationDelay: `${i * 100 + 50}ms` }} />
                              <div className="h-3 w-1/2 rounded bg-muted animate-pulse" style={{ animationDelay: `${i * 100 + 100}ms` }} />
                            </div>
                            <div className="h-6 w-14 rounded-full bg-muted animate-pulse" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : connections.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Plug className="mb-3 size-10 text-muted-foreground/50" />
                      <p className="text-sm font-medium text-foreground mb-1">No connectors</p>
                      <p className="text-xs text-muted-foreground mb-4">
                        {mcpAccess.canAddPersonal ? "Add a connector or ask your administrator to assign one to your role." : "MCP connections are managed by your administrator."}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {/* One group per agent: a connector is visible only to the agent it belongs to. */}
                      {AGENT_KEYS.map((agent) => {
                        const rows = connections.filter((c) => agentKeyFrom(c.agent) === agent)
                        if (rows.length === 0) return null
                        return (
                          <div key={agent} className="space-y-3">
                            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{AGENT_LABELS[agent]}</p>
                            {rows.map((connection) => (
                              <McpConnectionCard
                                key={connection.id}
                                connection={connection}
                                onConnect={handleConnect}
                                onDisconnect={handleDisconnect}
                                onEdit={handleEditConnection}
                                onDelete={handleDeleteConnection}
                                onRefresh={handleRefreshTools}
                                canEdit={mcpAccess.canEditPersonal}
                              />
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* INSTRUCTIONS TUNING TAB */}
              {activeTab === "instructions" && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Instructions Tuning
                    </h3>
                    <p className="text-sm text-muted-foreground mb-5">
                      Provide custom instructions that Agent will follow in every conversation. This helps tailor responses to your preferences.
                    </p>

                    <div className="space-y-4">
                      <div>
                        <label className="text-sm font-medium text-foreground mb-1.5 block">
                          Custom Instructions
                        </label>
                        <Textarea
                          value={customInstructions}
                          onChange={(e) => setCustomInstructions(e.target.value)}
                          placeholder="e.g., Always respond in a concise manner. Use code examples when explaining technical concepts. Prefer TypeScript over JavaScript..."
                          className="field-sizing-fixed min-h-[200px] resize-y rounded-lg border-border bg-background px-3 py-2.5 text-sm text-foreground shadow-none transition-none focus:outline-none focus:ring-2 focus:ring-ring focus-visible:border-border focus-visible:ring-2 focus-visible:ring-ring dark:bg-background"
                          rows={8}
                        />
                        <p className="text-xs text-muted-foreground mt-1.5">
                          These instructions will be included as context in every new conversation.
                        </p>
                      </div>

                      {instructionsMessage && (
                        <div className={cn(
                          "flex items-center gap-2 rounded-md p-3 text-sm",
                          instructionsMessage.type === "success"
                            ? "bg-green-500/10 text-green-700 dark:text-green-400"
                            : "bg-destructive/10 text-destructive"
                        )}>
                          {instructionsMessage.type === "success" ? <Check className="size-4" /> : <AlertCircle className="size-4" />}
                          {instructionsMessage.text}
                        </div>
                      )}

                      <Button size="sm" onClick={handleSaveInstructions} disabled={instructionsSaving}>
                        {instructionsSaving ? "Saving..." : "Save Instructions"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* ADVANCED TAB */}
              {activeTab === "memory" && (
                <div className="space-y-8">
                  <p className="text-xs text-muted-foreground">
                    Claude saves important information to remember across conversations. <strong>Personal</strong> memories are private to you. <strong>Shared</strong> memories are visible to all users.
                  </p>

                  {memoryLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : userMemoryFiles.length === 0 && globalMemoryFiles.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Brain className="mb-3 size-10 text-muted-foreground/50" />
                      <p className="text-sm font-medium text-foreground mb-1">No memories yet</p>
                      <p className="text-xs text-muted-foreground">
                        Claude will save important information here as you chat.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Personal Memory */}
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Personal Memory
                          </h3>
                          {userMemoryFiles.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs text-destructive hover:text-destructive"
                              onClick={() => handleClearMemory("user")}
                            >
                              <Trash2 className="size-3 mr-1" />
                              Clear
                            </Button>
                          )}
                        </div>
                        {userMemoryFiles.length === 0 ? (
                          <p className="text-xs text-muted-foreground py-4 text-center">No personal memories yet.</p>
                        ) : (
                          <div className="space-y-2">
                            {userMemoryFiles.map((file) => (
                              <div key={file.id} className="border rounded-lg overflow-hidden">
                                <div
                                  className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
                                  onClick={() => setExpandedMemory(expandedMemory === file.path ? null : file.path)}
                                >
                                  <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <FileText className="size-3.5 text-muted-foreground shrink-0" />
                                    <span className="text-sm font-mono truncate">{file.path}</span>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0 ml-2">
                                    <span className="text-[10px] text-muted-foreground">
                                      {new Date(file.updatedAt).toLocaleDateString()}
                                    </span>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="size-6 p-0 text-muted-foreground hover:text-destructive"
                                      onClick={(e) => { e.stopPropagation(); handleDeleteMemory(file.path, "user") }}
                                      disabled={memoryDeleting === file.path}
                                      aria-label={`Delete memory ${file.path}`}
                                    >
                                      {memoryDeleting === file.path ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Trash2 className="size-3" aria-hidden="true" />}
                                    </Button>
                                  </div>
                                </div>
                                {expandedMemory === file.path && (
                                  <div className="border-t px-3 py-2.5 bg-muted/30">
                                    <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80 max-h-60 overflow-y-auto">{file.content}</pre>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Shared Memory */}
                      <div>
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Shared Memory
                          </h3>
                          {globalMemoryFiles.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs text-destructive hover:text-destructive"
                              onClick={() => handleClearMemory("global")}
                            >
                              <Trash2 className="size-3 mr-1" />
                              Clear
                            </Button>
                          )}
                        </div>
                        {globalMemoryFiles.length === 0 ? (
                          <p className="text-xs text-muted-foreground py-4 text-center">No shared memories yet.</p>
                        ) : (
                          <div className="space-y-2">
                            {globalMemoryFiles.map((file) => (
                              <div key={file.id} className="border rounded-lg overflow-hidden">
                                <div
                                  className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
                                  onClick={() => setExpandedMemory(expandedMemory === file.path ? null : file.path)}
                                >
                                  <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <FileText className="size-3.5 text-muted-foreground shrink-0" />
                                    <span className="text-sm font-mono truncate">{file.path}</span>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0 ml-2">
                                    <span className="text-[10px] text-muted-foreground">
                                      {new Date(file.updatedAt).toLocaleDateString()}
                                    </span>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="size-6 p-0 text-muted-foreground hover:text-destructive"
                                      onClick={(e) => { e.stopPropagation(); handleDeleteMemory(file.path, "global") }}
                                      disabled={memoryDeleting === file.path}
                                      aria-label={`Delete shared memory ${file.path}`}
                                    >
                                      {memoryDeleting === file.path ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Trash2 className="size-3" aria-hidden="true" />}
                                    </Button>
                                  </div>
                                </div>
                                {expandedMemory === file.path && (
                                  <div className="border-t px-3 py-2.5 bg-muted/30">
                                    <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80 max-h-60 overflow-y-auto">{file.content}</pre>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {activeTab === "advanced" && (
                <div className="space-y-8">
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-5">
                      Advanced Settings
                    </h3>
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Sliders className="mb-3 size-10 text-muted-foreground/50" />
                      <p className="text-sm font-medium text-foreground mb-1">Coming soon</p>
                      <p className="text-xs text-muted-foreground">
                        Advanced settings for power users.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <McpAddDialog
        open={showAddDialog}
        onOpenChange={(openState) => {
          setShowAddDialog(openState)
          if (!openState) setEditingConnection(null)
        }}
        onAdd={handleAddConnection}
        editData={editingConnection}
      />
    </>
  )
}
