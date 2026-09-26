"use client"

import {
  ChatContainerContent,
  ChatContainerRoot,
} from "@/shared/components/prompt-kit/chat-container"
import {
  Message,
  MessageContent,
} from "@/shared/components/prompt-kit/message"
// PromptInput components replaced by ClaudeChatInput
import { ScrollButton } from "@/shared/components/prompt-kit/scroll-button"
import { Button } from "@/shared/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu"
// Tooltip imports removed - now handled by ClaudeChatInput
import { Switch } from "@/shared/components/ui/switch"
// Label removed - using plain <label> in McpConnectionsSubmenu
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/shared/components/ui/sidebar"
import { cn } from "@/shared/lib/utils"
import { useChat } from "@ai-sdk/react"
import { type UIMessage, DefaultChatTransport } from "ai"
import {
  ChevronUp,
  LogOut,
  MoreHorizontal,
  Pin,
  PinOff,
  Settings,
  Share2,
  Shield,
  Trash,
  FileIcon,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useKeyboardShortcuts, CHAT_SHORTCUTS } from "@/shared/hooks/use-keyboard-shortcuts"
import { motion, AnimatePresence } from "motion/react"
import { createFileArtifact, type Artifact } from "@/shared/lib/artifacts"
import { extractTagArtifacts, segmentMessageText } from "@/shared/lib/artifact-parser"
import { ArtifactTile } from "@/shared/components/prompt-kit/artifact-tile"
import { isPreviewableFile } from "@/shared/lib/file-classifier"
import { useFileContent } from "@/shared/hooks/use-file-content"
// ArtifactTile removed — artifacts now open directly in preview panel
import { ArtifactPanelWrapper } from "@/shared/components/artifact-panel-wrapper"
import { CodeBlock, CodeBlockCode } from "@/shared/components/prompt-kit/code-block"
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels"
import { extractToolParts, type ToolPart } from "@/shared/components/prompt-kit/tool"
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/shared/components/prompt-kit/reasoning"
import { TextShimmer } from "@/shared/components/prompt-kit/text-shimmer"
import { WaitLadder, isWaitPhase, type WaitPhase } from "@/modules/coding-agent/components/wait-ladder"
import { WorkPanel, type OpenFile, type PanelTab } from "@/modules/coding-agent/components/work-panel"
import { streamTail } from "@/modules/coding-agent/lib/stream-tail"
import { PreValidationCard, type PreValidationReport }
  from "@/modules/coding-agent/components/prevalidation-card"
import { FeedbackBar } from "@/shared/components/prompt-kit/feedback-bar"
// PromptSuggestion replaced by inline chips in welcome state
import { SystemMessage } from "@/shared/components/prompt-kit/system-message"
import { StreamingText } from "@/shared/components/prompt-kit/streaming-text"
import { ToolTimeline } from "@/shared/components/prompt-kit/tool-timeline"
import { FileCard } from "@/shared/components/prompt-kit/file-card"
import { artifactRole } from "@/modules/coding-agent/lib/artifact-kind"
import { ClaudeChatInput, type ClaudeChatInputHandle } from "@/shared/components/ui/claude-style-chat-input"
import { EntryForm, type FormSpec } from "@/modules/master-data-load/components/entry-form"
import {
  LoadValidationCard,
  LoadReceiptCard,
  type ValidateForLoadResult,
  type LoadToCmfResult,
} from "@/modules/master-data-load/components/load-cards"
import { SettingsModal } from "@/shared/components/settings-modal"
import { ErrorCard, visibleErrorDetails, errorDetailFromText } from "@/shared/components/prompt-kit/error-card"
import { MessageActionBar, InlineMessageEditor } from "@/shared/components/prompt-kit/message-action-bar"
import { toast } from "sonner"
import { fileParts, newMessageId, type FilePart } from "@/shared/lib/message-files"
import { AUTH_SESSION_KEY, AUTH_TOKEN_KEY, getAuthHeaders, getUserEmailFromSession, getUserNameFromSession } from "@/shared/lib/client-session"
import { getGreeting } from "@/shared/lib/greeting"
// Image import removed - welcome state no longer uses logo

// Time-based greeting helper
// Platform models, tiered by capability (lowest number = lowest tier)
const CLAUDE_MODELS = [
  {
    id: "claude-sonnet-5",
    name: "FabOrchestrator 1",
    description: "Fast and efficient for everyday work",
  },
  {
    id: "claude-opus-5",
    name: "FabOrchestrator 2",
    description: "Strong reasoning for complex tasks",
  },
  {
    id: "claude-fable-5",
    name: "FabOrchestrator 3",
    description: "Advanced reasoning for demanding work",
  },
  {
    id: "claude-fable-5-1",
    name: "FabOrchestrator 4",
    description: "Most capable model",
  },
] as const

// Tagline removed - welcome state now uses time-based greeting

type ClaudeModelId = (typeof CLAUDE_MODELS)[number]["id"]

// Database conversation type
interface Conversation {
  id: string
  title: string
  isPinned: boolean
  isShared: boolean
  model: string
  createdAt: string
  updatedAt: string
  lastMessage: string | null
}


// Helper function to get auth headers for API calls
/**
 * The bearer token ALONE, for multipart uploads.
 *
 * `getAuthHeaders()` below also sets `Content-Type: application/json`, which is
 * right for every JSON call and fatal for a file: setting the content type by
 * hand overrides the multipart boundary the browser would have generated, the
 * server cannot parse the body, and the upload fails with "no file was
 * attached" while the request itself looks perfectly normal. Measured driving
 * the screen, 2026-09-07.
 */
/**
 * The human-readable half of this application's error envelope.
 *
 * Routes answer `{ error: { errorId, type, message } }` on failure, and passing
 * that object straight to `new Error(...)` yields the literal string
 * "[object Object]" — which is what an engineer saw in the console instead of
 * "Your session has expired". Accepts the plain-string shape too, because some
 * routes still answer `{ error: "..." }`.
 */
/*
 * THE SENTENCE THAT MARKS AN ATTACHED DOCUMENT.
 *
 * Written into the user's message so the MODEL knows a document arrived — the
 * file itself never reaches it, only the text extracted server-side. Read back
 * by `attachedDocument` so the UI can show a card instead of the sentence.
 *
 * One definition for both, because a marker written in one place and matched in
 * another is a pair that drifts: reword the sentence and the card silently stops
 * appearing, leaving on screen the raw text it was meant to replace.
 */
const attachedLine = (name: string): string =>
  `Attached the requirement document "${name}".`

const ATTACHED_RE = /\s*Attached the requirement document "([^"]+)"\.\s*/

/** The document named in a message, and the message with that sentence removed. */
function attachedDocument(text: string): { name: string | null; rest: string } {
  const m = ATTACHED_RE.exec(text)
  return m
    ? { name: m[1]!, rest: text.replace(ATTACHED_RE, " ").trim() }
    : { name: null, rest: text }
}

function errorMessageOf(body: unknown, status: number): string {
  const err = (body as { error?: unknown } | null)?.error
  if (typeof err === "string" && err.trim()) return err
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message
    if (typeof m === "string" && m.trim()) return m
  }
  return `HTTP ${status}`
}

/** An expired session is a signal to sign in again, not an error to report. */
function isSignedOut(status: number): boolean {
  return status === 401
}

/** The two `useChat` statuses that mean a turn is in flight. */
function isLoadingStatus(status: string): boolean {
  return status === "submitted" || status === "streaming"
}

function getAuthOnlyHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) || "" : ""
  return { Authorization: `Bearer ${token}` }
}

// Helper function to get user name from session
// Helper function to get user email from session
/**
 * The sentence inside a failed chat request.
 *
 * When the route refuses BEFORE streaming — the pipeline's reference material
 * cannot be assembled, the conversation is not the caller's — it answers with
 * a JSON body, and the AI SDK hands that body over verbatim as the error's
 * message. Shown raw, the engineer read `{"error":"…"}` on screen. This takes
 * the sentence out of the envelope and leaves any other text alone.
 */
function chatErrorText(message: string | undefined): string {
  const raw = (message ?? "").trim()
  if (!raw.startsWith("{")) return raw
  try {
    const body = JSON.parse(raw) as { error?: string | { message?: string } }
    const err = body?.error
    if (typeof err === "string") return err
    if (err && typeof err.message === "string") return err.message
  } catch {
    /* not JSON after all — show it as it came */
  }
  return raw
}

// Badge colors for MCP connection initials
const MCP_BADGE_COLORS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
]

