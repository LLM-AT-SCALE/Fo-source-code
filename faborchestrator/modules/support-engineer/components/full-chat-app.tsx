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
  Shield,
  Share2,
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
import { ErrorCard, visibleErrorDetails, errorDetailFromText, requestErrorFromText } from "@/shared/components/prompt-kit/error-card"
import { MessageActionBar, InlineMessageEditor } from "@/shared/components/prompt-kit/message-action-bar"
import { toast } from "sonner"
import { fileParts, newMessageId, type FilePart } from "@/shared/lib/message-files"
import { isPreviewableFile } from "@/shared/lib/file-classifier"
import { useFileContent } from "@/shared/hooks/use-file-content"
// ArtifactTile removed — artifacts now open directly in preview panel
import { ArtifactPanelWrapper } from "@/shared/components/artifact-panel-wrapper"
import { PromptBubbles, type BubblePrompt } from "@/modules/fabinsight/components/prompt-bubbles"
import { agentKeyFrom } from "@/shared/lib/agents"
import { AgentMcpHealth } from "@/shared/components/mcp-health/agent-mcp-health"
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels"
import { extractToolParts, type ToolPart } from "@/shared/components/prompt-kit/tool"
import { Loader } from "@/shared/components/prompt-kit/loader"
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/shared/components/prompt-kit/reasoning"
import { TextShimmer } from "@/shared/components/prompt-kit/text-shimmer"
import { FeedbackBar } from "@/shared/components/prompt-kit/feedback-bar"
// PromptSuggestion replaced by inline chips in welcome state
import { SystemMessage } from "@/shared/components/prompt-kit/system-message"
import { StreamingText } from "@/shared/components/prompt-kit/streaming-text"
import { ToolTimeline } from "@/shared/components/prompt-kit/tool-timeline"
import { AskUserCard, parseAskUserInput } from "@/shared/components/prompt-kit/ask-user-card"
import { FileCard } from "@/shared/components/prompt-kit/file-card"
import { ClaudeChatInput, type ClaudeChatInputHandle } from "@/shared/components/ui/claude-style-chat-input"
import { SettingsModal } from "@/shared/components/settings-modal"
import { AUTH_TOKEN_KEY, clearAuthStorage, getAuthHeaders, getUserEmailFromSession, getUserNameFromSession } from "@/shared/lib/client-session"
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


/** Caches the dashboard-admin check so the correct prompt set renders on first paint. */

function SampleIcon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

const SAMPLE_PROMPTS = [
  { label: "Run a workflow", icon: <SampleIcon d="M6 6h.01M6 18h.01M18 12h.01M8.4 6H13a3 3 0 0 1 3 3v.6M8.4 18H13a3 3 0 0 0 3-3v-.6" /> },
  { label: "Build an agent", icon: <SampleIcon d="M12 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM5.5 20a6.5 6.5 0 0 1 13 0" /> },
  { label: "Query a site", icon: <SampleIcon d="M4 21V8l7-4 7 4v13M9 21v-5h6v5M8 11h.01M12 11h.01M16 11h.01" /> },
  { label: "Compliance check", icon: <SampleIcon d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z M9.2 12l2 2 3.6-3.6" /> },
]

// Helper function to get auth headers for API calls
// Helper function to get user name from session
// Helper function to get user email from session
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
  agent = "chat",
  activeMcpIds,
  onToggle,
  onManageConnectors,
}: {
  /** Conversation agent ("chat" | "fabinsight"): only that agent's connections are listed. */
  agent?: string
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
        const res = await fetch(`/api/mcp/connections?agent=${agentKeyFrom(agent)}`, {
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
  }, [agent])

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
        {onManageConnectors && (
        <Button
            variant="ghost"
            onClick={onManageConnectors}
            className="flex h-auto items-center justify-start gap-3 border-0 bg-transparent px-3 py-2.5 mx-1 my-1 rounded-lg text-[14px] text-text-200 dark:text-foreground hover:bg-bg-hover dark:hover:bg-bg-hover transition-colors cursor-pointer w-[calc(100%-8px)] active:scale-100"
            type="button"
          >
            <Settings className="h-[18px] w-[18px] text-text-300 dark:text-text-500" />
            Manage connectors
          </Button>
        )}
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
        {onManageConnectors && (
        <Button
            variant="ghost"
            onClick={onManageConnectors}
            className="flex h-auto items-center justify-start gap-3 border-0 bg-transparent px-3 py-2.5 mx-1 my-1 rounded-lg text-[14px] text-text-200 dark:text-foreground hover:bg-bg-hover dark:hover:bg-bg-hover transition-colors cursor-pointer w-[calc(100%-8px)] active:scale-100"
            type="button"
          >
            <Settings className="h-[18px] w-[18px] text-text-300 dark:text-text-500" />
            Manage connectors
          </Button>
        )}
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
      {onManageConnectors && (<>
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
      </>)}
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
    clearAuthStorage()
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
        <div className="flex w-full items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col-reverse group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* Back to the cockpit. A route to /home already existed as
                "FO Overview", but it sat inside the Workspace group among
                decorative links, so it read as navigation rather than a way
                back and was easy to miss. This is the explicit exit. */}
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
  agent,
  conversationId,
  selectedModel,
  setSelectedModel,
  onConversationCreated,
  onConversationEmptied,
  userName,
  onOpenMcpSettings,
  allowedModels,
}: {
  /** Which agent this chat is: decides the conversation list and the MCP connections. */
  agent: "chat" | "fabinsight"
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
  // Role-driven MCP capabilities: hide the Connectors menu without the `mcp`
  // permission; show "Manage connectors" only when personal editing is allowed.
  const [mcpAccess, setMcpAccess] = useState<{ enabled: boolean; canEditPersonal: boolean }>({ enabled: true, canEditPersonal: false })
  useEffect(() => {
    let cancelled = false
    fetch("/api/mcp/access", { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((a) => { if (!cancelled && a) setMcpAccess({ enabled: !!a.enabled, canEditPersonal: !!a.canEditPersonal }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const mcpLoadedRef = useRef(false) // Track if MCP connections have been loaded

  // Load connected MCP connections and enable them by default
  useEffect(() => {
    if (mcpLoadedRef.current) return
    mcpLoadedRef.current = true

    const loadConnectedMcps = async () => {
      try {
        const res = await fetch(`/api/mcp/connections?agent=${agentKeyFrom(agent)}`, {
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
  }, [agent])

  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([])
  const [isLoadingMessages, setIsLoadingMessages] = useState(!!conversationId)
  const [waitingForResponse, setWaitingForResponse] = useState(false)
  const [input, setInput] = useState("")
  const chatInputRef = useRef<ClaudeChatInputHandle>(null)

  // Prompt chips for this role (Dashboard Scheduling). Empty = show the generic sample prompts.
  const [promptChips, setPromptChips] = useState<BubblePrompt[]>([])
  useEffect(() => {
    let cancelled = false
    fetch("/api/fabinsight/access", { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && Array.isArray(j?.chips)) setPromptChips(j.chips) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const pendingMessageRef = useRef<{ text: string; messageId: string; files?: Array<{ type: 'file'; mediaType: string; url: string; filename?: string }> } | null>(null)
  const currentConversationRef = useRef<string | null>(null)
  const isNewConversationRef = useRef(false) // Track if we just created a new conversation
  const optimisticMessageCounterRef = useRef(0)

  // File content loading hook
  const { fetchFileContent, fetchFileArrayBuffer, getCache: getFileContentCache } = useFileContent()

  // Artifact state - use refs to prevent re-render loops
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null)
  // Assistant message the open artifact came from (lets the preview pin it for scheduling).
  const [activeArtifactMessageId, setActiveArtifactMessageId] = useState<string | null>(null)
  const [allArtifacts, setAllArtifacts] = useState<Artifact[]>([])
  const [activeArtifactIndex, setActiveArtifactIndex] = useState(0)
  const [showArtifactPreview, setShowArtifactPreview] = useState(false)
  const [artifactPanelMounted, setArtifactPanelMounted] = useState(false)
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
  const pendingSendDataRef = useRef<{ message: string; files: unknown[]; pastedContent: unknown[]; model: string; isThinkingEnabled: boolean } | null>(null)
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
  const openArtifactPanel = useCallback((artifact: Artifact, artifacts: Artifact[] = [], _streaming: boolean = false, manualSelection: boolean = false, messageId?: string) => {
    if (messageId) setActiveArtifactMessageId(messageId)
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
  const apiEndpoint = "/api/chat"

  // Create request body - this will be sent with each chat request
  const requestBody = useMemo(() => ({
    model: selectedModel,
    webSearch: webSearchEnabled,
    enableReasoning: thinkingEnabled,
    conversationId,
    activeMcpIds,
    agent,
    // This view renders ask_user as clickable choices (AskUserCard).
    interactiveChoices: true,
  }), [selectedModel, webSearchEnabled, thinkingEnabled, conversationId, activeMcpIds, agent])

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

  /* ────────────────────────────────────────────────────────────────────
   * MESSAGE ACTIONS — edit, delete, rate.
   *
   * These buttons shipped in the first commit with no handlers and no
   * endpoints behind them; clicking did nothing at all. The handlers below
   * back them, and each one keeps the local transcript in step with what the
   * server actually did rather than assuming success.
   * ──────────────────────────────────────────────────────────────────── */

  /** Which user message is currently open in the inline editor. */
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
  /** Ratings by message id, so a thumb stays lit across re-renders. */
  const [feedbackById, setFeedbackById] = useState<Record<string, 'up' | 'down' | null>>({})

  /** Persist a rating. Throws on failure so the bar can roll back its state. */
  const handleFeedback = useCallback(async (messageId: string, feedback: 'up' | 'down' | null) => {
    // The bar speaks up/down; the stored contract is positive/negative/null.
    const value = feedback === 'up' ? 'positive' : feedback === 'down' ? 'negative' : null
    const res = await fetch('/api/messages/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ messageId, feedback: value }),
    })
    if (!res.ok) throw new Error(`Feedback failed (HTTP ${res.status})`)
    setFeedbackById((prev) => ({ ...prev, [messageId]: feedback }))
  }, [])

  /**
   * Delete a message. The server also removes the reply a question produced,
   * and returns every id it deleted — we trim the local transcript to exactly
   * that set rather than guessing which ones went.
   */
  const handleDeleteMessage = useCallback(async (messageId: string) => {
    const res = await fetch(`/api/messages/${messageId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    })
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

  /**
   * Save an edited question and re-run from there.
   *
   * The server drops every message after the edited one, because they answered
   * text that no longer exists. We mirror that locally and then resend, so the
   * conversation continues from the corrected question.
   */
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
        // Keep everything up to and including the edited message; drop the rest.
        const kept = prev.slice(0, idx + 1)
        kept[idx] = {
          ...kept[idx],
          parts: [...files, { type: 'text', text }],
        } as UIMessage
        return kept
      })

      setEditingMessageId(null)
      isLoadedConversationRef.current = false
      // Re-run FROM the edited message (same id) — not a new copy of it.
      sendMessage({ text, files, messageId }, { body: requestBody })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the edit.')
    } finally {
      setEditBusy(false)
    }
  }, [setMessages, sendMessage, requestBody])

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

  const isLoading = status === "submitted" || status === "streaming"
  const isWelcomeVisible = messages.length === 0 && transitionPhase === 'idle' && !isLoadingMessages

  // Clear waitingForResponse once the AI SDK picks up the request
  useEffect(() => {
    if (status === "streaming" || status === "submitted") {
      setWaitingForResponse(false)
    }
  }, [status])

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

            // Restore saved ratings so a thumb the user set earlier is still
            // lit when they come back to the conversation.
            const restored: Record<string, 'up' | 'down' | null> = {}
            for (const m of data.messages as Array<{ id: string; feedback?: string | null }>) {
              if (m.feedback === 'positive') restored[m.id] = 'up'
              else if (m.feedback === 'negative') restored[m.id] = 'down'
            }
            setFeedbackById(restored)

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
        openArtifactPanel(newest, allDetected, false, false, lastAssistantMessage.id)
      } else if (!manuallySelectedArtifactRef.current) {
        setActiveArtifact(newest)
        setActiveArtifactIndex(allDetected.length - 1)
        setActiveArtifactMessageId(lastAssistantMessage.id)
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
    | { type: 'file'; content: { fileId: string; filename: string; mimeType?: string; sizeBytes?: number } }

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

      // ask_user is shown as a choice card after the message, not as a tool row.
      if (partType === 'tool-ask_user') continue

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
        }
      }
      // Skip reasoning parts - they're handled separately
    }

    // Flush any remaining text
    if (currentText.trim()) {
      segments.push({ type: 'text', content: currentText.trim() })
    }

    // Move file segments to the end so FileCards appear after all text content
    const fileSegments = segments.filter(s => s.type === 'file')
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

  /**
   * Send the option picked on an ask_user card as the user's reply. It goes
   * through the normal send path, so it is saved and titled like typed text.
   * A question card only ever follows an assistant reply, so the conversation
   * already exists.
   */
  const sendChoice = async (text: string) => {
    if (!text.trim() || isLoading) return
    setWaitingForResponse(true)
    userClosedArtifactRef.current = false
    isLoadedConversationRef.current = false
    const optimisticMessageId = createOptimisticUserMessage(text)
    try {
      await sendMessage({ text, messageId: optimisticMessageId }, { body: requestBody })
    } catch (error) {
      console.error("Error sending choice:", error)
      reportUnsent(text, error)
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMessageId))
      setWaitingForResponse(false)
    }
  }

  /**
   * A message that could not be sent. These failures used to go to the
   * browser console only: the question vanished from the chat and nothing
   * said why. Say what failed, and offer the text back so nothing typed is lost.
   */
  const reportUnsent = (text: string, error: unknown) => {
    const reason = error instanceof Error && error.message ? error.message : "the request did not go through"
    toast.error(`Your message was not sent: ${reason}`, {
      description: text.length > 140 ? `${text.slice(0, 140)}…` : text,
      action: text ? { label: "Copy text", onClick: () => { navigator.clipboard.writeText(text).catch(() => {}) } } : undefined,
      duration: 12000,
    })
  }

  const _onSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const text = input.trim()
    if (!text || isLoading) return

    setInput("")
    setWaitingForResponse(true)
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
            agent,
          }),
        })

        if (!response.ok) {
          const errorData = await response.json()
          throw new Error(errorData?.error?.message ?? (typeof errorData?.error === 'string' ? errorData.error : `HTTP ${response.status}`))
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
        reportUnsent(text, error)
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
        reportUnsent(text, error)
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
    const text = pastedTexts.length > 0
      ? [userText, ...pastedTexts].filter(Boolean).join('\n\n')
      : userText

    // Convert attached files (images, documents) to FileUIPart format
    const typedFiles = data.files as Array<{ id: string; file: File; type: string; preview: string | null }>
    const fileParts: Array<{ type: 'file'; mediaType: string; url: string; filename?: string }> = []
    for (const f of typedFiles) {
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

    setInput("")
    setWaitingForResponse(true)
    userClosedArtifactRef.current = false
    isLoadedConversationRef.current = false
    const optimisticMessageId = createOptimisticUserMessage(text)

    const sendPayload: { text: string; files?: Array<{ type: 'file'; mediaType: string; url: string; filename?: string }>; messageId: string } = {
      text,
      messageId: optimisticMessageId,
    }
    if (fileParts.length > 0) {
      sendPayload.files = fileParts
    }

    if (!conversationId) {
      ;(async () => {
        try {
          isNewConversationRef.current = true
          const response = await fetch("/api/conversations", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({
              title: text.slice(0, 50) + (text.length > 50 ? "..." : ""),
              model: data.model,
              agent,
            }),
          })
          if (!response.ok) {
            const errorData = await response.json()
            throw new Error(errorData?.error?.message ?? (typeof errorData?.error === 'string' ? errorData.error : `HTTP ${response.status}`))
          }
          const newConversation = await response.json()
          if (!newConversation.id) throw new Error("Invalid conversation response - no ID")
          onConversationCreated(newConversation.id)
          pendingMessageRef.current = { text, messageId: optimisticMessageId, files: fileParts.length > 0 ? fileParts : undefined }
        } catch (error) {
          isNewConversationRef.current = false
          console.error("Error creating conversation:", error)
          reportUnsent(text, error)
          setMessages((prev) => prev.filter((m) => m.id !== optimisticMessageId))
        }
      })()
    } else {
      sendMessage(sendPayload, { body: requestBody }).catch((error) => {
        console.error("Error sending message:", error)
        reportUnsent(text, error)
        setMessages((prev) => prev.filter((m) => m.id !== optimisticMessageId))
      })
    }
  }, [agent, conversationId, onConversationCreated, sendMessage, requestBody, setMessages, createOptimisticUserMessage, fileToDataUrl])

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

    // If sending from welcome state, trigger exit animation first
    if (messages.length === 0 && transitionPhase === 'idle') {
      pendingSendDataRef.current = data
      setTransitionPhase('exiting-welcome')
    } else {
      executeSend(data)
    }
  }, [selectedModel, setSelectedModel, messages.length, transitionPhase, executeSend])

  // Called when welcome exit animation completes
  const handleWelcomeExitComplete = useCallback(() => {
    if (transitionPhase === 'exiting-welcome' && pendingSendDataRef.current) {
      setTransitionPhase('entering-chat')
      executeSend(pendingSendDataRef.current)
      pendingSendDataRef.current = null
      // Reset after paint
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setTransitionPhase('idle'))
      })
    }
  }, [transitionPhase, executeSend])

  return (
    <PanelGroup orientation="horizontal" className={cn("h-full", panelResizeTransition && "panel-resize-transition")}>
      {/* Left Panel: Chat + Prompt Input - SINGLE scrollable container */}
      <Panel defaultSize={artifactPanelMounted ? 50 : 100} minSize={30} className="relative">
        {/* This agent's MCP servers + databases, top-right of the chat. */}
        <div className="absolute right-4 top-3 z-20"><AgentMcpHealth agent={agentKeyFrom(agent)} /></div>

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

                        {/* Prompt chips (the role's dashboard shortcuts) or generic sample prompts above the composer. */}
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.22, duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                          className="mb-7 w-full"
                        >
                          {promptChips.length > 0 ? (
                            <PromptBubbles
                              items={promptChips}
                              // Load the prompt into the composer rather than sending it — these are
                              // starting points the user may want to edit before running.
                              onSelect={(item) => chatInputRef.current?.setMessage(item.prompt)}
                            />
                          ) : (
                            <div className="flex flex-wrap items-center justify-center gap-2.5">
                              {SAMPLE_PROMPTS.map((s, i) => (
                                <motion.button
                                  key={s.label}
                                  type="button"
                                  initial={{ opacity: 0, y: 6 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  transition={{ delay: 0.04 * i, duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
                                  onClick={() => chatInputRef.current?.setMessage(s.label)}
                                  className="login-chip group inline-flex h-auto items-center gap-2 rounded-[22px] bg-white px-4 py-[9px] text-[13.5px] font-bold transition-all hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                                  style={{
                                    color: "var(--chat-ink)",
                                    border: "1px solid var(--chat-chip-border)",
                                    boxShadow: "0 2px 10px rgba(26,34,64,.05)",
                                  }}
                                >
                                  <span className="flex transition-colors" style={{ color: "var(--brand-indigo)" }}>
                                    {s.icon}
                                  </span>
                                  {s.label}
                                </motion.button>
                              ))}
                            </div>
                          )}
                        </motion.div>

                        {/* Centered input */}
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
                            mcpAgent={agent}
                            mcpEnabled={mcpAccess.enabled}
                            onManageConnectors={mcpAccess.canEditPersonal ? onOpenMcpSettings : undefined}
                          />
                        </motion.div>

                        {/* Quick-action chips moved ABOVE the composer (FabInsight bubbles/sample prompts). */}

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

                      // Show pulse-dot after the last user message while waiting for assistant response
                      const showWaitingIndicator = isLastMessage && !isAssistant && (waitingForResponse || status === "submitted")

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
                                            return (
                                              <ToolTimeline
                                                key={`timeline-${segIndex}`}
                                                tools={tools}
                                                isStreaming={isStreaming}
                                                nextTextStarted={nextTextStarted}
                                                artifacts={allArtifacts}
                                                onOpenArtifact={(artifact) => openArtifactPanel(artifact, allArtifacts, false, true, message.id)}
                                              />
                                            )
                                          } else if (segment.type === 'file') {
                                            const fileData = segment.content as { fileId: string; filename: string; mimeType?: string; sizeBytes?: number }
                                            if (!fileData.fileId) return null
                                            return (
                                              <FileCard
                                                key={`file-${segIndex}`}
                                                fileId={fileData.fileId}
                                                filename={fileData.filename}
                                                mimeType={fileData.mimeType}
                                                sizeBytes={fileData.sizeBytes}
                                                onPreview={isPreviewableFile(fileData.filename, fileData.mimeType) ? () => {
                                                  const fileArt = createFileArtifact(fileData)
                                                  const currentArtifacts = [...allArtifacts]
                                                  const exists = currentArtifacts.find(a => a.id === fileArt.id)
                                                  if (!exists) currentArtifacts.push(fileArt)
                                                  openArtifactPanel(fileArt, currentArtifacts, false, true, message.id)
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

                                        return (
                                          <>
                                            {rendered}
                                            {/* Artifact tiles collected from text segments, rendered after all text */}
                                            {collectedArtifacts.map(({ artifact, isStreamingArt }) => (
                                              <ArtifactTile
                                                key={artifact.id}
                                                artifact={artifact}
                                                isStreaming={isStreamingArt}
                                                onOpenPreview={() => openArtifactPanel(artifact, allArtifacts, false, true, message.id)}
                                              />
                                            ))}
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
                                              onOpenPreview={() => openArtifactPanel(artSeg.artifact, allArtifacts, false, true, message.id)}
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
                                          <Loader variant="pulse-dot" size="md" className="justify-start" />
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
                                  {/* Clarifying question from ask_user: clickable options. */}
                                  {(() => {
                                    const askPart = (message.parts as Array<Record<string, unknown>>).find(
                                      (p) => p?.type === 'tool-ask_user' && (p.state === 'input-available' || p.state === 'output-available')
                                    )
                                    const questions = askPart ? parseAskUserInput(askPart.input) : null
                                    if (!questions) return null
                                    const next = messages[index + 1]
                                    const answeredText = next
                                      ? (next.role === 'user' ? getMessageText(next) : '')
                                      : undefined
                                    return (
                                      <AskUserCard
                                        key={`ask-${message.id}`}
                                        questions={questions}
                                        active={isLastMessage && !isLoading}
                                        answeredText={answeredText}
                                        onAnswer={sendChoice}
                                      />
                                    )
                                  })()}
                                  {/*
                                    Tool failures, rendered from the streamed
                                    `data-errorDetail` parts rather than from
                                    the model's prose — so the cause shown is
                                    the one that was actually captured, and it
                                    carries an id you can follow up with.
                                  */}
                                  {visibleErrorDetails(message.parts, isAdmin).map((detail) => (
                                    <ErrorCard key={detail.errorId} detail={detail} isAdmin={isAdmin} />
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
                                    /* Only present when this turn actually
                                       failed — the control hides otherwise. */
                                    errorId={visibleErrorDetails(message.parts, isAdmin)[0]?.errorId ?? null}
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
                                  {editingMessageId === message.id ? (
                                    /* Edit in place — the question stays where
                                       it sits in the conversation. */
                                    <InlineMessageEditor
                                      initialText={messageText}
                                      busy={editBusy}
                                      onSave={(text) => handleSaveEdit(message.id, text)}
                                      onCancel={() => setEditingMessageId(null)}
                                    />
                                  ) : (
                                    <>
                                      <MessageContent role="user" className="inline-block w-fit max-w-full">
                                        {messageText}
                                      </MessageContent>
                                      <MessageActionBar
                                        messageId={message.id}
                                        role="user"
                                        text={messageText}
                                        visible={!isLoading}
                                        className="mr-1 mt-1 flex justify-end gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                                        onEdit={() => setEditingMessageId(message.id)}
                                        onDelete={handleDeleteMessage}
                                      />
                                    </>
                                  )}
                                </div>
                              </>
                            )}
                          </Message>

                          {/* Pulse-dot waiting indicator */}
                          {showWaitingIndicator && (
                            <motion.div
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              transition={{ duration: 0.3 }}
                              className="mx-auto w-full max-w-3xl px-6 pt-3"
                            >
                              <Loader variant="pulse-dot" size="md" className="justify-start" />
                            </motion.div>
                          )}
                        </motion.div>
                      )
                    })
                  )}

                  {/*
                    Error display — at the END of the conversation, where the
                    failed reply would have been. It used to sit above every
                    message, so a failure at the bottom of a long chat was
                    scrolled out of sight and the reply simply seemed missing.
                  */}
                  {error && (
                    <motion.div
                      key="chat-error"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mx-auto w-full max-w-3xl px-6 pt-2 pb-4"
                    >
                      {(() => {
                        /*
                          A stream-level failure (provider rejected the request,
                          timeout, bad key) is composed from the same capture
                          written to error_audit_logs, so it renders as the SAME
                          card as every other failure.
                        */
                        const parsed = errorDetailFromText(error.message)
                        if (parsed) {
                          return (
                            <div className="space-y-2">
                              <ErrorCard detail={parsed} isAdmin={isAdmin} />
                              <Button variant="outline" size="sm" onClick={retryLastMessage}>
                                Retry
                              </Button>
                            </div>
                          )
                        }
                        // Refused before any reply: the API's own message, never raw JSON.
                        const refused = requestErrorFromText(error.message)
                        return (
                          <SystemMessage
                            variant="error"
                            cta={{ label: "Retry", onClick: retryLastMessage }}
                          >
                            {refused?.message ?? (error.message || "Something went wrong. Please try again.")}
                            {isAdmin && refused?.errorId ? (
                              <span className="mt-1 block font-mono text-[11px] opacity-70">Error ID {refused.errorId}</span>
                            ) : null}
                          </SystemMessage>
                        )
                      })()}
                    </motion.div>
                  )}

                </AnimatePresence>
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
                  className="sticky bottom-0 z-20 bg-background px-3 pb-3 pt-2 md:px-5 md:pb-5"
                  style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
                >
                  <div className="mx-auto max-w-3xl">
                    <ClaudeChatInput
                      ref={chatInputRef}
                      onSendMessage={handleSendMessage}
                      models={allowedModels.map(m => ({ id: m.id, name: m.name, description: m.description }))}
                      defaultModel={selectedModel}
                      placeholder="Reply..."
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
                      mcpAgent={agent}
                      mcpEnabled={mcpAccess.enabled}
                      onManageConnectors={mcpAccess.canEditPersonal ? onOpenMcpSettings : undefined}
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
                messageId={activeArtifactMessageId ?? undefined}
              />
            </Panel>
          </>
        )}
      </PanelGroup>
  )
}

function FullChatApp({ agent = "chat" }: { agent?: "chat" | "fabinsight" }) {
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
      const response = await fetch(`/api/conversations?agent=${agent}`, {
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
  }, [agent])

  // Fetch conversations on mount
  useEffect(() => {
    fetchConversations()
  }, [fetchConversations])

  const handleNewChat = useCallback(() => {
    setSelectedConversationId(null)
    // A fresh key every time. Reusing the constant 'new-chat' meant starting a
    // new chat from an unsaved one produced no key change, so React kept the
    // same instance and its messages survived.
    setChatKey('new-chat-' + Date.now())
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
          <ChatContent
            key={chatKey}
            agent={agent}
            conversationId={selectedConversationId}
            selectedModel={selectedModel}
            setSelectedModel={setSelectedModel}
            onConversationCreated={handleConversationCreated}
            onConversationEmptied={handleConversationEmptied}
            userName={userName}
            onOpenMcpSettings={() => { setSettingsTab("mcp"); setSettingsOpen(true) }}
            allowedModels={allowedModels}
          />
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

export { FullChatApp }