// MCP Connections Submenu Component - Claude.ai Connectors style
function McpConnectionsSubmenu({
  activeMcpIds,
  onToggle,
  onManageConnectors,
}: {
  activeMcpIds: string[]
  onToggle: (connectionId: string, isActive: boolean) => void
  onManageConnectors?: () => void
}) {
  const [connections, setConnections] = useState<{
    id: string
    name: string
    status: string
    availableTools?: { name: string }[]
  }[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const fetchConnections = async () => {
      try {
        const res = await fetch("/api/mcp/connections?agent=coding-agent", {
          headers: getAuthHeaders(),
        })
        if (res.ok) {
          const data = await res.json()
          setConnections(data)
        }
      } catch {
        // Silently fail - MCP connections are optional
      } finally {
        setIsLoading(false)
      }
    }
    fetchConnections()
  }, [])

  const connectedConnections = connections.filter((c) => c.status === "connected")

  if (isLoading) {
    return (
      <div className="space-y-2 px-3 py-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <div className="h-4 w-4 shrink-0 rounded bg-muted animate-pulse" />
            <div className="h-3.5 flex-1 rounded bg-muted animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
          </div>
        ))}
      </div>
    )
  }

  if (connections.length === 0) {
    return (
      <>
        <div className="px-3 py-4 text-center">
          <p className="text-[13px] text-text-500">No connectors configured</p>
        </div>
        <div className="border-t border-border dark:border-sidebar-border" />
        <Button
          variant="ghost"
          onClick={onManageConnectors}
          className="flex h-auto items-center justify-start gap-3 border-0 bg-transparent px-3 py-2.5 mx-1 my-1 rounded-lg text-[14px] text-text-200 dark:text-foreground hover:bg-bg-hover dark:hover:bg-bg-hover transition-colors cursor-pointer w-[calc(100%-8px)] active:scale-100"
          type="button"
        >
          <Settings className="h-[18px] w-[18px] text-text-300 dark:text-text-500" />
          Manage connectors
        </Button>
      </>
    )
  }

  if (connectedConnections.length === 0) {
    return (
      <>
        <div className="px-3 py-4 text-center">
          <p className="text-[13px] text-text-500">No connected servers</p>
        </div>
        <div className="border-t border-border dark:border-sidebar-border" />
        <Button
          variant="ghost"
          onClick={onManageConnectors}
          className="flex h-auto items-center justify-start gap-3 border-0 bg-transparent px-3 py-2.5 mx-1 my-1 rounded-lg text-[14px] text-text-200 dark:text-foreground hover:bg-bg-hover dark:hover:bg-bg-hover transition-colors cursor-pointer w-[calc(100%-8px)] active:scale-100"
          type="button"
        >
          <Settings className="h-[18px] w-[18px] text-text-300 dark:text-text-500" />
          Manage connectors
        </Button>
      </>
    )
  }

  return (
    <>
      {connectedConnections.map((connection, idx) => {
        const isActive = activeMcpIds.includes(connection.id)
        const initial = connection.name.charAt(0).toUpperCase()
        const badgeColor = MCP_BADGE_COLORS[idx % MCP_BADGE_COLORS.length]

        return (
          <div
            key={connection.id}
            className="flex items-center gap-3 px-3 py-2 mx-1 rounded-lg hover:bg-bg-hover dark:hover:bg-bg-hover transition-colors"
          >
            {/* Initial badge */}
            <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${badgeColor}`}>
              {initial}
            </div>
            {/* Name */}
            <span
              className="flex-1 text-[14px] text-text-200 dark:text-foreground truncate cursor-default"
              title={connection.name}
            >
              {connection.name}
            </span>
            {/* Toggle */}
            <Switch
              id={`mcp-plus-${connection.id}`}
              checked={isActive}
              onCheckedChange={(checked) => onToggle(connection.id, checked)}
              className="shrink-0"
            />
          </div>
        )
      })}
      <div className="my-1 border-t border-border dark:border-sidebar-border" />
      <Button
        variant="ghost"
        onClick={onManageConnectors}
        className="flex h-auto items-center justify-start gap-3 border-0 bg-transparent px-3 py-2.5 mx-1 mb-1 rounded-lg text-[14px] text-text-200 dark:text-foreground hover:bg-bg-hover dark:hover:bg-bg-hover transition-colors cursor-pointer w-[calc(100%-8px)] active:scale-100"
        type="button"
      >
        <Settings className="h-[18px] w-[18px] text-text-300 dark:text-text-500" />
        Manage connectors
      </Button>
    </>
  )
}

// Inline nav icons copied verbatim from 4_/5_Sidebar HTML mockups so the
// sidebar glyphs match the design exactly (18px, stroke, round caps).
function NavSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

function ChatSidebar({
  conversations,
  selectedId,
  onSelectConversation,
  onNewChat,
  onDeleteConversation,
  onPinConversation,
  onShareConversation,
  userName,
  userEmail,
  isAdmin = false,
  onOpenSettings,
}: {
  conversations: Conversation[]
  selectedId: string | null
  onSelectConversation: (id: string) => void
  onNewChat: () => void
  onDeleteConversation: (id: string) => void
  onPinConversation: (id: string, isPinned: boolean) => void
  onShareConversation: (id: string) => void
  userName: string
  userEmail: string
  /** Admins get an "Admin Console" entry in the account menu. */
  isAdmin?: boolean
  onOpenSettings: () => void
}) {
  const router = useRouter()

  const handleSignOut = async () => {
    // REQ-02 — call the logout API so user_session_logs row is closed
    // (CLOSED_LOGOUT). Fire-and-forget; don't block redirect on network.
    const token = window.localStorage.getItem(AUTH_TOKEN_KEY)
    if (token) {
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch {
        // Ignore — still proceed to clear localStorage and redirect.
      }
    }
    window.localStorage.removeItem(AUTH_SESSION_KEY)
    window.localStorage.removeItem(AUTH_TOKEN_KEY)
    router.push("/")
  }

  // Ensure conversations is always an array
  const safeConversations = Array.isArray(conversations) ? conversations : []
  const pinnedConversations = safeConversations.filter((c) => c.isPinned)
  const unpinnedConversations = safeConversations.filter((c) => !c.isPinned)

  // Group unpinned conversations by time period
  const groupedConversations = useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfYesterday = new Date(startOfToday)
    startOfYesterday.setDate(startOfYesterday.getDate() - 1)
    const startOf7DaysAgo = new Date(startOfToday)
    startOf7DaysAgo.setDate(startOf7DaysAgo.getDate() - 7)
    const startOf14DaysAgo = new Date(startOfToday)
    startOf14DaysAgo.setDate(startOf14DaysAgo.getDate() - 14)
    const startOf30DaysAgo = new Date(startOfToday)
    startOf30DaysAgo.setDate(startOf30DaysAgo.getDate() - 30)

    const groups: { label: string; conversations: Conversation[] }[] = [
      { label: 'Today', conversations: [] },
      { label: 'Yesterday', conversations: [] },
      { label: 'Previous 7 days', conversations: [] },
      { label: 'Previous 14 days', conversations: [] },
      { label: 'Previous 30 days', conversations: [] },
      { label: 'Older', conversations: [] },
    ]

    for (const conv of unpinnedConversations) {
      const date = new Date(conv.updatedAt)
      if (date >= startOfToday) {
        groups[0].conversations.push(conv)
      } else if (date >= startOfYesterday) {
        groups[1].conversations.push(conv)
      } else if (date >= startOf7DaysAgo) {
        groups[2].conversations.push(conv)
      } else if (date >= startOf14DaysAgo) {
        groups[3].conversations.push(conv)
      } else if (date >= startOf30DaysAgo) {
        groups[4].conversations.push(conv)
      } else {
        groups[5].conversations.push(conv)
      }
    }

    return groups.filter(g => g.conversations.length > 0)
  }, [unpinnedConversations])

  return (
    <Sidebar collapsible="icon" className="border-r" role="navigation" aria-label="Conversations">
      <SidebarHeader>
        {/* Stacks in icon mode rather than hiding either control: the trigger is
            the ONLY way to re-expand a collapsed sidebar, so it must always
            stay reachable. */}
        <div className="flex w-full items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col-reverse group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* Explicit way back to the cockpit. Master Data Load is entered
                from there, so a user part-way through a loader session needs an
                obvious exit that is not the browser back button. */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => router.push("/home")}
              aria-label="Back to FabOrchestrator overview"
              title="Back to overview"
              className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <NavSvg><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></NavSvg>
            </Button>
            <div className="flex flex-col group-data-[collapsible=icon]:hidden">
              <span className="truncate text-[16.5px] font-bold tracking-[-0.2px]">
                FabOrchestrator<span style={{ color: "var(--chat-brand-blue)" }}>.ai</span>
              </span>
            </div>
          </div>
          <SidebarTrigger className="size-8 shrink-0 border-0 bg-transparent shadow-none hover:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="gap-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="New chat" onClick={onNewChat}>
                <NavSvg><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></NavSvg>
                <span>New chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Projects">
                <NavSvg><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></NavSvg>
                <span>Projects</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {/* Static workspace nav — non-functional links matching cockpit nav. */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs group-data-[collapsible=icon]:hidden">
            Workspace
          </SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="FO Overview" onClick={() => router.push("/home")}>
                <NavSvg><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></NavSvg>
                <span>FO Overview</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Agents">
                <NavSvg><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></NavSvg>
                <span>Agents</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Workflows">
                <NavSvg><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="12" r="2.4"/><path d="M8.4 6H13a3 3 0 0 1 3 3v.6"/><path d="M8.4 18H13a3 3 0 0 0 3-3v-.6"/></NavSvg>
                <span>Workflows</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Dashboard" onClick={() => router.push("/reports")}>
                <NavSvg><line x1="6" y1="20" x2="6" y2="13"/><line x1="12" y1="20" x2="12" y2="8"/><line x1="18" y1="20" x2="18" y2="11"/></NavSvg>
                <span>Dashboard</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {/* Static enterprise nav — non-functional links. */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs group-data-[collapsible=icon]:hidden">
            Enterprise
          </SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Sites">
                <NavSvg><path d="M4 21V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15"/><path d="M15 9h4a1 1 0 0 1 1 1v11"/><line x1="7" y1="9" x2="11" y2="9"/><line x1="7" y1="13" x2="11" y2="13"/><line x1="7" y1="17" x2="11" y2="17"/></NavSvg>
                <span>Sites</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Integrations">
                <NavSvg><path d="M9 3v6M15 3v6"/><path d="M7 9h10v3a5 5 0 0 1-10 0z"/><path d="M12 17v4"/></NavSvg>
                <span>Integrations</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Compliance">
                <NavSvg><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></NavSvg>
                <span>Compliance</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Settings">
                <NavSvg><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></NavSvg>
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {/* Pinned Conversations */}
        {pinnedConversations.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-xs group-data-[collapsible=icon]:hidden">
              Pinned
            </SidebarGroupLabel>
            <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Pinned">
                  <Pin className="size-4" />
                  <span>Pinned</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <SidebarMenu className="group-data-[collapsible=icon]:hidden">
              {pinnedConversations.map((conversation) => (
                <SidebarMenuItem key={conversation.id} className="group/item">
                  <SidebarMenuButton
                    isActive={conversation.id === selectedId}
                    onClick={() => onSelectConversation(conversation.id)}
                    className="pr-8"
                  >
                    <Pin className="size-3 text-muted-foreground" />
                    <span className="truncate">{conversation.title}</span>
                  </SidebarMenuButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-1/2 size-6 -translate-y-1/2 opacity-0 transition-opacity group-hover/item:opacity-100 data-[state=open]:opacity-100"
                      >
                        <MoreHorizontal className="size-4" />
                        <span className="sr-only">More options</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem onClick={() => onPinConversation(conversation.id, false)}>
                        <PinOff className="mr-2 size-4" />
                        <span>Unpin</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onShareConversation(conversation.id)}>
                        <Share2 className="mr-2 size-4" />
                        <span>Share</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => onDeleteConversation(conversation.id)}
                      >
                        <Trash className="mr-2 size-4" />
                        <span>Delete</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}

        {/* Recent Conversations - grouped by time period */}
        {/* Single Recents icon shown only when collapsed */}
        <SidebarGroup className="hidden group-data-[collapsible=icon]:flex">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Chat history">
                <NavSvg><path d="M21 11.5a8.5 8.5 0 1 1-3.2-6.6"/><path d="M21 4v4h-4"/><path d="M12 8v4l2.5 1.5"/></NavSvg>
                <span>Chat history</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {/* Time-grouped chat history shown only when expanded */}
        <div className="group-data-[collapsible=icon]:hidden">
          {unpinnedConversations.length === 0 ? (
            <SidebarGroup>
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                No conversations yet
              </div>
            </SidebarGroup>
          ) : (
            groupedConversations.map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel className="text-xs">
                  {group.label}
                </SidebarGroupLabel>
                <SidebarMenu>
                  {group.conversations.map((conversation) => (
                    <SidebarMenuItem key={conversation.id} className="group/item">
                      <SidebarMenuButton
                        isActive={conversation.id === selectedId}
                        onClick={() => onSelectConversation(conversation.id)}
                        className="pr-8"
                      >
                        <span className="truncate">{conversation.title}</span>
                      </SidebarMenuButton>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute right-1 top-1/2 size-6 -translate-y-1/2 opacity-0 transition-opacity group-hover/item:opacity-100 data-[state=open]:opacity-100"
                          >
                            <MoreHorizontal className="size-4" />
                            <span className="sr-only">More options</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem onClick={() => onPinConversation(conversation.id, true)}>
                            <Pin className="mr-2 size-4" />
                            <span>Pin</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onShareConversation(conversation.id)}>
                            <Share2 className="mr-2 size-4" />
                            <span>Share</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => onDeleteConversation(conversation.id)}
                          >
                            <Trash className="mr-2 size-4" />
                            <span>Delete</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            ))
          )}
        </div>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  tooltip="Account"
                >
                  <span
                    className="flex !h-[30px] !w-[30px] shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white"
                    style={{ background: "linear-gradient(135deg,var(--chat-brand-blue),var(--chat-avatar-blue))" }}
                  >
                    {userName.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate text-[13px] font-semibold">{userName}</span>
                  <ChevronUp className="ml-auto size-4" style={{ color: "var(--chat-chevron)" }} />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                className="w-[220px] p-1"
              >
                {/* User info header */}
                <div className="px-3 py-2.5">
                  <p className="text-sm font-medium text-foreground">{userName}</p>
                  <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onOpenSettings} className="gap-2.5 px-3 py-2">
                  <Settings className="size-4 text-muted-foreground" />
                  <span>Settings</span>
                </DropdownMenuItem>
                {isAdmin && (
                  <DropdownMenuItem onClick={() => router.push("/admin")} className="gap-2.5 px-3 py-2">
                    <Shield className="size-4 text-muted-foreground" />
                    <span>Admin Console</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={handleSignOut} className="gap-2.5 px-3 py-2">
                  <LogOut className="size-4 text-muted-foreground" />
                  <span>Log out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

function ChatContent({
  conversationId,
  selectedModel,
  setSelectedModel,
  onConversationCreated,
  onConversationEmptied,
  userName,
  onOpenMcpSettings,
  allowedModels,
}: {
  conversationId: string | null
  selectedModel: ClaudeModelId
  setSelectedModel: (model: ClaudeModelId) => void
  onConversationCreated: (id: string) => void
  onConversationEmptied: (id: string) => void
  userName: string
  onOpenMcpSettings: () => void
  allowedModels: typeof CLAUDE_MODELS
}) {
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [thinkingEnabled, setThinkingEnabled] = useState(false)
  const [activeMcpIds, setActiveMcpIds] = useState<string[]>([])
  const mcpLoadedRef = useRef(false) // Track if MCP connections have been loaded

  // Load connected MCP connections and enable them by default
  useEffect(() => {
    if (mcpLoadedRef.current) return
    mcpLoadedRef.current = true

    const loadConnectedMcps = async () => {
      try {
        const res = await fetch("/api/mcp/connections?agent=coding-agent", {
          headers: getAuthHeaders(),
        })
        if (res.ok) {
          const connections = await res.json()
          // Enable all connected MCPs by default
          const connectedIds = connections
            .filter((c: { status: string }) => c.status === "connected")
            .map((c: { id: string }) => c.id)
          if (connectedIds.length > 0) {
            setActiveMcpIds(connectedIds)
          }
        }
      } catch {
        // Silently fail - MCP connections are optional
      }
    }
    loadConnectedMcps()
  }, [])

  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([])
  const [isLoadingMessages, setIsLoadingMessages] = useState(!!conversationId)
  const [input, setInput] = useState("")
  const chatInputRef = useRef<ClaudeChatInputHandle>(null)
  const pendingMessageRef = useRef<{ text: string; messageId: string; files?: Array<{ type: 'file'; mediaType: string; url: string; filename?: string }> } | null>(null)
  const currentConversationRef = useRef<string | null>(null)
  const isNewConversationRef = useRef(false) // Track if we just created a new conversation
  const optimisticMessageCounterRef = useRef(0)

  // File content loading hook
  const { fetchFileContent, fetchFileArrayBuffer, getCache: getFileContentCache } = useFileContent()

  // Artifact state - use refs to prevent re-render loops
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null)
  const [allArtifacts, setAllArtifacts] = useState<Artifact[]>([])
  const [activeArtifactIndex, setActiveArtifactIndex] = useState(0)
  const [showArtifactPreview, setShowArtifactPreview] = useState(false)
  const [artifactPanelMounted, setArtifactPanelMounted] = useState(false)

  /* ---- the work product: the PRD and the mock screen -------------------
   *
   * Read from the server after every completed turn rather than parsed out of
   * the transcript: the PRD on disk is the one the tools wrote and the one the
   * download is built from, so reconstructing it from chat text would let the
   * panel and the artifacts disagree. */
  const [work, setWork] = useState<{
    prd: string | null
    previewHtml: string | null
    hasArtifact: boolean
    /** the page the unit was built for */
    page: string | null
    /** what the archive contains — the same list the download builds from */
    unit: Array<{ name: string; chars: number }>
    /** the requirement document's file name, for the panel's subtitle */
    document: string | null
    /** the validator's verdict, when a page has been generated */
    verdict: { PASS: number; WARN: number; FAIL: number } | null
    /** the spec has moved past the artifact, so the screen is the older thing */
    specNewerThanArtifact: boolean
    /** what a deterministic pass over the document could and could not settle */
    prevalidation: PreValidationReport | null
    prevalidationError: string | null
    /**
     * The pass is in flight.
     *
     * Carried separately from `prevalidation === null` because the two mean
     * different things: null-and-running is "wait", null-and-not-running is
     * "there is nothing here". Without the distinction the panel cannot tell a
     * reader which one they are looking at, and silence reads as the second.
     */
    prevalidationRunning: boolean
  }>({
    prd: null, previewHtml: null, hasArtifact: false, page: null, unit: [],
    document: null, verdict: null, specNewerThanArtifact: false,
    prevalidation: null, prevalidationError: null, prevalidationRunning: false,
  })
  const [workTab, setWorkTab] = useState<PanelTab>("prd")

  /*
   * POLL FOR THE PRE-VALIDATION REPORT.
   *
   * It needs one model call, so it lands a few seconds after the upload rather
   * than with it. Polling rather than streaming because the whole thing is a
   * single result: there is nothing to show progressively, and a socket for one
   * JSON object is machinery nobody needs to maintain.
   *
   * Bounded. A run that never finishes must stop asking rather than poll for the
   * life of the tab — and the route itself reports its own failures, so an
   * unbounded loop could only be waiting on something already broken.
   */
  /*
   * THE WAIT IS CANCELLABLE, because the composer offers to cancel it.
   *
   * While pre-validation runs the input shows the stop control, and a stop
   * control that does nothing is worse than none. `stop()` from `useChat` only
   * ends a model stream; this ends the polling. The extraction itself is
   * fire-and-forget on the server and finishes regardless — its result is
   * written to disk and picked up on the next load of the conversation, so
   * cancelling costs the reader nothing but the wait.
   */
  const prevalidationTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevalidationCancelled = useRef(false)

  const stopWaitingForPreValidation = useCallback(() => {
    prevalidationCancelled.current = true
    if (prevalidationTimer.current) clearTimeout(prevalidationTimer.current)
    prevalidationTimer.current = null
    setWork((prev) => (prev.prevalidationRunning ? { ...prev, prevalidationRunning: false } : prev))
  }, [])

  const pollPreValidation = useCallback((convId: string) => {
    prevalidationCancelled.current = false
    if (prevalidationTimer.current) clearTimeout(prevalidationTimer.current)
    setWork((prev) => ({
      ...prev, prevalidationRunning: true, prevalidation: null, prevalidationError: null,
    }))
    let tries = 0
    const tick = async () => {
      if (prevalidationCancelled.current) return
      tries += 1
      try {
        const res = await fetch(
          `/api/backend-agent/prevalidation?conversationId=${encodeURIComponent(convId)}`,
          { headers: getAuthOnlyHeaders() },
        )
        const data = await res.json()
        if (data?.status === "done") {
          setWork((prev) => ({
            ...prev, prevalidation: data.report,
            prevalidationError: null, prevalidationRunning: false,
          }))
          return
        }
        if (data?.status === "failed") {
          setWork((prev) => ({
            ...prev, prevalidation: null,
            prevalidationError: String(data.reason ?? "unknown"), prevalidationRunning: false,
          }))
          return
        }
      } catch {
        /* a failed poll is not a failed run; try again until the cap */
      }
      if (prevalidationCancelled.current) return
      /* The cap is what guarantees the composer cannot be locked for ever: on
         the last try this clears `prevalidationRunning` whatever happened. */
      if (tries < 40) prevalidationTimer.current = setTimeout(tick, 3000)
      else setWork((prev) => ({
        ...prev,
        prevalidationError: "it did not finish within two minutes",
        prevalidationRunning: false,
      }))
    }
    prevalidationTimer.current = setTimeout(tick, 1500)
  }, [])
  /* The artifact currently being read in the panel. Held here rather than in the
     panel so that clicking a card in the TRANSCRIPT is what opens it — the panel
     is a viewer, and the conversation is where the artifacts are. */
  const [openFile, setOpenFile] = useState<OpenFile | null>(null)
  /* The produced files, by name. Read once when a run finishes so the tiles can
     offer a working download rather than an empty one. */
  const [unitFiles, setUnitFiles] = useState<Record<string, string>>({})
  /* The panel is dismissible and re-openable. Closing is a reading decision, not
     a discard: the documents stay on disk and the deployment-unit card in the
     transcript puts the panel back. */
  const [workPanelOpen, setWorkPanelOpen] = useState(true)
  /* A send has been pressed and has not yet reached the message list. On a plain
     message that is one tick; with a document it is two network round trips. */
  const [sendInFlight, setSendInFlight] = useState(false)
  const [workExpanded, setWorkExpanded] = useState(false)
  const [panelResizeTransition, setPanelResizeTransition] = useState(false)
  const userClosedArtifactRef = useRef<boolean>(false) // Track if user manually closed
  const lastDetectedArtifactIdRef = useRef<string | null>(null) // Track last detected artifact to prevent re-opening
  const showArtifactPreviewRef = useRef<boolean>(false) // Ref version to avoid callback recreation
  const artifactMessageIdRef = useRef<string | null>(null) // Track which message owns the current artifacts

  // Memoization cache for artifact extraction — avoids re-parsing same text in render loop
  const artifactParseCache = useRef<Map<string, { segments: ReturnType<typeof segmentMessageText>; cleaned: string }>>(new Map())
  const manuallySelectedArtifactRef = useRef<boolean>(false) // Track if artifact was manually clicked (not auto-detected)
  const isLoadedConversationRef = useRef<boolean>(!!conversationId) // Track if messages came from loading a saved conversation
  const [modelJustChanged, setModelJustChanged] = useState(false)
  type TransitionPhase = 'idle' | 'exiting-welcome' | 'entering-chat'
  const [transitionPhase, setTransitionPhase] = useState<TransitionPhase>('idle')
  const prevModelRef = useRef<string>(selectedModel)

  // Keep ref in sync with state and manage panel mount lifecycle
  useEffect(() => {
    showArtifactPreviewRef.current = showArtifactPreview
    if (showArtifactPreview) {
      setArtifactPanelMounted(true)
    }
    // Enable smooth CSS transition on panels during open/close
    setPanelResizeTransition(true)
    const timer = setTimeout(() => setPanelResizeTransition(false), 350)
    return () => clearTimeout(timer)
  }, [showArtifactPreview])

  // Track model changes for SystemMessage notification
  useEffect(() => {
    if (prevModelRef.current !== selectedModel) {
      setModelJustChanged(true)
      prevModelRef.current = selectedModel
      // Auto-dismiss after 3 seconds
      const timer = setTimeout(() => setModelJustChanged(false), 3000)
      return () => clearTimeout(timer)
    }
  }, [selectedModel])

  // Suggestions replaced by inline welcome chips in the greeting state

  // Helper to extract reasoning parts from message
  // AI SDK sends reasoning with { type: 'reasoning', text: '...' }
  const getReasoningParts = (message: UIMessage): string[] => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts
      .filter((part) => part.type === "reasoning")
      .map((part) => {
        // AI SDK uses 'text' property for reasoning content
        if ("text" in part && part.text) return part.text as string
        // Fallback for 'reasoning' property (legacy)
        if ("reasoning" in part && part.reasoning) return part.reasoning as string
        return ""
      })
      .filter(Boolean)
  }

  // Extract file artifacts from message parts (file-download and data-fileDownload)
  const getFileArtifactsFromMessage = useCallback((message: UIMessage): Artifact[] => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    const fileArtifacts: Artifact[] = []

    for (const part of parts) {
      if (typeof part !== 'object' || part === null) continue
      const p = part as Record<string, unknown>
      const partType = p.type as string

      let fileData: { fileId: string; filename: string; mimeType?: string; sizeBytes?: number } | null = null

      if (partType === 'file-download') {
        fileData = {
          fileId: p.fileId as string,
          filename: p.filename as string || 'download',
          mimeType: p.mimeType as string | undefined,
          sizeBytes: p.sizeBytes as number | undefined,
        }
      } else if (partType === 'data-fileDownload') {
        const data = p.data as Record<string, unknown> | undefined
        if (data) {
          fileData = {
            fileId: data.fileId as string,
            filename: data.filename as string || 'download',
            mimeType: data.mimeType as string | undefined,
            sizeBytes: data.sizeBytes as number | undefined,
          }
        }
      }

      if (fileData?.fileId && isPreviewableFile(fileData.filename, fileData.mimeType)) {
        fileArtifacts.push(createFileArtifact(fileData))
      }
    }

    return fileArtifacts
  }, [])

  // Extract tag artifacts from message text parts
  const getTagArtifactsFromMessage = useCallback((message: UIMessage): { artifacts: Artifact[]; hasStreamingArtifact: boolean } => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    const rawText = parts
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join("")
    if (!rawText.includes('<antArtifact')) return { artifacts: [], hasStreamingArtifact: false }
    const result = extractTagArtifacts(rawText)
    return { artifacts: result.artifacts, hasStreamingArtifact: result.hasStreamingArtifact }
  }, [])

  // Streaming state for artifact panel
  const [isArtifactStreaming, setIsArtifactStreaming] = useState(false)

  // Sidebar control for artifact panel
  const { setOpen: setSidebarOpen } = useSidebar()
  const sidebarStateBeforeArtifact = useRef<boolean>(true)

  // Open artifact and collapse sidebar - memoized to prevent re-renders
  // Uses refs instead of state in dependencies to prevent recreation and infinite loops
  // manualSelection: true when user clicks an artifact tile (not auto-detected during streaming)
  /* A plain anchor cannot carry a bearer token, so the unit is fetched and handed
     to the browser as a blob. */
  const downloadUnit = useCallback(async (id: string | null) => {
    if (!id) return
    const res = await fetch(`/api/backend-agent/download?conversationId=${id}`, {
      headers: getAuthHeaders(),
    })
    if (!res.ok) return
    const blob = await res.blob()
    const name =
      /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ??
      "deployment-unit.zip"
    const url = URL.createObjectURL(blob)
    const a = window.document.createElement("a")
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  /* Fetch one artifact and show it. Served from the deployment unit, so the panel
     can only ever display something that is genuinely part of the deliverable. */
  const openArtifact = useCallback(async (name: string) => {
    setOpenFile({ name, language: "text", content: "", loading: true })
    setWorkTab("code")
    setWorkPanelOpen(true)
    if (!conversationId) return
    try {
      const res = await fetch(
        `/api/backend-agent/file?conversationId=${conversationId}&name=${encodeURIComponent(name)}`,
        { headers: getAuthHeaders(), cache: "no-store" },
      )
      const data = await res.json()
      if (!res.ok) {
        setOpenFile({ name, language: "text", content: "", error: data?.error ?? "Could not open that file." })
        return
      }
      setOpenFile({ name: data.name, language: data.language, content: data.content })
    } catch {
      setOpenFile({ name, language: "text", content: "", error: "Could not open that file." })
    }
  }, [conversationId])

  /* The PRD as a Word document. Built on the server from the same markdown the
     panel renders, then handed over as a blob — the route needs the bearer
     token, so it cannot simply be an `href`. */
  const downloadPrdDocx = useCallback(async () => {
    if (!conversationId) return
    try {
      const res = await fetch(
        `/api/backend-agent/prd/docx?conversationId=${conversationId}`,
        { headers: getAuthHeaders(), cache: "no-store" },
      )
      if (!res.ok) return
      const blob = await res.blob()
      const cd = res.headers.get("Content-Disposition") ?? ""
      const named = /filename="([^"]+)"/.exec(cd)?.[1] ?? "PRD.docx"
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = named
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* a failed download must never break the conversation */
    }
  }, [conversationId])

  const refreshWork = useCallback(async () => {
    if (!conversationId) return
    try {
      const res = await fetch(`/api/backend-agent/prd?conversationId=${conversationId}`, {
        headers: getAuthHeaders(),
        cache: "no-store",
      })
      if (!res.ok) return
      const data = await res.json()

      /* The screen is FETCHED, not loaded by the iframe itself: an `<iframe src>`
         issues its own request and cannot carry the bearer token, so the route
         answered it with a session error and the panel showed a raw JSON object. */
      let previewHtml: string | null = null
      if (data.prd || data.hasArtifact) {
        const shot = await fetch(`/api/backend-agent/preview?conversationId=${conversationId}`, {
          headers: getAuthHeaders(),
          cache: "no-store",
        })
        if (shot.ok) previewHtml = await shot.text()
      }
      /* A turn that produces something new re-opens the panel: the reader closed
         the PREVIOUS document, not this one, and silently withholding a fresh
         PRD because of a dismissal two turns ago reads as the tool failing. */
      setWork((prev) => {
        const grew =
          (data.prd ?? null) !== prev.prd || Boolean(data.hasArtifact) !== prev.hasArtifact
        if (grew) setWorkPanelOpen(true)
        return prev
      })
      /* Contents for the tiles. Fired and forgotten: a tile whose body has not
         arrived yet still opens in the panel, which fetches on demand. */
      if (Array.isArray(data.unit) && data.unit.length) {
        void (async () => {
          const got: Record<string, string> = {}
          await Promise.all(
            (data.unit as Array<{ name: string }>).map(async (f) => {
              try {
                const r = await fetch(
                  `/api/backend-agent/file?conversationId=${conversationId}&name=${encodeURIComponent(f.name)}`,
                  { headers: getAuthHeaders(), cache: "no-store" },
                )
                if (!r.ok) return
                const d = await r.json()
                if (typeof d?.content === "string") got[f.name] = d.content
              } catch {
                /* a tile without its body still opens; it just cannot download */
              }
            }),
          )
          setUnitFiles(got)
        })()
      }

      setWork((prev) => ({
        prd: data.prd ?? null,
        previewHtml,
        hasArtifact: Boolean(data.hasArtifact),
        page: data.page ?? null,
        unit: Array.isArray(data.unit) ? data.unit : [],
        document: data.document ?? null,
        verdict: data.verdict ?? null,
        specNewerThanArtifact: Boolean(data.specNewerThanArtifact),
        /* Carried forward rather than re-read: this refresh is the STATE route,
           which knows nothing about pre-validation. Spreading `null` here would
           blank the Report tab every time the panel refreshed. */
        prevalidation: prev.prevalidation,
        prevalidationError: prev.prevalidationError,
        prevalidationRunning: prev.prevalidationRunning,
      }))
    } catch {
      /* the panel is a convenience; a failed refresh must never break the chat */
    }
  }, [conversationId])

  const openArtifactPanel = useCallback((artifact: Artifact, artifacts: Artifact[] = [], _streaming: boolean = false, manualSelection: boolean = false) => {
    // Check if this artifact was already opened (to prevent infinite loops)
    // Use ref version of showArtifactPreview to avoid dependency
    if (artifact.id === lastDetectedArtifactIdRef.current && showArtifactPreviewRef.current && !manualSelection) {
      // Just update the content without re-triggering
      setActiveArtifact(artifact)
      setAllArtifacts(artifacts.length > 0 ? artifacts : [artifact])
      setActiveArtifactIndex(artifacts.length > 0 ? artifacts.indexOf(artifact) : 0)
  
      return
    }

    // Track if this was a manual selection (prevents auto-detection from overwriting)
    manuallySelectedArtifactRef.current = manualSelection

    lastDetectedArtifactIdRef.current = artifact.id
    sidebarStateBeforeArtifact.current = true // Save current state (assume open)
    setSidebarOpen(false) // Collapse sidebar
    setActiveArtifact(artifact)
    setAllArtifacts(artifacts.length > 0 ? artifacts : [artifact])
    setActiveArtifactIndex(artifacts.length > 0 ? artifacts.indexOf(artifact) : 0)
    setShowArtifactPreview(true)

    userClosedArtifactRef.current = false // Reset the manual close flag
  }, [setSidebarOpen]) // Removed showArtifactPreview - using ref instead

  // Navigate between artifacts
  const navigateArtifact = useCallback((index: number) => {
    if (index >= 0 && index < allArtifacts.length) {
      setActiveArtifactIndex(index)
      setActiveArtifact(allArtifacts[index])
    }
  }, [allArtifacts])

  // Called when exit animation finishes - safe to fully unmount the panel
  const handleArtifactExitComplete = useCallback(() => {
    setArtifactPanelMounted(false)
    setActiveArtifact(null)
  }, [])

  // Close artifact and restore sidebar
  const closeArtifactPanel = useCallback(() => {
    userClosedArtifactRef.current = true // Mark as manually closed by user
    lastDetectedArtifactIdRef.current = null // Reset tracking
    manuallySelectedArtifactRef.current = false // Reset manual selection flag
    setShowArtifactPreview(false)
    // Don't null activeArtifact here — let exit animation play first, then handleArtifactExitComplete cleans up

    setSidebarOpen(true) // Expand sidebar
  }, [setSidebarOpen])

  // API endpoint
  const apiEndpoint = "/api/backend-agent/chat"

  // Create request body - this will be sent with each chat request
  const requestBody = useMemo(() => ({
    model: selectedModel,
    webSearch: webSearchEnabled,
    enableReasoning: thinkingEnabled,
    conversationId,
    activeMcpIds,
    // Which CMF database this turn reads from / writes to (see CmfDatabaseToggle).
  }), [selectedModel, webSearchEnabled, thinkingEnabled, conversationId, activeMcpIds])

  // Create transport with memoized configuration - includes auth headers
  const transport = useMemo(() => new DefaultChatTransport({
    api: apiEndpoint,
    body: requestBody,
    headers: getAuthHeaders(),
  }), [apiEndpoint, requestBody])

  const {
    messages,
    status,
    stop,
    setMessages,
    sendMessage,
    error,
  } = useChat({
    transport,
    // UUIDs, so a message's id here is the id the server saves it under.
    generateId: newMessageId,
    messages: initialMessages,
    experimental_throttle: 80,
    // Auto-scroll handled by use-stick-to-bottom
    onError: (err) => {
      console.error('[useChat] Error:', err)
    },
  })

  // Retry function - resends the last user message
  /* ────────────────────────────────────────────────────────────────────
   * MESSAGE ACTIONS — edit, delete, rate, view error log.
   *
   * These controls shipped with no handlers and no endpoints behind them.
   * The behaviour lives in MessageActionBar; these are the callbacks that
   * talk to the server and keep the local transcript honest.
   * ──────────────────────────────────────────────────────────────────── */
  /** Whether the signed-in user can open the admin console. Drives whether the
   *  "View error details" link is offered at all — a business user must never
   *  be sent to a page they cannot open. */
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    fetch("/api/user/models", { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsAdmin(Boolean(d?.isAdmin)))
      .catch(() => setIsAdmin(false))
  }, [])

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [feedbackById, setFeedbackById] = useState<Record<string, 'up' | 'down' | null>>({})

  const handleFeedback = useCallback(async (messageId: string, feedback: 'up' | 'down' | null) => {
    const value = feedback === 'up' ? 'positive' : feedback === 'down' ? 'negative' : null
    const res = await fetch('/api/messages/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ messageId, feedback: value }),
    })
    if (!res.ok) throw new Error(`Feedback failed (HTTP ${res.status})`)
    setFeedbackById((prev) => ({ ...prev, [messageId]: feedback }))
  }, [])

  /** Server also removes the reply a question produced; trim to exactly the
   *  ids it reports rather than guessing. */
  const handleDeleteMessage = useCallback(async (messageId: string) => {
    const res = await fetch(`/api/messages/${messageId}`, { method: 'DELETE', headers: getAuthHeaders() })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error?.message ?? body?.error ?? `Delete failed (HTTP ${res.status})`)
    }
    const { deleted, conversationId: convId, conversationDeleted } = (await res.json()) as {
      deleted: string[]
      conversationId?: string
      conversationDeleted?: boolean
    }
    const gone = new Set(deleted)
    setMessages((prev) => prev.filter((m) => !gone.has(m.id)))
    // That was the last message: the conversation is gone as well, so it
    // leaves the sidebar and a fresh chat opens in its place.
    if (conversationDeleted && convId) {
      // (The action bar already confirms the delete; one notice is enough.)
      onConversationEmptied(convId)
    }
  }, [setMessages, onConversationEmptied])

  /** Saving an edit drops everything after it — those answers replied to text
   *  that no longer exists — then re-runs from the corrected question. */
  const handleSaveEdit = useCallback(async (messageId: string, text: string) => {
    setEditBusy(true)
    try {
      const res = await fetch(`/api/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ content: text }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error?.message ?? `Could not save the edit (HTTP ${res.status})`)
      }
      let files: FilePart[] = []
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId)
        if (idx === -1) return prev
        files = fileParts(prev[idx])
        const kept = prev.slice(0, idx + 1)
        kept[idx] = { ...kept[idx], parts: [...files, { type: 'text', text }] } as typeof kept[number]
        return kept
      })
      setEditingMessageId(null)
      // Re-run FROM the edited message (same id) — not a new copy of it.
      sendMessage({ text, files, messageId })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the edit.')
    } finally {
      setEditBusy(false)
    }
  }, [setMessages, sendMessage])

  /** The errorId for a failed turn, read from the streamed capture. */
  const errorIdFromMessage = useCallback((m: { parts?: unknown }): string | null => {
    return visibleErrorDetails(m.parts, isAdmin)[0]?.errorId ?? null
  }, [isAdmin])

  const retryLastMessage = useCallback(() => {
    // One message is enough: a turn that failed on the FIRST question leaves
    // only that question, and Retry used to do nothing there.
    if (messages.length < 1) return
    isLoadedConversationRef.current = false
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (lastUserMsg) {
      const text = lastUserMsg.parts
        .filter(p => p.type === 'text')
        .map(p => ('text' in p ? p.text : ''))
        .join('')
      if (text) {
        // Resend UNDER THE SAME ID: the SDK replaces that message and drops
        // what followed; the server keeps the stored question and clears the
        // old replies (prepareResend). Sending without the id appended a
        // second copy of the question.
        sendMessage({ text, files: fileParts(lastUserMsg), messageId: lastUserMsg.id }, { body: requestBody })
      }
    }
  }, [messages, sendMessage, requestBody])

  // Auto-generate conversation title after first exchange
  // Copy last response to clipboard
  const copyLastResponse = useCallback(() => {
    const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant')
    if (lastAssistantMsg) {
      const text = getMessageText(lastAssistantMsg)
      navigator.clipboard.writeText(text)
    }
    // getMessageText is a stable helper; intentionally keyed on messages only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  // Save feedback to API
  const saveFeedback = useCallback(async (messageId: string, feedback: 'positive' | 'negative', comment?: string) => {
    try {
      await fetch('/api/messages/feedback', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ messageId, feedback, comment }),
      })
    } catch (error) {
      console.error('Failed to save feedback:', error)
    }
  }, [])

  // Keyboard shortcuts - must be after all callbacks are defined
  useKeyboardShortcuts({
    shortcuts: [
      {
        ...CHAT_SHORTCUTS.clearInput,
        action: () => {
          if (showArtifactPreview) {
            closeArtifactPanel()
          } else {
            setInput("")

          }
        },
      },
      {
        ...CHAT_SHORTCUTS.copyLastResponse,
        action: copyLastResponse,
      },
      {
        ...CHAT_SHORTCUTS.regenerate,
        action: retryLastMessage,
      },
    ],
  })

  // Helper to check if should show feedback bar (every 3rd assistant message, only if no user reply after it)
  const shouldShowFeedbackBar = useCallback((messageIndex: number, role: string): boolean => {
    if (role !== "assistant") return false
    // Hide if user has already sent a follow-up message after this one
    const hasUserReplyAfter = messages.slice(messageIndex + 1).some(m => m.role === "user")
    if (hasUserReplyAfter) return false
    const assistantCount = messages
      .slice(0, messageIndex + 1)
      .filter(m => m.role === "assistant")
      .length
    return assistantCount > 0 && assistantCount % 3 === 0
  }, [messages])

  /* The newest `data-progress` line on the last assistant message. Read from
     the live messages rather than kept in state, so it clears by itself when the
     turn ends and never becomes part of the saved transcript. */
  /*
   * MEASURE THE TRANSCRIPT'S SCROLLBAR AND PUBLISH IT AS `--po-sbw`.
   *
   * The transcript scrolls and the composer does not, so a classic scrollbar
   * takes ~21px from inside the scroll container and nothing from the composer.
   * Both columns are `mx-auto`, so they centre inside DIFFERENT widths and the
   * composer ends up ~10px left of the replies above it — the misalignment is
   * the scrollbar, not the padding.
   *
   * READ, NEVER ASSUMED. Scrollbar width is a platform fact: 15px on some
   * Windows themes, 17 on others, 0 wherever scrollbars overlay content, as on
   * macOS by default and on every touch device. Hardcoding one number misaligns
   * the column everywhere it is not that number — including by the full width on
   * every machine where it is 0.
   */
  useEffect(() => {
    const measure = () => {
      /* FOUND BY ITS BEHAVIOUR, NOT BY A CLASS NAME. `ChatContainerRoot` nests
         several divs and the one that actually reserves the gutter carries no
         class of its own — the first selector tried matched the wrapper ABOVE it,
         measured 0, and corrected nothing. So: start at a transcript column and
         walk up to the first ancestor that is narrower inside than out. That
         holds whichever div in the stack owns the scrolling. */
      const column = document.querySelector<HTMLElement>(".max-w-3xl.px-6")
      let el: HTMLElement | null = column
      let reserved = 0
      while (el && reserved === 0) {
        reserved = el.offsetWidth - el.clientWidth
        el = el.parentElement
      }
      /* `scrollbar-gutter: stable both-edges` reserves the space SYMMETRICALLY,
         so the transcript is inset by half on each side — which is why the
         composer was out by ~10px and not by the full ~21. */
      document.documentElement.style.setProperty(
        "--po-sbw",
        `${reserved > 0 ? reserved / 2 : 0}px`,
      )
    }
    measure()
    /* A window moved between displays can change it, and so can a zoom change or
       the work panel opening beside the transcript. */
    window.addEventListener("resize", measure)
    const t = setInterval(measure, 1000)
    return () => { window.removeEventListener("resize", measure); clearInterval(t) }
  }, [])

  /* The waiting ladder the server chose for this turn. Read from the same parts
     stream as the progress line, so it arrives with the turn it describes and
     needs no separate request. */
  const waitPhase = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "assistant") continue
      const parts = (m.parts ?? []) as Array<{ type?: string; data?: { phase?: unknown } }>
      for (let j = parts.length - 1; j >= 0; j--) {
        if (parts[j]?.type === "data-phase" && isWaitPhase(parts[j]?.data?.phase)) {
          return parts[j]!.data!.phase as WaitPhase
        }
      }
      break
    }
    return undefined
  })()

  /* Is a TOOL currently running? FabOrchestrator draws its own card for a
     running tool, with the tool's name and its own clock. The wait ladder exists
     for the window BEFORE that — the model's thinking time, which is the part
     with nothing to look at — so the two are made exclusive. Stacked, they read
     as two separate things happening at once. */
  const toolRunning = (() => {
    if (!isLoadingStatus(status)) return false
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "assistant") continue
      const parts = (m.parts ?? []) as Array<{ type?: string; state?: string }>
      return parts.some(
        (p) =>
          typeof p?.type === "string" &&
          p.type.startsWith("tool-") &&
          p.state !== "output-available" &&
          p.state !== "output-error",
      )
    }
    return false
  })()

  const progressLine = (() => {
    if (!isLoadingStatus(status)) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "assistant") continue
      const parts = (m.parts ?? []) as Array<{ type?: string; data?: { line?: string } }>
      for (let j = parts.length - 1; j >= 0; j--) {
        if (parts[j]?.type === "data-progress" && parts[j]?.data?.line) {
          return parts[j]!.data!.line as string
        }
      }
      break
    }
    return null
  })()

  /* The artifact as it is written, accumulated per page from the streamed
     deltas, plus the files that have landed on disk. Derived from the live
     messages rather than held in state, so it clears itself when the turn ends
     and never becomes part of the saved transcript.

     A REWRITE REPLACES; IT DOES NOT APPEND.
       The generator may write the page more than once — validation can reject
       the first pass and it is asked again. Every delta carries the `attempt`
       that produced it, and the server has always sent it, but this reader
       ignored it and concatenated the lot: attempt 2 was glued onto attempt 1's
       ABANDONED output, so the panel showed two documents spliced together and
       a character count climbing past twice the real size. That is what a
       routine second pass looked like from the outside, and it read as the
       application breaking.

       So a change of attempt for a page clears what that page had. The first
       delta defaults to its own attempt, which makes the common case — one
       attempt — a no-op. */
  const streaming = (() => {
    const code = new Map<string, string>()
    const attemptOf = new Map<string, number>()
    /* Pages currently on their second or later pass, so the caption can say the
       page is being written again rather than leaving the reader to guess why
       it restarted. */
    const rewriting = new Set<string>()
    const files: Array<{ name: string; chars: number }> = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "assistant") continue
      const parts = (m.parts ?? []) as Array<{ type?: string; data?: Record<string, unknown> }>
      for (const p of parts) {
        if (p?.type === "data-artifactCode" && p.data) {
          const page = String(p.data.page ?? "artifact")
          const attempt = Number(p.data.attempt ?? 1)
          if ((attemptOf.get(page) ?? attempt) !== attempt) code.set(page, "")
          attemptOf.set(page, attempt)
          if (attempt > 1) rewriting.add(page)
          code.set(page, (code.get(page) ?? "") + String(p.data.delta ?? ""))
        } else if (p?.type === "data-artifactFile" && p.data) {
          files.push({ name: String(p.data.name ?? ""), chars: Number(p.data.chars ?? 0) })
        }
      }
      break
    }
    return { code, files, rewriting }
  })()

  const isLoading = status === "submitted" || status === "streaming"

  /* Has the assistant put anything on screen for this turn — any text, or any
     tool? Until it has, the reader is looking at a page that has not changed
     since they pressed send. */
  const assistantSilent = (() => {
    /* True during the upload too: the SDK is not loading yet, but the assistant
       has certainly not said anything, and that window is the longest silence in
       the whole flow. */
    if (!isLoadingStatus(status)) return sendInFlight
    const last = messages[messages.length - 1]
    if (!last || last.role !== "assistant") return true
    const parts = (last.parts ?? []) as Array<{ type?: string; text?: string }>
    return !parts.some(
      (p) =>
        (p?.type === "text" && (p.text ?? "").trim().length > 0) ||
        (typeof p?.type === "string" && p.type.startsWith("tool-")),
    )
  })()

  /* A turn is the only thing that writes a PRD or an artifact, so the work
     product is re-read when one finishes — and once on entering a conversation
     that already has one, so re-opening it shows what is there. */
  useEffect(() => {
    if (status === "ready") void refreshWork()
  }, [status, refreshWork])

  /*
   * A REPORT THAT ALREADY EXISTS SURVIVES A RELOAD.
   *
   * The poller only runs after an upload, so reopening a conversation showed
   * nothing even though the report was sitting in the run directory. It is
   * written to disk precisely so it outlives the turn that produced it.
   *
   * A single fetch, not a poll: on entering a conversation the report either
   * exists or it does not. `running` is deliberately IGNORED here — treating it
   * as "in flight" would leave a conversation that never had a document showing
   * a spinner forever, and `readPreValidation` returns `running` for a missing
   * file as much as for an unfinished one.
   */
  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(
          `/api/backend-agent/prevalidation?conversationId=${encodeURIComponent(conversationId)}`,
          { headers: getAuthOnlyHeaders() },
        )
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        if (data?.status === "done") {
          setWork((prev) => ({
            ...prev, prevalidation: data.report,
            prevalidationError: null, prevalidationRunning: false,
          }))
        } else if (data?.status === "failed") {
          setWork((prev) => ({
            ...prev, prevalidation: null,
            prevalidationError: String(data.reason ?? "unknown"), prevalidationRunning: false,
          }))
        }
      } catch {
        /* the report is advisory; a failed read must never disturb the chat */
      }
    })()
    return () => { cancelled = true }
  }, [conversationId])


  /*
   * AND AGAIN THE MOMENT THE TOOL FINISHES, not only when the whole turn ends.
   *
   * `generate_artifact` returns and the model then writes several paragraphs
   * about what it built — a second or two during which the files exist on disk
   * and the transcript shows nothing. Watching the tool's own state closes that:
   * the artifacts appear as the sentence about them is still being written.
   */
  const finishedTools = messages
    .flatMap((m) => (m.parts ?? []) as Array<{ type?: string; state?: string }>)
    .filter((pt) => typeof pt?.type === "string"
      && /^tool-(generate_artifact|revise_artifact|write_prd|show_preview)/.test(pt.type)
      && pt.state === "output-available").length
  useEffect(() => {
    if (finishedTools > 0) void refreshWork()
  }, [finishedTools, refreshWork])

  /* Lowered once the message has landed or the turn has ended — including when a
     send fails, so a failed upload returns the welcome screen rather than
     leaving a blank page behind. */
  useEffect(() => {
    if (messages.length > 0 || status === "error") setSendInFlight(false)
  }, [messages.length, status])

  useEffect(() => {
    void refreshWork()
  }, [conversationId, refreshWork])
  /* `sendInFlight` is what carries the gap: with a document attached the message
     does not exist for a second or two, and without this the welcome screen is
     still the thing on screen for all of it. */
  const isWelcomeVisible =
    messages.length === 0 && !sendInFlight && transitionPhase === 'idle' && !isLoadingMessages

  // File-download parts are now delivered in-band via the SSE stream as data-fileDownload chunks.
  // The AI SDK automatically adds them to message.parts - no polling needed.

  // If we just created a conversation, send the pending message once the id is available
  useEffect(() => {
    if (!conversationId) return
    const pending = pendingMessageRef.current
    if (!pending) return

    // Clear the ref first to prevent double-sending
    pendingMessageRef.current = null

    // Small delay to ensure React state is fully updated and transport is recreated
    const timeoutId = setTimeout(() => {
      const payload: { text: string; messageId: string; files?: Array<{ type: 'file'; mediaType: string; url: string; filename?: string }> } = {
        text: pending.text,
        messageId: pending.messageId,
      }
      if (pending.files && pending.files.length > 0) {
        payload.files = pending.files
      }
      sendMessage(payload, { body: requestBody })
      // Clear the new conversation flag after message is sent
      isNewConversationRef.current = false
    }, 50)

    return () => clearTimeout(timeoutId)
  }, [conversationId, sendMessage, requestBody])

  // Load messages when conversation changes (only for existing conversations, not new ones)
  useEffect(() => {
    // Skip loading if this is a new conversation being created
    if (isNewConversationRef.current) {
      return
    }

    // Update the ref to track current conversation
    currentConversationRef.current = conversationId

    if (conversationId) {
      setIsLoadingMessages(true)

      const fetchMessages = async () => {
        try {
          const res = await fetch(`/api/conversations/${conversationId}`, {
            headers: getAuthHeaders(),
          })
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`)
          }
          const data = await res.json()

          // Check if we're still on the same conversation using the ref
          if (currentConversationRef.current !== conversationId) {
            return
          }

          if (data.messages && Array.isArray(data.messages) && data.messages.length > 0) {
            // API now returns UIMessage format directly - no transformation needed
            const loadedMessages: UIMessage[] = data.messages

            // Set both initial messages and current messages
            setInitialMessages(loadedMessages)
            // Use a timeout to ensure setMessages is called after any pending state updates
            setTimeout(() => {
              if (currentConversationRef.current === conversationId) {
                setMessages(loadedMessages)
                isLoadedConversationRef.current = true
              }
            }, 0)
          } else {
            // Clear messages for this conversation since server has none
            setInitialMessages([])
            setTimeout(() => {
              if (currentConversationRef.current === conversationId) {
                setMessages([])
                isLoadedConversationRef.current = true
              }
            }, 0)
          }
        } catch (error) {
          console.error("Error loading messages:", error)
        } finally {
          if (currentConversationRef.current === conversationId) {
            setIsLoadingMessages(false)
          }
        }
      }

      // Start fetching immediately
      fetchMessages()
    } else {
      // No conversation selected - clear everything
      currentConversationRef.current = null
      setInitialMessages([])
      setMessages([])
      setInput("")
    }
  }, [conversationId, setMessages])

  // Throttle ref for artifact detection (100ms minimum between updates)
  const lastArtifactUpdateRef = useRef<number>(0)
  // Auto-detect artifacts (both tag-based and file-based) during/after streaming
  // allArtifacts is kept current while streaming (inline tiles need the data).
  // When a live turn finishes, its newest artifact — inline (<antArtifact>) or a
  // generated file — opens in the panel once. Inline artifacts used to reach the
  // panel only through a duplicate sandbox .html file; since that copy is dropped
  // server-side (one artifact per visual), the inline artifact itself must open.
  // Throttled during streaming to avoid expensive regex re-parsing on every 50ms message update
  const artifactDetectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Assistant message whose artifact was already auto-opened — never auto-open it twice
  const autoOpenedMessageIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (messages.length === 0) return

    // Find last assistant message (for loaded conversations, scan all messages)
    const lastAssistantMessage = isLoadedConversationRef.current
      ? [...messages].reverse().find(m => m.role === 'assistant')
      : messages[messages.length - 1]
    if (!lastAssistantMessage || lastAssistantMessage.role !== 'assistant') return

    // If this is a DIFFERENT assistant message than before, reset artifacts immediately
    if (artifactMessageIdRef.current !== lastAssistantMessage.id) {
      artifactMessageIdRef.current = lastAssistantMessage.id
      setActiveArtifact(null)
      setAllArtifacts([])
      lastDetectedArtifactIdRef.current = null
      manuallySelectedArtifactRef.current = false
      lastArtifactUpdateRef.current = 0
      setIsArtifactStreaming(false)
      userClosedArtifactRef.current = false
    }

    const doDetection = () => {
      // Detect tag artifacts from all assistant messages for loaded conversations
      let tagArtifacts: Artifact[] = []
      let hasStreamingArtifact = false
      if (isLoadedConversationRef.current) {
        for (const msg of messages) {
          if (msg.role !== 'assistant') continue
          const result = getTagArtifactsFromMessage(msg)
          tagArtifacts.push(...result.artifacts)
        }
      } else {
        const result = getTagArtifactsFromMessage(lastAssistantMessage)
        tagArtifacts = result.artifacts
        hasStreamingArtifact = result.hasStreamingArtifact
      }

      // Detect file artifacts only after streaming completes
      const fileArtifacts = isLoading ? [] : (
        isLoadedConversationRef.current
          ? messages.filter(m => m.role === 'assistant').flatMap(m => getFileArtifactsFromMessage(m))
          : getFileArtifactsFromMessage(lastAssistantMessage)
      )

      const allDetected = [...tagArtifacts, ...fileArtifacts]

      setAllArtifacts(allDetected)
      setIsArtifactStreaming(isLoading && hasStreamingArtifact)

      if (allDetected.length === 0) return

      // Only a live turn opens the panel by itself — never a conversation loaded from history.
      if (isLoadedConversationRef.current) return
      // Open at the end of the turn (no mid-stream flicker), once per message,
      // and not again after the user closed it.
      if (isLoading) return
      if (userClosedArtifactRef.current) return
      if (autoOpenedMessageIdRef.current === lastAssistantMessage.id) return
      autoOpenedMessageIdRef.current = lastAssistantMessage.id

      const newest = allDetected[allDetected.length - 1]
      if (!showArtifactPreviewRef.current) {
        manuallySelectedArtifactRef.current = false
        openArtifactPanel(newest, allDetected, false)
      } else if (!manuallySelectedArtifactRef.current) {
        setActiveArtifact(newest)
        setActiveArtifactIndex(allDetected.length - 1)
      }
    }

    // Throttle detection during streaming (200ms) to avoid re-parsing on every 50ms update
    // Run immediately when streaming stops to finalize
    if (isLoading) {
      if (artifactDetectionTimerRef.current) return // Already scheduled
      artifactDetectionTimerRef.current = setTimeout(() => {
        artifactDetectionTimerRef.current = null
        doDetection()
      }, 200)
    } else {
      if (artifactDetectionTimerRef.current) {
        clearTimeout(artifactDetectionTimerRef.current)
        artifactDetectionTimerRef.current = null
      }
      doDetection()
    }

    return () => {
      if (artifactDetectionTimerRef.current) {
        clearTimeout(artifactDetectionTimerRef.current)
        artifactDetectionTimerRef.current = null
      }
    }
  }, [messages, isLoading, openArtifactPanel, getFileArtifactsFromMessage, getTagArtifactsFromMessage])

  const selectedModelInfo = allowedModels.find((m) => m.id === selectedModel) || CLAUDE_MODELS.find((m) => m.id === selectedModel)

  const createOptimisticUserMessage = useCallback((text: string) => {
    const nextId = optimisticMessageCounterRef.current++
    // A real UUID: the server saves the message under this same id, so
    // Delete/Edit work straight away, not only after a reload.
    void nextId
    const messageId = newMessageId()
    const optimisticMessage: UIMessage = {
      id: messageId,
      role: "user",
      parts: [
        {
          type: "text",
          text,
        },
      ],
    }

    setMessages((prev) => [...prev, optimisticMessage])
    return messageId
  }, [setMessages])

  // Get raw text from message parts (before stripping artifact tags)
  const getRawMessageText = (message: UIMessage): string => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    const textFromParts = parts
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join("")
    if (textFromParts) return textFromParts
    const legacyContent = (message as { content?: unknown }).content
    return typeof legacyContent === "string" ? legacyContent : ""
  }

  // Get display text with artifact tags stripped (for copy button, etc.)
  const getMessageText = (message: UIMessage): string => {
    const raw = getRawMessageText(message)
    if (raw.includes('<antArtifact')) {
      return extractTagArtifacts(raw).cleanedText
    }
    return raw
  }

  // Segment message parts into ordered sections for proper rendering
  // Returns array of { type: 'text' | 'tool' | 'file', content: string | ToolPart }
  type MessageSegment =
    | { type: 'text'; content: string }
    | { type: 'tool'; content: ToolPart }
    | { type: 'tool-group'; content: ToolPart[] }
    | { type: 'file'; content: { fileId: string; filename: string; mimeType?: string; sizeBytes?: number; downloadUrl?: string } }

  const getOrderedMessageSegments = (message: UIMessage): MessageSegment[] => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    const segments: MessageSegment[] = []
    let currentText = ''

    for (const part of parts) {
      if (typeof part !== 'object' || part === null) continue

      const p = part as Record<string, unknown>
      const partType = p.type as string

      if (!partType) continue

      // Check if this is a tool part
      const isToolPart = partType.startsWith('tool-') ||
                         partType === 'tool-invocation' ||
                         partType === 'tool-call' ||
                         partType === 'tool-result'

      if (partType === 'step-start') {
        // Step boundary - flush accumulated text to preserve step interleaving
        if (currentText.trim()) {
          segments.push({ type: 'text', content: currentText.trim() })
          currentText = ''
        }
      } else if (partType === 'text' && typeof p.text === 'string') {
        // Accumulate text
        currentText += (currentText ? '\n\n' : '') + p.text
      } else if (partType === 'file-download') {
        // File download part from DB-loaded messages
        segments.push({
          type: 'file',
          content: {
            fileId: p.fileId as string,
            filename: p.filename as string || 'download',
            mimeType: p.mimeType as string | undefined,
            sizeBytes: p.sizeBytes as number | undefined,
          },
        })
      } else if (partType === 'data-fileDownload') {
        // File download part from SSE stream (AI SDK data chunk)
        const fileData = p.data as Record<string, unknown> | undefined
        if (fileData) {
          segments.push({
            type: 'file',
            content: {
              fileId: fileData.fileId as string,
              filename: fileData.filename as string || 'download',
              mimeType: fileData.mimeType as string | undefined,
              sizeBytes: fileData.sizeBytes as number | undefined,
            },
          })
        }
      } else if (isToolPart) {
        // Flush any accumulated text before tool
        if (currentText.trim()) {
          segments.push({ type: 'text', content: currentText.trim() })
          currentText = ''
        }
        // Add tool segment
        const toolParts = extractToolParts([part])
        if (toolParts.length > 0) {
          segments.push({ type: 'tool', content: toolParts[0] })

          // A generated master-data .xlsx becomes a normal `file` segment, so it
          // reuses fab's FileCard design and gets moved to the END of the
          // message by the file-segment reordering below (same as fab's own
          // code-execution downloads).
          const tp = toolParts[0]
          if (
            [
              'generateExcel', 'tool-generateExcel',
              'generateTemplate', 'tool-generateTemplate',
              'fillFromExisting', 'tool-fillFromExisting',
              'exportWithDependencies', 'tool-exportWithDependencies',
              'removeFromLoader', 'tool-removeFromLoader',
            ].includes(tp.type) &&
            tp.state === 'output-available'
          ) {
            const out = tp.output as
              | { stagingId?: string; filename?: string }
              | undefined
            if (out?.stagingId) {
              segments.push({
                type: 'file',
                content: {
                  fileId: out.stagingId,
                  filename: out.filename || 'master-data.xlsx',
                  mimeType:
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  downloadUrl: `/api/backend-agent/download?conversationId=${conversationId}`,
                },
              })
            }
          }
        }
      }
      // Skip reasoning parts - they're handled separately
    }

    // Flush any remaining text
    if (currentText.trim()) {
      segments.push({ type: 'text', content: currentText.trim() })
    }

    // Move file segments to the end so FileCards appear after all text content.
    // Dedupe by filename, keeping only the LAST one: when the assistant
    // regenerates a file within the same turn (e.g. generate → fix a field →
    // regenerate), each generateExcel pushes its own download card, so two
    // identically-named cards would stack. The newest file supersedes the
    // earlier one, so we keep the last occurrence per filename.
    const allFileSegments = segments.filter(s => s.type === 'file')
    const seenNames = new Set<string>()
    const fileSegments: MessageSegment[] = []
    for (let i = allFileSegments.length - 1; i >= 0; i--) {
      const name = (allFileSegments[i].content as { filename: string }).filename
      if (seenNames.has(name)) continue
      seenNames.add(name)
      fileSegments.unshift(allFileSegments[i])
    }
    const nonFileSegments = segments.filter(s => s.type !== 'file')
    return [...nonFileSegments, ...fileSegments]
  }

  /**
   * Group each RUN of consecutive tool calls into its own tool-group, in place.
   *
   * This previously hoisted every tool in the message into a SINGLE group at the
   * first tool's position, because each group used to render its own
   * "Generating Response..." status line and several groups meant several
   * duplicate lines. That status line is gone, and the collapse had a real cost:
   * a turn is a loop (text -> tools -> text -> tools), and flattening it put one
   * indicator at the top while the later rounds of tool calls showed nothing
   * where they actually happened.
   *
   * Runs now render inline, interleaved with the prose, so the message reads in
   * the order the model actually worked.
   */
  const groupConsecutiveTools = (segments: MessageSegment[]): MessageSegment[] => {
    const result: MessageSegment[] = []
    // De-dupe across the WHOLE message: a manually written input/output pair can
    // surface as two entries for what is really one invocation.
    const seen = new Set<string>()
    let run: ToolPart[] = []

    const flush = () => {
      if (run.length > 0) {
        result.push({ type: 'tool-group', content: run })
        run = []
      }
    }

    for (const segment of segments) {
      if (segment.type === 'tool') {
        const tool = segment.content as ToolPart
        const id = tool.toolCallId || `${tool.type}`
        if (seen.has(id)) continue
        seen.add(id)
        run.push(tool)
        continue
      }
      // Whitespace-only text is a streaming artefact, not a real beat — letting
      // it close a run was what split one round of tool calls into two groups.
      if (segment.type === 'text' && String(segment.content).trim() === '') {
        continue
      }
      // Real content ends the run, so each round of tool calls renders exactly
      // where it happened, interleaved with the prose around it.
      flush()
      result.push(segment)
    }
    flush()
    return result
  }

  const _onSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const text = input.trim()
    if (!text || isLoading) return

    setInput("")
    userClosedArtifactRef.current = false // Reset so new artifacts can auto-open
    isLoadedConversationRef.current = false // Reset so new artifacts from AI can auto-open
    const optimisticMessageId = createOptimisticUserMessage(text)

    // If no conversation exists, create one first
    if (!conversationId) {
      try {
        // Mark that we're creating a new conversation - this prevents the message loading effect from clearing messages
        isNewConversationRef.current = true
        const response = await fetch("/api/conversations", {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({
            title: text.slice(0, 50) + (text.length > 50 ? "..." : ""),
            model: selectedModel,
            agent: "backend",
          }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => null)
          if (isSignedOut(response.status)) {
            window.location.href = "/"
            return
          }
          throw new Error(errorMessageOf(errorData, response.status))
        }

        const newConversation = await response.json()
        console.log("[createConversation] Created:", newConversation.id)
        if (!newConversation.id) {
          throw new Error("Invalid conversation response - no ID")
        }
        onConversationCreated(newConversation.id)
        pendingMessageRef.current = { text, messageId: optimisticMessageId }
      } catch (error) {
        isNewConversationRef.current = false
        console.error("Error creating conversation:", error)
        setInput(text)
        // Roll back optimistic message on failure
        setMessages((prev) => prev.filter((m) => m.id !== optimisticMessageId))
      }
    } else {
      try {
        // Pass body in the options object (second parameter)
        await sendMessage({ text, messageId: optimisticMessageId }, { body: requestBody })
      } catch (error) {
        console.error("Error sending message:", error)
        setMessages((prev) => prev.filter((m) => m.id !== optimisticMessageId))
        setInput(text)
      }
    }
  }

  // Convert File objects to data URL strings for the AI SDK
  const fileToDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }, [])

  /* The requirement document.
   *
   * A `.docx` is not sent to the model as an attachment. It is uploaded, the
   * text extracted SERVER-SIDE and stored beside the run it will produce, so the
   * tools read it from disk and it is never re-sent with a turn.
   *
   * Server-side extraction is not an optimisation. The extractor also reads
   * `word/comments.xml`, where a reviewer's accepted decisions live — "add a
   * Product filter", answered "OK" — and none of that is in the visible body
   * text. Reading the file in the browser would silently drop it.
   *
   * Returns a line for the message, or the error to show the engineer. */
  const attachRequirement = useCallback(async (file: File, convId: string | null): Promise<string> => {
    if (!convId) return `"${file.name}" could not be attached: no conversation yet.`
    const form = new FormData()
    form.append('file', file)
    form.append('conversationId', convId)
    try {
      const res = await fetch('/api/backend-agent/upload', {
        method: 'POST',
        headers: getAuthOnlyHeaders(),
        body: form,
      })
      const data = await res.json()
      if (!res.ok) return `"${file.name}" could not be read: ${errorMessageOf(data, res.status)}`
      /* The upload has returned; pre-validation is now running behind it. Start
         polling so the Report tab appears on its own rather than waiting for the
         reader to do something that happens to refresh the panel. */
      pollPreValidation(convId)
      return attachedLine(data.name)
    } catch (err) {
      return `"${file.name}" could not be uploaded: ${err instanceof Error ? err.message : 'the server could not be reached'}.`
    }
    /* `pollPreValidation` is itself a stable useCallback, so listing it changes
       nothing at runtime — but an empty array here CLAIMS this closure captures
       nothing, and it captures the poller. Left unlisted, a future edit that
       gives the poller real dependencies would silently pin this handler to a
       stale copy of it. */
  }, [pollPreValidation])

  // Core send logic - extracted so it can be called directly or after transition delay
  const executeSend = useCallback(async (data: {
    message: string;
    files: unknown[];
    pastedContent: unknown[];
    model: string;
    isThinkingEnabled: boolean;
  }) => {
    // Build the full message text: user text + pasted content
    const typedPasted = data.pastedContent as Array<{ id: string; file?: File; content?: string }>
    const pastedTexts = typedPasted
      .filter(p => p.content)
      .map(p => p.content!)
    const userText = data.message.trim()
    const baseText = pastedTexts.length > 0
      ? [userText, ...pastedTexts].filter(Boolean).join('\n\n')
      : userText

    // Convert attached files to FileUIPart format — EXCEPT Excel (.xlsx), which
    // the model can't accept as a raw attachment. The requirement document is
    // one of those: it is uploaded and extracted server-side instead.
    const typedFiles = data.files as Array<{ id: string; file: File; type: string; preview: string | null }>

    // Give immediate feedback BEFORE the upload — otherwise the screen sits
    // empty and looks like the send was dropped.
    setSendInFlight(true)
    setInput("")
    userClosedArtifactRef.current = false
    isLoadedConversationRef.current = false

    /*
     * THE ATTACHMENT GOES ON SCREEN BEFORE THE UPLOAD, NOT AFTER IT.
     *
     * Extracting a .docx server-side takes a second or two, and the message was
     * only created once that returned — so pressing send showed a wait and then,
     * two seconds later, the document. Nothing about the attachment needs the
     * server: the file name is in hand the moment it is chosen, and
     * `attachedLine` is the same function the upload's own reply is built from.
     * So the message is written now and corrected only if the upload disagrees.
     */
    const optimisticText = [
      baseText,
      ...typedFiles
        .filter((f) => f.file.name.toLowerCase().endsWith('.docx'))
        .map((f) => attachedLine(f.file.name)),
    ].filter(Boolean).join('\n\n')
    const optimisticMessageId = createOptimisticUserMessage(optimisticText)

    /* The requirement document is uploaded AGAINST a conversation, so on a new
       chat the conversation has to exist first. Created here rather than at the
       end of this handler, which is where the shell creates it for a plain text
       message. */
    let convId = conversationId
    if (!convId && typedFiles.some((f) => f.file.name.toLowerCase().endsWith('.docx'))) {
      try {
        isNewConversationRef.current = true
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({
            /* `text` is assembled after the upload loop, so the title comes
               from what the engineer actually typed. */
            title: baseText.slice(0, 50) + (baseText.length > 50 ? "..." : ""),
            model: data.model,
            agent: "backend",
          }),
        })
        if (isSignedOut(res.status)) {
          window.location.href = "/"
          return
        }
        if (res.ok) {
          const created = await res.json()
          if (created?.id) convId = created.id as string
        }
      } catch (err) {
        console.error("Could not create a conversation for the document:", err)
      }
      if (!convId) isNewConversationRef.current = false
    }


    const fileParts: Array<{ type: 'file'; mediaType: string; url: string; filename?: string }> = []
    const uploadBlocks: string[] = []
    for (const f of typedFiles) {
      /* The requirement document goes to the server, not to the model as an
         attachment — see `attachRequirement`. */
      if (f.file.name.toLowerCase().endsWith('.docx')) {
        uploadBlocks.push(await attachRequirement(f.file, convId))
        continue
      }
      try {
        const dataUrl = await fileToDataUrl(f.file)
        fileParts.push({
          type: 'file',
          mediaType: f.file.type || 'application/octet-stream',
          url: dataUrl,
          filename: f.file.name,
        })
      } catch (err) {
        console.error('Failed to read file:', f.file.name, err)
      }
    }
    const text = [baseText, ...uploadBlocks].filter(Boolean).join('\n\n')

    /* The message is already on screen — see `optimisticMessageId` above. If the
       upload disagreed with what was shown optimistically (it failed, or the
       server named the file differently) the displayed text is corrected here,
       so the transcript never claims a document arrived that did not. */
    if (text !== optimisticText) {
      setMessages((prev) => prev.map((m) =>
        m.id === optimisticMessageId
          ? { ...m, parts: [{ type: 'text' as const, text }] }
          : m))
    }

    const sendPayload: { text: string; files?: Array<{ type: 'file'; mediaType: string; url: string; filename?: string }>; messageId: string } = {
      text,
      messageId: optimisticMessageId,
    }
    if (fileParts.length > 0) {
      sendPayload.files = fileParts
    }

    if (!conversationId && convId) {
      /* Already created above for the document. Hand it over through the same
         path a fresh conversation normally takes, so the queued message is sent
         once React has the id. */
      onConversationCreated(convId)
      pendingMessageRef.current = { text, messageId: optimisticMessageId, files: fileParts.length > 0 ? fileParts : undefined }
    } else if (!conversationId) {
      ;(async () => {
        try {
          isNewConversationRef.current = true
          const response = await fetch("/api/conversations", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({
              title: text.slice(0, 50) + (text.length > 50 ? "..." : ""),
              model: data.model,
              agent: "backend",
            }),
          })
          if (!response.ok) {
            const errorData = await response.json().catch(() => null)
            if (isSignedOut(response.status)) {
              window.location.href = "/"
              return
            }
            throw new Error(errorMessageOf(errorData, response.status))
          }
          const newConversation = await response.json()
          if (!newConversation.id) throw new Error("Invalid conversation response - no ID")
          onConversationCreated(newConversation.id)
          pendingMessageRef.current = { text, messageId: optimisticMessageId, files: fileParts.length > 0 ? fileParts : undefined }
        } catch (error) {
          isNewConversationRef.current = false
          console.error("Error creating conversation:", error)
          setMessages((prev) => prev.filter((m) => m.id !== optimisticMessageId))
        }
      })()
    } else {
      sendMessage(sendPayload, { body: requestBody }).catch((error) => {
        console.error("Error sending message:", error)
        setMessages((prev) => prev.filter((m) => m.id !== optimisticMessageId))
      })
    }
  }, [conversationId, onConversationCreated, sendMessage, requestBody, setMessages, createOptimisticUserMessage, fileToDataUrl, attachRequirement])

  // Bridge from ClaudeChatInput's onSendMessage to existing chat flow
  // When sending from welcome state, triggers transition animation first
  const handleSendMessage = useCallback((data: {
    message: string;
    files: unknown[];
    pastedContent: unknown[];
    model: string;
    isThinkingEnabled: boolean;
  }) => {
    if (data.model !== selectedModel) {
      setSelectedModel(data.model as ClaudeModelId)
    }

    const text = data.message.trim()
    if (!text && data.files.length === 0 && data.pastedContent.length === 0) return

    /*
     * SEND FIRST, ANIMATE AROUND IT.
     *
     * The first message used to be HELD until the welcome screen's exit
     * animation had finished playing — `onExitComplete` was what finally called
     * `executeSend`. So pressing send on a fresh chat replayed the landing page
     * on its way out, and only then did the prompt appear in the transcript: it
     * read as the page reloading, and nothing at all happened for the length of
     * the animation plus the round trip.
     *
     * The animation is cosmetic and the send is not, so the send no longer waits
     * on it. The welcome screen still exits — `messages.length` becomes non-zero
     * the moment the message lands, which is what hides it — it simply does so
     * alongside the request instead of in front of it.
     */
    if (messages.length === 0 && transitionPhase === 'idle') {
      setTransitionPhase('exiting-welcome')
    }
    executeSend(data)
  }, [selectedModel, setSelectedModel, messages.length, transitionPhase, executeSend])

  /* The welcome screen has finished exiting. Nothing is sent here any more —
     the send went out when the engineer pressed send. This only returns the
     phase to rest so a later `New chat` shows the welcome screen again. */
  const handleWelcomeExitComplete = useCallback(() => {
    if (transitionPhase === 'exiting-welcome') setTransitionPhase('idle')
  }, [transitionPhase])

  return (
    <PanelGroup orientation="horizontal" className={cn("h-full", panelResizeTransition && "panel-resize-transition")}>
      {/* Left Panel: Chat + Prompt Input - SINGLE scrollable container */}
      {/* The left half must yield when EITHER right panel is open. It only
          accounted for the artifact panel, so with the work product open it
          still claimed the full width and squeezed that panel to a sliver. */}
      <Panel defaultSize={artifactPanelMounted || work.prd || work.hasArtifact ? 50 : 100} minSize={30}>

        {/* Skeleton loader for conversation switching - rendered OUTSIDE scroll container */}
        {isLoadingMessages ? (
          <div className="flex h-full flex-col">
            <div className="flex-1 mx-auto w-full max-w-3xl space-y-6 px-11 py-16">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className={cn("flex gap-3", i % 2 === 0 ? "justify-end" : "justify-start")}>
                  {i % 2 === 0 ? (
                    <div className="w-[55%] space-y-2">
                      <div className="h-10 rounded-2xl bg-muted animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
                    </div>
                  ) : (
                    <div className="w-[70%] space-y-2">
                      <div className="h-4 w-3/4 rounded bg-muted animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
                      <div className="h-4 w-1/2 rounded bg-muted animate-pulse" style={{ animationDelay: `${i * 100 + 50}ms` }} />
                      {i === 1 && <div className="h-4 w-2/3 rounded bg-muted animate-pulse" style={{ animationDelay: `${i * 100 + 100}ms` }} />}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {/* Skeleton input bar */}
            <div className="px-8 pb-5 pt-2">
              <div className="mx-auto max-w-3xl">
                <div className="h-[52px] w-full rounded-xl bg-muted animate-pulse" />
              </div>
            </div>
          </div>
        ) : (
        <ChatContainerRoot className={cn("h-full", isWelcomeVisible && "!overflow-hidden")}>
              <ChatContainerContent className={cn("space-y-0 px-5 transition-[padding] duration-300", isWelcomeVisible ? "h-full py-0" : "py-12")}>
                <AnimatePresence mode="popLayout" onExitComplete={handleWelcomeExitComplete}>
                  {/* Error Display */}
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mx-auto max-w-3xl px-6"
                    >
                      {/*
                        A stream-level failure (provider rejected the request,
                        timeout, bad key) cannot arrive as a data part — the
                        stream is already erroring. But the route composes its
                        text from the same capture it wrote to error_audit_logs,
                        so the id and cause are recoverable and we render the
                        SAME card as every other failure. Without this, the most
                        common failure class was the one that looked different.
                      */}
                      {(() => {
                        const text = chatErrorText(error.message)
                        const parsed = errorDetailFromText(text)
                        return parsed ? (
                          <ErrorCard detail={parsed} isAdmin={isAdmin} />
                        ) : (
                          <SystemMessage
                            variant="error"
                            cta={{ label: "Retry", onClick: retryLastMessage }}
                            dismissible
                          >
                            {text || "Something went wrong. Please try again."}
                          </SystemMessage>
                        )
                      })()}
                    </motion.div>
                  )}

                  {/* Model Change Notification */}
                  {modelJustChanged && (
                    <SystemMessage variant="action" dismissible onDismiss={() => setModelJustChanged(false)}>
                      Now using {selectedModelInfo?.name}
                    </SystemMessage>
                  )}

                  {isWelcomeVisible ? (
                    <motion.div
                      key="welcome"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, y: -20, transition: { duration: 0.2 } }}
                      transition={{ duration: 0.3 }}
                      className="relative flex h-full flex-col items-center justify-center px-6"
                      style={{ fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" }}
                    >
                      <div className="w-full max-w-2xl flex flex-col items-center text-center">
                        {/* Greeting */}
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.15, duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                          className="mb-7"
                        >
                          <h1 className="text-[34px] font-semibold tracking-[-0.4px]" style={{ color: "var(--chat-ink)" }}>
                            {getGreeting()}, {userName}
                          </h1>
                          <p className="mt-2 text-[14.5px] font-medium" style={{ color: "var(--chat-text-muted)" }}>
                            What would you like to orchestrate today?
                          </p>
                        </motion.div>

                        {/* Centered input */}
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.25, duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                          /* `mb-7` and no top margin — the same spacing the general chat gives this
   row. It carried `mt-[34px]` from the Modeling shell, where the chips sit
   BELOW the input; above it that margin pushed them onto the box. */
                          className="mb-7 flex w-full flex-wrap items-center justify-center gap-2.5"
                        >
                          {[
                            { label: "How does this work?", svg: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3"/><circle cx="12" cy="17" r=".6"/></svg> },
                            { label: "What do you need?", svg: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h7"/></svg> },
                            { label: "Use the sample requirement", svg: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></svg> },
                          ].map((chip) => (
                            <Button
                              key={chip.label}
                              type="button"
                              variant="ghost"
                              onClick={() => chatInputRef.current?.setMessage(chip.label)}
                              className="login-chip flex h-auto items-center gap-2 rounded-[22px] border-0 bg-white px-4 py-[9px] text-[13.5px] font-bold transition-all hover:-translate-y-px hover:bg-white active:scale-100 dark:hover:bg-white"
                              style={{ color: "var(--chat-ink)", border: "1px solid var(--chat-chip-border)", boxShadow: "0 2px 10px rgba(26,34,64,.05)" }}
                            >
                              <span className="flex" style={{ color: "var(--chat-indigo)" }}>{chip.svg}</span>
                              {chip.label}
                            </Button>
                          ))}
                        </motion.div>

                        {/* Domain quick-action chips (V2) */}
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.2, duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                          className="w-full"
                        >
                          <ClaudeChatInput
                            ref={chatInputRef}
                            onSendMessage={handleSendMessage}
                            models={allowedModels.map(m => ({ id: m.id, name: m.name, description: m.description }))}
                            defaultModel={selectedModel}
                            placeholder="Ask anything, or describe a task to orchestrate…"
                            isLoading={isLoading}
                            onStop={stop}
                            webSearchEnabled={webSearchEnabled}
                            onWebSearchChange={setWebSearchEnabled}
                            isThinkingEnabled={thinkingEnabled}
                            onThinkingChange={setThinkingEnabled}
                            activeMcpIds={activeMcpIds}
                            onMcpToggle={(connectionId, isActive) => {
                              setActiveMcpIds((prev) =>
                                isActive
                                  ? [...prev, connectionId]
                                  : prev.filter((id) => id !== connectionId)
                              )
                            }}
                            McpConnectionsSubmenu={McpConnectionsSubmenu}
                            onManageConnectors={onOpenMcpSettings}
                          />
                        </motion.div>

                      </div>

                      {/* Copyright - absolute bottom */}
                      <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.35, duration: 0.4 }}
                        className="absolute bottom-4 left-0 right-0 text-center text-xs font-medium"
                        style={{ color: "var(--chat-text-copyright)" }}
                      >
                        &copy; {new Date().getFullYear()} FabOrchestrator<span style={{ color: "var(--chat-indigo)" }}>.ai</span> · All rights reserved.
                      </motion.p>
                    </motion.div>
                  ) : (
                    messages.map((message, index) => {
                      const isAssistant = message.role === "assistant"
                      const isLastMessage = index === messages.length - 1
                      const isStreaming = isLoading && isLastMessage && isAssistant
                      /* The pre-validation report belongs under the model's FIRST
                         reply — the one that reads the document. Repeating it
                         under every later turn would make an answer into
                         furniture. Computed from the transcript rather than a
                         flag so it survives a reload. */
                      const isFirstAssistantTurn = isAssistant
                        && messages.findIndex((m) => m.role === "assistant") === index
                      const rawText = isAssistant ? getRawMessageText(message) : ''
                      const hasArtifactTags = isAssistant && rawText.includes('<antArtifact')
                      // Use cached parse results to avoid repeated regex on same text
                      let artifactSegments: ReturnType<typeof segmentMessageText> | null = null
                      let messageText: string
                      if (hasArtifactTags) {
                        const cacheKey = rawText.length + ':' + rawText.slice(-80)
                        const cached = artifactParseCache.current.get(cacheKey)
                        if (cached) {
                          artifactSegments = cached.segments
                          messageText = cached.cleaned
                        } else {
                          artifactSegments = segmentMessageText(rawText)
                          messageText = extractTagArtifacts(rawText).cleanedText
                          artifactParseCache.current.set(cacheKey, { segments: artifactSegments, cleaned: messageText })
                          // Keep cache small — only last 5 entries
                          if (artifactParseCache.current.size > 5) {
                            const first = artifactParseCache.current.keys().next().value
                            if (first) artifactParseCache.current.delete(first)
                          }
                        }
                      } else {
                        messageText = isAssistant ? rawText : getMessageText(message)
                      }


                      // Get ordered message segments (text and tool parts in correct order)
                      const messageSegments = isAssistant ? groupConsecutiveTools(getOrderedMessageSegments(message)) : []
                      const hasToolParts = messageSegments.some(s => s.type === 'tool-group' || s.type === 'file')

                      return (
                        <motion.div
                          key={message.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{
                            type: "spring" as const,
                            stiffness: 200,
                            damping: 25,
                            delay: index * 0.02,
                          }}
                          layout={false}
                        >
                          <Message
                            className={cn(
                              "mx-auto w-full max-w-3xl items-start gap-3 px-6",
                              isAssistant ? "justify-start" : "justify-end",
                              // Breathing room between a question and the reply that follows it.
                              isAssistant && index > 0 && "mt-6"
                            )}
                          >
                            {isAssistant ? (
                              <>
                                <div className="group flex-1 min-w-0">
                                  {/* Reasoning/Extended Thinking - shown when model provides reasoning */}
                                  {(() => {
                                    const reasoningParts = getReasoningParts(message)
                                    if (reasoningParts.length === 0) return null
                                    return (
                                      <Reasoning isStreaming={isStreaming}>
                                        <ReasoningTrigger>
                                          {isStreaming ? (
                                            <TextShimmer duration={2}>Thinking</TextShimmer>
                                          ) : (
                                            "Thinking"
                                          )}
                                        </ReasoningTrigger>
                                        <ReasoningContent
                                          markdown
                                          className="ml-2 border-l-2 border-l-slate-200 px-2 pb-1 dark:border-l-slate-700"
                                        >
                                          {reasoningParts.join('\n\n')}
                                        </ReasoningContent>
                                      </Reasoning>
                                    )
                                  })()}

                                  {/* Render message segments in order: text -> tool -> text -> tool -> text */}
                                  {hasToolParts ? (
                                    // Message has tool parts - render segments in order with timeline
                                    <>
                                      {(() => {
                                        // Collect artifacts from text segments to render after all text
                                        const collectedArtifacts: { artifact: Artifact; isStreamingArt: boolean }[] = []

                                        const rendered = messageSegments.map((segment, segIndex) => {
                                          if (segment.type === 'tool-group') {
                                            const tools = segment.content as ToolPart[]
                                            // Whether the text segment that follows this tool group
                                            // has begun rendering — used to stop the timeline's wave
                                            // animation once response tokens start streaming.
                                            const nextSeg = messageSegments[segIndex + 1]
                                            const nextTextStarted = !!(
                                              nextSeg &&
                                              nextSeg.type === 'text' &&
                                              typeof nextSeg.content === 'string' &&
                                              (nextSeg.content as string).trim().length > 0
                                            )
                                            // renderEntryForm outputs surface as a real inline form
                                            // (only offered for single-sheet objects with <11 columns).
                                            // Submissions are pushed back in as the next user message.
                                            const formParts = tools.filter(
                                              (t) =>
                                                ['renderEntryForm', 'tool-renderEntryForm'].includes(t.type) &&
                                                t.state === 'output-available' &&
                                                Array.isArray((t.output as { fields?: unknown } | undefined)?.fields)
                                            )
                                            // validateForLoad → the two-stage validation card (with a
                                            // Load button when both checks pass). loadToCmf → receipt.
                                            const validateParts = tools.filter(
                                              (t) =>
                                                ['validateForLoad', 'tool-validateForLoad'].includes(t.type) &&
                                                t.state === 'output-available' && t.output
                                            )
                                            const loadParts = tools.filter(
                                              (t) =>
                                                ['loadToCmf', 'tool-loadToCmf'].includes(t.type) &&
                                                t.state === 'output-available' && t.output &&
                                                !(t.output as { needsConfirmation?: boolean }).needsConfirmation
                                            )
                                            // The Load button is live only on the newest turn (no user
                                            // reply after it) so a stale card can't re-trigger a load.
                                            const cardInteractive = !messages.slice(index + 1).some((m) => m.role === 'user')
                                            return (
                                              <div key={`timeline-${segIndex}`}>
                                                <ToolTimeline
                                                  tools={tools}
                                                  isStreaming={isStreaming}
                                                  /* The pipeline reports each stage as it
                                                     happens — extracting, resolving paths,
                                                     building each query, validating. Without
                                                     it the box reads "Generating the CMF
                                                     export" for three unbroken minutes. */
                                                  liveLabel={progressLine}
                                                  nextTextStarted={nextTextStarted}
                                                  artifacts={allArtifacts}
                                                  onOpenArtifact={(artifact) => openArtifactPanel(artifact, allArtifacts, false, true)}
                                                />
                                                {formParts.map((tp, i) => (
                                                  <EntryForm
                                                    key={tp.toolCallId || `form-${segIndex}-${i}`}
                                                    spec={tp.output as unknown as FormSpec}
                                                    onSubmit={(text) => { sendMessage({ text }, { body: requestBody }) }}
                                                  />
                                                ))}
                                                {validateParts.map((tp, i) => (
                                                  <LoadValidationCard
                                                    key={tp.toolCallId || `val-${segIndex}-${i}`}
                                                    result={tp.output as unknown as ValidateForLoadResult}
                                                    interactive={cardInteractive}
                                                    onConfirm={(text) => { sendMessage({ text }, { body: requestBody }) }}
                                                  />
                                                ))}
                                                {loadParts.map((tp, i) => (
                                                  <LoadReceiptCard
                                                    key={tp.toolCallId || `rcpt-${segIndex}-${i}`}
                                                    result={tp.output as unknown as LoadToCmfResult}
                                                  />
                                                ))}
                                              </div>
                                            )
                                          } else if (segment.type === 'file') {
                                            const fileData = segment.content as { fileId: string; filename: string; mimeType?: string; sizeBytes?: number; downloadUrl?: string }
                                            if (!fileData.fileId) return null
                                            return (
                                              <FileCard
                                                key={`file-${segIndex}`}
                                                fileId={fileData.fileId}
                                                filename={fileData.filename}
                                                mimeType={fileData.mimeType}
                                                sizeBytes={fileData.sizeBytes}
                                                downloadUrl={fileData.downloadUrl}
                                                onPreview={isPreviewableFile(fileData.filename, fileData.mimeType) ? () => {
                                                  // Pass downloadUrl so the preview reads the generated
                                                  // .xlsx from the staged-file endpoint rather than the
                                                  // Anthropic Files API (which has no such file → "Fetch failed").
                                                  const fileArt = createFileArtifact(fileData)
                                                  const currentArtifacts = [...allArtifacts]
                                                  const exists = currentArtifacts.find(a => a.id === fileArt.id)
                                                  if (!exists) currentArtifacts.push(fileArt)
                                                  openArtifactPanel(fileArt, currentArtifacts, false, true)
                                                } : undefined}
                                              />
                                            )
                                          } else {
                                            // Text segment — collect artifacts, render text only
                                            const textContent = segment.content as string
                                            const isLastSegment = segIndex === messageSegments.length - 1

                                            if (!textContent.trim()) return null

                                            if (textContent.includes('<antArtifact')) {
                                              const { segments: artSegs, hasStreamingArtifact: segHasStreaming } = segmentMessageText(textContent)
                                              const textParts: React.ReactNode[] = []
                                              artSegs.forEach((artSeg, artIdx) => {
                                                if (artSeg.type === 'artifact') {
                                                  collectedArtifacts.push({ artifact: artSeg.artifact, isStreamingArt: isStreaming && artSeg.isStreaming })
                                                } else {
                                                  if (!artSeg.content.trim()) return
                                                  const isLastArt = isLastSegment && artIdx === artSegs.length - 1 && !segHasStreaming
                                                  textParts.push(
                                                    <MessageContent key={`art-text-${segIndex}-${artIdx}`} role="assistant">
                                                      <StreamingText
                                                        content={artSeg.content}
                                                        isStreaming={isStreaming && isLastArt}
                                                        markdown
                                                        cursorStyle="pulse-dot"
                                                      />
                                                    </MessageContent>
                                                  )
                                                }
                                              })
                                              return textParts.length > 0 ? <Fragment key={`text-${segIndex}`}>{textParts}</Fragment> : null
                                            }

                                            return (
                                              <MessageContent key={`text-${segIndex}`} role="assistant">
                                                <StreamingText
                                                  content={textContent}
                                                  isStreaming={isStreaming && isLastSegment}
                                                  markdown
                                                  cursorStyle="pulse-dot"
                                                />
                                              </MessageContent>
                                            )
                                          }
                                        })

                                        const toolsHere = messageSegments
                                          .filter((sg) => sg.type === 'tool-group')
                                          .flatMap((sg) => sg.content as ToolPart[])
                                        const wrotePrd = toolsHere.some((t) => /write_prd/.test(t.type))
                                        const built = toolsHere.some((t) => /generate_artifact|revise_artifact/.test(t.type))

                                        return (
                                          <>
                                            {rendered}

                                            {/* Artifact tiles collected from text segments, rendered after all text */}
                                            {collectedArtifacts.map(({ artifact, isStreamingArt }) => (
                                              <ArtifactTile
                                                key={artifact.id}
                                                artifact={artifact}
                                                isStreaming={isStreamingArt}
                                                onOpenPreview={() => openArtifactPanel(artifact, allArtifacts, false, true)}
                                              />
                                            ))}

                                            {/* WHAT THIS TURN PRODUCED — after the model's account of it.
                                                These used to render under the tool group, which put four
                                                file cards above the sentence that explains them. The
                                                response comes first; the artifacts follow it; the screen
                                                is one of them rather than a button. */}
                                            {!isStreaming && wrotePrd && work.prd && (
                                              <ArtifactTile
                                                artifact={prdArtifact(work.page, work.prd)}
                                                isStreaming={false}
                                                onOpenPreview={() => { setWorkTab("prd"); setWorkPanelOpen(true) }}
                                                /* Converted on the server. The tile's default would
                                                   write the markdown it holds, from a card labelled
                                                   DOCX. */
                                                onDownload={() => void downloadPrdDocx()}
                                              />
                                            )}
                                            {!isStreaming && built && work.unit
                                              .filter((f) => !f.name.startsWith("reports/"))
                                              .map((f) => (
                                                <ArtifactTile
                                                  key={f.name}
                                                  artifact={producedArtifact(f.name, unitFiles[f.name] ?? "")}
                                                  isStreaming={false}
                                                  onOpenPreview={() => void openArtifact(f.name)}
                                                />
                                              ))}
                                            {!isStreaming && (wrotePrd || built) && work.previewHtml && (
                                              <ArtifactTile
                                                artifact={screenArtifact(work.page, work.previewHtml)}
                                                isStreaming={false}
                                                onOpenPreview={() => { setWorkTab("screen"); setWorkPanelOpen(true) }}
                                              />
                                            )}
                                            {/* THE DEPLOYMENT UNIT, last, inside the turn.
                                                Read from the SERVER's view of the run
                                                directory, so it survives a reload and can
                                                never list something the download does not
                                                contain. */}
                                            {!isStreaming && built && work.hasArtifact && work.unit.length > 0 && (
                                              <div className="pb-2">
                    <div className="rounded-xl border border-border bg-card p-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">Deployment unit</span>
                        {work.page && (
                          <span className="text-xs text-muted-foreground">· {work.page}</span>
                        )}
                        {/* CLOSING THE PANEL IS NOT A ONE-WAY DOOR. Without this
                            the only route back to a dismissed PRD was to start
                            another turn. */}
                        {!workPanelOpen && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setWorkPanelOpen(true)}
                          >
                            Open panel
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="ml-auto"
                          onClick={() => void downloadUnit(conversationId)}
                        >
                          Download
                        </Button>
                      </div>
                      <ul className="mt-3 space-y-1">
                        {work.unit.map((f, i) => (
                          /* Every row opens. This card is the authoritative list
                             of what the download contains, so it is also the
                             natural index for reading any of it — including the
                             reports, which are the part an engineer most often
                             wants and never wanted to unzip for. */
                          <li key={f.name}>
                            <button
                              type="button"
                              onClick={() => void openArtifact(f.name)}
                              className="flex w-full items-center gap-2.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-accent"
                            >
                              {/* The ordinal is the IMPORT ORDER, which is the
                                  one thing about this list that is load-bearing:
                                  a page imported before its queries imports
                                  cleanly and then finds nothing to read. */}
                              <span className="grid size-[19px] shrink-0 place-items-center rounded-[5px] bg-primary/10 text-[10px] font-bold text-primary">
                                {i + 1}
                              </span>
                              <span className="truncate font-mono text-xs text-foreground">{f.name}</span>
                              <span className="ml-auto shrink-0 whitespace-nowrap text-[10.5px] text-muted-foreground">
                                {artifactRole(f.name)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-3 text-xs text-muted-foreground">
                        Import in the order listed: the queries first, then the page, then
                        the master data. A page imported before its queries imports cleanly
                        and then finds nothing to read.
                      </p>
                    </div>
                  </div>
                )}

                                          </>
                                        )
                                      })()}
                                    </>
                                  ) : artifactSegments ? (
                                    /* Has artifact tags — render text + inline ArtifactTile segments */
                                    <>
                                      {artifactSegments.segments.map((artSeg, artIdx) => {
                                        if (artSeg.type === 'artifact') {
                                          return (
                                            <ArtifactTile
                                              key={artSeg.artifact.id}
                                              artifact={artSeg.artifact}
                                              isStreaming={isStreaming && artSeg.isStreaming}
                                              onOpenPreview={() => openArtifactPanel(artSeg.artifact, allArtifacts, false, true)}
                                            />
                                          )
                                        }
                                        if (!artSeg.content.trim()) return null
                                        const isLastText = artIdx === artifactSegments.segments.length - 1 && !artifactSegments.hasStreamingArtifact
                                        return (
                                          <MessageContent key={`art-text-${artIdx}`} role="assistant">
                                            <StreamingText
                                              content={artSeg.content}
                                              isStreaming={isStreaming && isLastText}
                                              markdown
                                              cursorStyle="pulse-dot"
                                            />
                                          </MessageContent>
                                        )
                                      })}
                                    </>
                                  ) : (
                                    /* No tool parts, no artifacts - normal message display */
                                    <MessageContent role="assistant">
                                      {isStreaming ? (
                                        messageText.trim() ? (
                                        <StreamingText
                                          content={messageText}
                                          isStreaming={isStreaming}
                                          markdown
                                          charsPerTick={4}
                                          cursorStyle="pulse-dot"
                                        />
                                        ) : (
                                          /* Nothing here. This is the gap between
                                             the assistant message appearing and
                                             its first token, and the wait ladder
                                             at the foot of the transcript already
                                             covers exactly that window — with the
                                             dots, what the model is doing and how
                                             long it has been doing it. A second
                                             set of dots in the bubble read as a
                                             second thing happening. */
                                          null
                                        )
                                      ) : (
                                        <StreamingText
                                          content={messageText}
                                          isStreaming={false}
                                          markdown
                                          showCursor={false}
                                        />
                                      )}
                                    </MessageContent>
                                  )}

                                  {/*
                                    * THE PRE-VALIDATION REPORT, under the reply it belongs to.
                                    *
                                    * Placed AFTER the `hasToolParts` ternary, not inside it. Inside,
                                    * it rendered only on turns that called a tool — and the reply
                                    * that reads the document calls none, so the card never appeared
                                    * on the one turn it exists for. The backend had been writing the
                                    * report correctly the whole time.
                                    *
                                    * First assistant turn only: the report is about the document, and
                                    * the document is read once. Repeating it under every later turn
                                    * would make an answer into furniture.
                                    */}
                                  {!isStreaming && isFirstAssistantTurn
                                    && (work.prevalidationRunning || work.prevalidation || work.prevalidationError) && (
                                    <PreValidationCard
                                      report={work.prevalidation}
                                      running={work.prevalidationRunning}
                                      error={work.prevalidationError}
                                    />
                                  )}

                                  {/* Failures render from captured data, not
                                      from the model's prose. */}
                                  {visibleErrorDetails(message.parts, isAdmin).map((d) => (
                                    <ErrorCard key={d.errorId} detail={d} isAdmin={isAdmin} />
                                  ))}

                                  <MessageActionBar
                                    messageId={message.id}
                                    role="assistant"
                                    text={messageText}
                                    visible={!isStreaming}
                                    className={cn(
                                      "-ml-2.5 mt-1 flex gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100",
                                      isLastMessage && "opacity-100"
                                    )}
                                    /* No Delete on AI replies: deleting the question removes its reply too. */
                                    onFeedback={handleFeedback}
                                    feedback={feedbackById[message.id] ?? null}
                                    isAdmin={isAdmin}
                                    errorId={errorIdFromMessage(message)}
                                  />

                                  {/* FeedbackBar - shown every 3rd assistant message */}
                                  {!isStreaming && shouldShowFeedbackBar(index, message.role) && (
                                    <div className="mt-3 flex justify-center">
                                      <FeedbackBar
                                        title="Was this response helpful?"
                                        onHelpful={() => saveFeedback(message.id, 'positive')}
                                        onNotHelpful={() => saveFeedback(message.id, 'negative')}
                                      />
                                    </div>
                                  )}
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="group max-w-[85%] sm:max-w-[75%]">
                                  {/* User file attachments */}
                                  {(() => {
                                    const fileParts = Array.isArray(message.parts)
                                      ? message.parts.filter((p: { type: string }) => p.type === 'file')
                                      : []
                                    if (fileParts.length === 0) return null
                                    return (
                                      <div className="mb-2 flex flex-wrap justify-end gap-2">
                                        {fileParts.map((fp: { type: string; mediaType?: string; url?: string; filename?: string }, fpIdx: number) => {
                                          const isImage = fp.mediaType?.startsWith('image/')
                                          if (isImage && fp.url) {
                                            return (
                                              // eslint-disable-next-line @next/next/no-img-element
                                              <img
                                                key={`user-file-${fpIdx}`}
                                                src={fp.url}
                                                alt={fp.filename || 'Uploaded image'}
                                                className="max-h-48 max-w-64 rounded-lg border border-border object-cover"
                                              />
                                            )
                                          }
                                          return (
                                            <div key={`user-file-${fpIdx}`} className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                                              <FileIcon className="size-4 shrink-0" />
                                              <span className="truncate max-w-48">{fp.filename || 'File'}</span>
                                            </div>
                                          )
                                        })}
                                      </div>
                                    )
                                  })()}
                                  {/* An entry-form submission is a machine payload (marker + JSON) meant
                                      for the model. It's still sent and stored verbatim as the user
                                      message, but rendering the raw blob looks awful — show a compact
                                      summary chip instead. */}
                                  {attachedDocument(messageText).name ? (
                                    /* THE REQUIREMENT DOCUMENT, AS A CARD.
                                       It is not a `file` part — the .docx is
                                       uploaded and extracted server-side and never
                                       reaches the model as a file — so there was
                                       nothing for the attachment renderer above to
                                       draw, and it appeared as a sentence glued to
                                       the end of the engineer's own words. The
                                       sentence still goes to the model; it is only
                                       lifted out of the display. */
                                    (() => {
                                      /* `UploadedFileChip`, the chip this app already
                                         shows for a file the USER uploaded — the same
                                         one the AI Support Engineer uses.
                                         Not `FileCard`: that is the tall card for a
                                         file the assistant PRODUCED, with a download
                                         button pointed at `/api/files/<id>/download`.
                                         A requirement document has no such id, so the
                                         card rendered as an assistant artifact and its
                                         download 404'd. */
                                      const doc = attachedDocument(messageText)
                                      return (
                                        <>
                                          <UploadedFileChip filename={doc.name!} />
                                          {doc.rest && (
                                            <MessageContent role="user" className="inline-block w-fit max-w-full">
                                              {doc.rest}
                                            </MessageContent>
                                          )}
                                        </>
                                      )
                                    })()
                                  ) : parseEntryFormSubmission(messageText) ? (
                                    <EntryFormSubmissionChip summary={parseEntryFormSubmission(messageText)!} />
                                  ) : parseLoadConfirmSubmission(messageText) ? (
                                    <LoadConfirmChip />
                                  ) : parseUploadMessage(messageText) ? (
                                    (() => {
                                      const up = parseUploadMessage(messageText)!
                                      return (
                                        <>
                                          <UploadedFileChip filename={up.filename} />
                                          {up.userText && (
                                            <MessageContent role="user" className="inline-block w-fit max-w-full">
                                              {up.userText}
                                            </MessageContent>
                                          )}
                                        </>
                                      )
                                    })()
                                  ) : (
                                    <MessageContent role="user" className="inline-block w-fit max-w-full">
                                      {messageText}
                                    </MessageContent>
                                  )}
                                  {editingMessageId === message.id ? (
                                    <InlineMessageEditor
                                      initialText={messageText}
                                      busy={editBusy}
                                      onSave={(t) => handleSaveEdit(message.id, t)}
                                      onCancel={() => setEditingMessageId(null)}
                                    />
                                  ) : (
                                    <MessageActionBar
                                      messageId={message.id}
                                      role="user"
                                      text={messageText}
                                      className="mr-1 mt-1 flex justify-end gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                                      onEdit={() => setEditingMessageId(message.id)}
                                      onDelete={handleDeleteMessage}
                                    />
                                  )}
                                </div>
                              </>
                            )}
                          </Message>

                        </motion.div>
                      )
                    })
                  )}

                </AnimatePresence>

                {/* THE WAIT — shown whenever the assistant is silent.
                    Bound to `assistantSilent`, not to which message is last. It
                    was bound to the latter, and the assistant message is created
                    the moment the stream opens: the user's message stopped being
                    last almost immediately and the indicator disappeared, leaving
                    an unchanged page for the 30 seconds before the first token.
                    That is what "it looks stuck" was.
                    Gated on silence, it can never sit under streaming text — so
                    it cannot walk down the page, which was the earlier bug. Once
                    a tool starts, that tool's own timeline takes over. */}
                {(isLoading || sendInFlight) && assistantSilent && !toolRunning && (
                  <div className="mx-auto w-full max-w-3xl px-6 pb-2">
                    <WaitLadder phase={waitPhase} override={progressLine} />
                  </div>
                )}

                {/* NO "OPEN PRD AND SCREEN" BUTTON.
                    The PRD and the screen are artifacts this run produced, and
                    they are tiles at the end of the turn that produced them.
                    Clicking either re-opens the panel, so a separate button
                    saying so was chrome standing in for the thing itself. */}
                {/* ORDER IS CHRONOLOGY.
                    The produced documents render under the tool group that made
                    them, so the transcript itself carries the order. What is
                    left at the foot is the deployment unit — the summary of what
                    to import — which belongs after everything it summarises. */}
                {/* THE ARTIFACT, AS IT IS WRITTEN — and the files it left behind.
                    The live CODE is shown only while the turn runs: a wall of XML
                    left in the transcript is noise, and it is tailed to the last
                    ~40 lines so the box does not grow without bound over a
                    five-minute generation.
                    The FILE CARDS stay. The pipeline reports its files at the end
                    of a page build, moments before the turn ends, so gating them
                    on `isLoading` too meant every artifact flashed up and vanished
                    — the run produced four files and the transcript kept none of
                    them. They are the per-stage record of what this turn made, at
                    the point in the conversation where it made it. */}
                {(streaming.code.size > 0 || streaming.files.length > 0) && (
                  <div className="mx-auto w-full max-w-3xl space-y-3 px-6 pb-3">
                    {isLoading && [...streaming.code.entries()].map(([page, text]) => (
                      <div key={page}>
                        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium">{page}</span>
                          <span>·</span>
                          <span>{text.length.toLocaleString()} chars</span>
                          {/* WHY THE CONTENT ABOVE JUST STARTED OVER.
                              Without this the panel silently empties and fills
                              again, which is indistinguishable from a crash. A
                              count of attempts is not the point and would only
                              invite "why did it fail?" — what the reader needs
                              is that this is deliberate and still moving. */}
                          {streaming.rewriting.has(page) && (
                            <>
                              <span>·</span>
                              <span className="italic">refining</span>
                            </>
                          )}
                        </div>
                        {/* HIGHLIGHTED AS JSON, CAPTIONED AS WHAT IT IS.
                            The model writes the page DEFINITION — which is JSON —
                            and our code wraps it in the CMF XML envelope once it
                            is whole. So JSON is the right highlighter and the
                            wrong caption: every other label in this flow says XML,
                            and "json" here left the reader working out which of
                            the two is the artifact they are getting. */}
                        <CodeBlock className="max-h-64 overflow-auto">
                          <CodeBlockCode
                            code={streamTail(text)}
                            language="json"
                            label="page definition"
                          />
                        </CodeBlock>
                      </div>
                    ))}
                    {/* EVERY FILE, AS IT LANDS, as the tile this application
                        uses for a produced document. A run writes the page, each
                        query it consumes and the master data over two to three
                        minutes; watching them arrive one at a time is what tells
                        the engineer the run is progressing rather than hung.
                        Clicking opens it: the XML is what actually reaches a
                        tenant, and a validator verdict is a summary, not a
                        substitute for reading it. */}
                    {/* The finished files are NOT listed here. They render as
                        tiles under the tool group that produced them, which is
                        where they belong chronologically; listing them again at
                        the foot showed each artifact twice. */}
                  </div>
                )}
                {/* THE DEPLOYMENT UNIT IS NOT HERE.
                    It renders inside the turn that built it, after the
                    artifacts and before the feedback bar. At the foot of the
                    transcript it came after every message, so the turn read:
                    response, artifacts, "was this helpful?", and only then the
                    deployment unit — the thing the turn was for, arriving
                    after the question about whether the turn was any good. */}
              </ChatContainerContent>

              {/* Scroll to bottom button */}
              <div className="pointer-events-none sticky bottom-32 z-10 flex justify-center">
                <ScrollButton className="pointer-events-auto bg-background border-border shadow-md" />
              </div>

              {/* Sticky Input - only in chat mode (messages exist) */}
              {!isWelcomeVisible && messages.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
                  /* NO HORIZONTAL PADDING HERE. The transcript's column is
                     `mx-auto w-full max-w-3xl px-6` in a container with none;
                     adding `px-3 md:px-5` around the composer's copy of that
                     column narrows it, and once the panel is open the column is
                     already narrower than `max-w-3xl` — so the two stop being the
                     same width and the composer sits inset from the replies above
                     it. `px-5` is what `ChatContainerContent` puts around the
                     transcript, and the `px-6` on the inner wrapper is the
                     breathing room — the same two values, in the same order, as
                     every message above. */
                  className="sticky bottom-0 z-20 bg-background px-5 pb-3 pt-2 md:pb-5"
                  style={{
                    paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
                    /* half the gutter on each side, matching the transcript's
                       `scrollbar-gutter: stable both-edges` */
                    paddingLeft: "calc(1.25rem + var(--po-sbw, 0px))",
                    paddingRight: "calc(1.25rem + var(--po-sbw, 0px))",
                  }}
                >
                  {/* `px-6` MATCHES THE TRANSCRIPT. Every message above is
                      `max-w-3xl px-6`; the composer was `max-w-3xl` alone, so the
                      box sat 48px wider than the text it produces and the two
                      left edges did not line up. */}
                  <div className="mx-auto w-full max-w-3xl px-6">
                    <ClaudeChatInput
                      ref={chatInputRef}
                      onSendMessage={handleSendMessage}
                      models={allowedModels.map(m => ({ id: m.id, name: m.name, description: m.description }))}
                      defaultModel={selectedModel}
                      placeholder="Reply..."
                      /* PRE-VALIDATION IS WORK IN PROGRESS, so the composer says so.
                         It runs after the model's reply has finished streaming, and
                         the input went back to an arrow while the card above it still
                         read "Validating requirement against artifacts…" — inviting a
                         message into a turn that had not finished. `isLoading` is what
                         draws the stop control, blocks send, and binds Escape. */
                      isLoading={isLoading || work.prevalidationRunning}
                      onStop={() => { stop(); stopWaitingForPreValidation() }}
                      webSearchEnabled={webSearchEnabled}
                      onWebSearchChange={setWebSearchEnabled}
                      isThinkingEnabled={thinkingEnabled}
                      onThinkingChange={setThinkingEnabled}
                      activeMcpIds={activeMcpIds}
                      onMcpToggle={(connectionId, isActive) => {
                        setActiveMcpIds((prev) =>
                          isActive
                            ? [...prev, connectionId]
                            : prev.filter((id) => id !== connectionId)
                        )
                      }}
                      McpConnectionsSubmenu={McpConnectionsSubmenu}
                      onManageConnectors={onOpenMcpSettings}
                    />
                    <p className="mt-2 text-center text-[10px] text-muted-foreground/50">
                      LLM at Scale.AI. All Rights Reserved. Confidential and Proprietary Information. Version 1.0
                    </p>
                  </div>
                </motion.div>
              )}
        </ChatContainerRoot>
        )}
        </Panel>
        {/* THE WORK PRODUCT — the PRD and the mock screen, with the chrome the
            standalone gives them: both documents always reachable by tab, the
            validator's verdict beside them, a download for each, full screen,
            and a close. Mounts only once one of them exists; before that the
            conversation has the full width. */}
        {(work.prd || work.hasArtifact) && workPanelOpen && !workExpanded && (
          <>
            <PanelResizeHandle className="w-2 bg-border hover:bg-primary/20 transition-colors cursor-col-resize flex items-center justify-center">
              <div className="w-0.5 h-8 bg-muted-foreground/30 rounded-full" />
            </PanelResizeHandle>
            <Panel defaultSize={50} minSize={30}>
              <WorkPanel
                work={work}
                tab={workTab}
                onTab={setWorkTab}
                expanded={false}
                onToggleExpand={() => setWorkExpanded(true)}
                onClose={() => setWorkPanelOpen(false)}
                onDownloadUnit={() => void downloadUnit(conversationId)}
                onDownloadPrd={() => void downloadPrdDocx()}
                file={openFile}
              />
            </Panel>
          </>
        )}

        {/* FULL SCREEN is an OVERLAY, not a resize. Growing the panel to 100%
            inside the group leaves the chat mounted at zero width, and a
            zero-width panel still runs its layout — the transcript reflowed to
            nothing behind it and reflowed back on exit. An overlay leaves the
            group untouched, so returning is exactly the state you left. */}
        {(work.prd || work.hasArtifact) && workPanelOpen && workExpanded && (
          <div className="fixed inset-0 z-50 bg-background">
            <WorkPanel
              work={work}
              tab={workTab}
              onTab={setWorkTab}
              expanded
              onToggleExpand={() => setWorkExpanded(false)}
              onClose={() => { setWorkExpanded(false); setWorkPanelOpen(false) }}
              onDownloadUnit={() => void downloadUnit(conversationId)}
              onDownloadPrd={() => void downloadPrdDocx()}
              file={openFile}
            />
          </div>
        )}

        {/* Resize Handle + Right Panel: Artifact Preview */}
        {artifactPanelMounted && activeArtifact && (
          <>
            <PanelResizeHandle className="w-2 bg-border hover:bg-primary/20 transition-colors cursor-col-resize flex items-center justify-center">
              <div className="w-0.5 h-8 bg-muted-foreground/30 rounded-full" />
            </PanelResizeHandle>
            <Panel defaultSize={50} minSize={20}>
              <ArtifactPanelWrapper
                artifact={activeArtifact}
                artifacts={allArtifacts}
                currentIndex={activeArtifactIndex}
                isStreaming={isArtifactStreaming}
                onClose={closeArtifactPanel}
                onNavigate={navigateArtifact}
                onFetchFileContent={fetchFileContent}
                onFetchFileArrayBuffer={fetchFileArrayBuffer}
                fileContentCache={getFileContentCache}
                isOpen={showArtifactPreview}
                onExitComplete={handleArtifactExitComplete}
              />
            </Panel>
          </>
        )}
      </PanelGroup>
  )
}

/**
 * The inline entry form submits a machine-readable payload (an `__entry_form__`
 * marker plus a fenced JSON block) so the model can route it. That payload is
 * genuinely the user's message — it is sent to the model and stored in the DB
 * verbatim — but dumping the raw JSON into the transcript looks terrible. These
 * two helpers detect that payload and render a compact summary chip instead.
 */
type EntryFormSummary = { objectType: string; rowCount: number; firstKeys: string[] }

function parseEntryFormSubmission(text: string): EntryFormSummary | null {
  if (!text || !text.startsWith("__entry_form__:")) return null
  const json = text.match(/```json\s*([\s\S]*?)```/)
  if (!json) return null
  try {
    const parsed = JSON.parse(json[1]) as { objectType?: string; rows?: Array<Record<string, string>> }
    const rows = Array.isArray(parsed.rows) ? parsed.rows : []
    if (!parsed.objectType || rows.length === 0) return null
    // Prefer the Name column for the preview; fall back to the first filled cell.
    const firstKeys = rows
      .slice(0, 3)
      .map((r) => r.Name ?? Object.values(r).find((v) => (v ?? "").trim().length > 0) ?? "")
      .filter(Boolean)
    return { objectType: parsed.objectType, rowCount: rows.length, firstKeys }
  } catch {
    return null
  }
}

function EntryFormSubmissionChip({ summary }: { summary: EntryFormSummary }) {
  const { objectType, rowCount, firstKeys } = summary
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-2xl border border-border bg-muted/50 px-3.5 py-2 text-sm">
      <NavSvg><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></NavSvg>
      <span className="truncate">
        Submitted <span className="font-medium">{rowCount}</span> {rowCount === 1 ? "row" : "rows"} for{" "}
        <span className="font-medium">{objectType}</span>
        {firstKeys.length > 0 && <span className="text-muted-foreground"> — {firstKeys.join(", ")}</span>}
      </span>
    </div>
  )
}

/** When a user uploads an .xlsx we append a machine block to their message —
 *  `Uploaded "<name>" (__upload_ref__: <id>)\nParsed contents:\n…` — so the model
 *  can see the file. That block is real (sent + stored) but shouldn't clutter the
 *  user's bubble. Split it out: return the user's actual text + the filename. */
function parseUploadMessage(text: string): { userText: string; filename: string } | null {
  if (!text) return null
  const idx = text.indexOf('Uploaded "')
  if (idx < 0 || !text.includes('__upload_ref__:')) return null
  const m = /Uploaded "([^"]+)" \(__upload_ref__:/.exec(text.slice(idx))
  if (!m) return null
  return { userText: text.slice(0, idx).trim(), filename: m[1] }
}

/** The "Load" button on the validation card sends `__load_confirm__:<json>` as
 *  the user message (explicit consent the system prompt routes to loadToCmf).
 *  Render it as a compact chip rather than the raw payload. */
function parseLoadConfirmSubmission(text: string): boolean {
  return !!text && text.startsWith("__load_confirm__:")
}

/**
 * A DOCUMENT THIS RUN PRODUCED, as the artifact tile this application already
 * uses for produced documents.
 *
 * `renderStrategy` decides the icon and the "Document · MD" / "Code · XML" line,
 * so the PRD reads as a document and the exports read as code — which is what
 * they are, and what decides whether an engineer opens one to read or to check.
 */
/**
 * The PRD, as the engineer receives it: a Word document.
 *
 * It is written as markdown and converted server-side on download, so `.md` was
 * what the tile said and `.docx` was what arrived. The tile should name the file
 * the reader gets.
 */
function prdArtifact(page: string | null, markdown: string): Artifact {
  return {
    id: "produced-prd",
    type: "code",
    title: page ? `${page} — PRD.docx` : "PRD.docx",
    content: markdown,
    language: "docx",
    renderStrategy: "markdown-render",
    contentLoaded: true,
  }
}

/** The mock screen. One of the things this run produced, not a button. */
function screenArtifact(page: string | null, html: string): Artifact {
  return {
    id: "produced-screen",
    type: "html",
    title: page ? `${page} — Screen` : "Screen",
    content: html,
    language: "screen",
    renderStrategy: "iframe-html",
    contentLoaded: true,
  }
}

function producedArtifact(name: string, content: string): Artifact {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  const isDoc = ext === "md" || ext === "txt"
  return {
    id: `produced-${name}`,
    type: "code",
    title: name,
    content,
    language: ext === "json" ? "json" : ext === "xml" ? "xml" : "markdown",
    renderStrategy: isDoc ? "markdown-render" : "syntax-highlight",
    contentLoaded: content.length > 0,
  }
}

function UploadedFileChip({ filename }: { filename: string }) {
  return (
    <div className="mb-2 flex justify-end">
      <div className="inline-flex max-w-full items-center gap-2 rounded-2xl border border-border bg-muted/50 px-3.5 py-2 text-sm">
        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{filename}</span>
      </div>
    </div>
  )
}

function LoadConfirmChip() {
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-2xl border border-emerald-600/30 bg-emerald-600/5 px-3.5 py-2 text-sm">
      <NavSvg><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></NavSvg>
      <span className="font-medium">Confirmed — load into CMF</span>
    </div>
  )
}

function BackendAgentChat() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState<ClaudeModelId>("claude-opus-4-8" as ClaudeModelId)
  const [allowedModels, setAllowedModels] = useState<typeof CLAUDE_MODELS>(CLAUDE_MODELS as unknown as typeof CLAUDE_MODELS)
  const [, setIsLoading] = useState(true)
  const [userName, setUserName] = useState<string>("User")
  const [userEmail, setUserEmail] = useState<string>("")
  /** Server-verified admin flag (GET /api/auth/me); drives the Admin Console menu entry. */
  const [isAdminUser, setIsAdminUser] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<"general" | "appearance" | "api-keys" | "mcp" | "instructions" | "advanced">("general")
  // Track the chat key separately - stays stable during new conversation creation
  // Only changes when user explicitly selects an existing conversation
  const [chatKey, setChatKey] = useState<string>('new-chat')

  // Load user name and email from session on mount
  useEffect(() => {
    setUserName(getUserNameFromSession())
    setUserEmail(getUserEmailFromSession())
  }, [])

  // Ask the server whether this user is an admin (never trust the local blob for this).
  useEffect(() => {
    let cancelled = false
    fetch("/api/auth/me", { headers: getAuthHeaders(), cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setIsAdminUser(Boolean(d?.user?.isAdmin)) })
      .catch(() => { if (!cancelled) setIsAdminUser(false) })
    return () => { cancelled = true }
  }, [])

  // Fetch allowed models based on role (set in the Admin Console)
  useEffect(() => {
    fetch("/api/user/models", { headers: getAuthHeaders() })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.models?.length) {
          // Build model list with labels from API
          const apiModels = data.models as Array<{ id: string; name: string; enabled: boolean }>
          const modelsWithLabels = apiModels.map((m) => ({
            id: m.id,
            name: m.name, // Custom label from API
            description: m.enabled ? '' : 'Coming soon',
            disabled: !m.enabled,
          }))
          if (modelsWithLabels.length > 0) {
            setAllowedModels(modelsWithLabels as unknown as typeof CLAUDE_MODELS)
            // If current model is disabled, switch to first enabled
            // Start on the platform default (the Admin Console's Models page marks
            // it), or the first model this role may use when the default is not.
            const enabledIds = apiModels.filter(m => m.enabled).map(m => m.id)
            const preferred = typeof data.defaultModel === 'string' && enabledIds.includes(data.defaultModel) ? data.defaultModel : enabledIds[0]
            if (!enabledIds.includes(selectedModel) && preferred) {
              setSelectedModel(preferred as ClaudeModelId)
            }
          }
        }
      })
      .catch(() => {
        // Keep all models if fetch fails
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch conversations
  const fetchConversations = useCallback(async () => {
    try {
      const response = await fetch("/api/conversations?agent=backend", {
        headers: getAuthHeaders(),
      })

      if (!response.ok) {
        // 401 is now handled centrally by the wrapped window.fetch in
        // providers.tsx — it clears storage and shows the
        // session-expired modal. Don't short-circuit with an inline
        // hard redirect here, or the modal/countdown UX gets skipped.
        setConversations([])
        return
      }

      const data = await response.json()

      if (Array.isArray(data)) {
        setConversations(data)
      } else {
        setConversations([])
      }
    } catch (error) {
      console.error("Error fetching conversations:", error)
      setConversations([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Fetch conversations on mount
  useEffect(() => {
    fetchConversations()
  }, [fetchConversations])

  const handleNewChat = useCallback(() => {
    setSelectedConversationId(null)
    setChatKey('new-chat')
  }, [])

  // Keyboard shortcuts for main app
  useKeyboardShortcuts({
    shortcuts: [
      {
        ...CHAT_SHORTCUTS.newChat,
        action: handleNewChat,
      },
      {
        ...CHAT_SHORTCUTS.openSettings,
        action: () => setSettingsOpen(true),
      },
    ],
  })

  const handleSelectConversation = useCallback((id: string) => {
    setSelectedConversationId(id)
    setChatKey(id)
  }, [])

  const handleConversationCreated = useCallback((id: string) => {
    setSelectedConversationId(id)
    fetchConversations()
  }, [fetchConversations])

  const handleDeleteConversation = useCallback(async (id: string) => {
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      })
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (selectedConversationId === id) {
        setSelectedConversationId(null)
        setChatKey('new-chat-' + Date.now())
      }
    } catch (error) {
      console.error("Error deleting conversation:", error)
    }
  }, [selectedConversationId])

  /** Its last message was deleted, so the server removed the conversation. */
  const handleConversationEmptied = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (selectedConversationId === id) {
      setSelectedConversationId(null)
      setChatKey('new-chat-' + Date.now())
    }
  }, [selectedConversationId])

  const handlePinConversation = useCallback(async (id: string, isPinned: boolean) => {
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({ isPinned }),
      })
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, isPinned } : c))
      )
    } catch (error) {
      console.error("Error pinning conversation:", error)
    }
  }, [])

  const handleShareConversation = useCallback(async (id: string) => {
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({ isShared: true }),
      })
      const shareUrl = `${window.location.origin}/share/${id}`
      await navigator.clipboard.writeText(shareUrl)
      alert("Share link copied to clipboard!")
    } catch (error) {
      console.error("Error sharing conversation:", error)
    }
  }, [])

  return (
    <>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <SidebarProvider>
        <ChatSidebar
          conversations={conversations}
          selectedId={selectedConversationId}
          onSelectConversation={handleSelectConversation}
          onNewChat={handleNewChat}
          onDeleteConversation={handleDeleteConversation}
          onPinConversation={handlePinConversation}
          onShareConversation={handleShareConversation}
          userName={userName}
          userEmail={userEmail}
          isAdmin={isAdminUser}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <SidebarInset id="main-content" tabIndex={-1} className="overflow-hidden">
            <div className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1">
                <ChatContent
                  key={chatKey}
                  conversationId={selectedConversationId}
                  selectedModel={selectedModel}
                  setSelectedModel={setSelectedModel}
                  onConversationCreated={handleConversationCreated}
                  onConversationEmptied={handleConversationEmptied}
                  userName={userName}
                  onOpenMcpSettings={() => { setSettingsTab("mcp"); setSettingsOpen(true) }}
                  allowedModels={allowedModels}
                />
              </div>
            </div>
        </SidebarInset>
      </SidebarProvider>
      <SettingsModal
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSettingsTab("general") }}
        defaultTab={settingsTab}
        currentModel={selectedModel}
        onDefaultModelChange={(modelId) => setSelectedModel(modelId as ClaudeModelId)}
      />
    </>
  )
}

export { BackendAgentChat }
