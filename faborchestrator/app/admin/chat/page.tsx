"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ClaudeChatInput, type ClaudeChatInputHandle } from "@/shared/components/ui/claude-style-chat-input";
import {
  ChatContainerRoot,
  ChatContainerContent,
  ChatContainerScrollAnchor,
} from "@/shared/components/prompt-kit/chat-container";
import { ScrollButton } from "@/shared/components/prompt-kit/scroll-button";
import { SystemMessage } from "@/shared/components/prompt-kit/system-message";
import { ErrorCard, errorDetailFromText, requestErrorFromText } from "@/shared/components/prompt-kit/error-card";
import { Button } from "@/shared/components/ui/button";
import { MCPDataSourceUploadDialog, type CreatedDataSource } from "@/modules/admin/components/mcp-datasource-upload-dialog";
import { AdminChatMessage, messageText } from "@/modules/admin/components/admin-chat-message";
import { Users, FileText, LineChart, Shield } from "lucide-react";
import { AUTH_TOKEN_KEY } from "@/shared/lib/client-session";

// Inter, scoped to the Admin Assistant hero to match the approved design.
const FONT_STACK =
  "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

const ADMIN_MODELS = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", description: "Fast and efficient for everyday work" },
  { id: "claude-opus-5", name: "Claude Opus 5", description: "Strong reasoning for complex tasks" },
  { id: "claude-fable-5", name: "Claude Fable 5", description: "Advanced reasoning for demanding work" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", description: "Most capable model" },
];

// Shared footer line — matches FabOrch's exact style (text-xs, muted/60,
// blue accent on .ai). Pinned to the bottom of whatever container wraps it.
function CopyrightFooter() {
  return (
    <motion.p
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.35, duration: 0.4 }}
      className="absolute bottom-4 left-0 right-0 text-center text-xs text-muted-foreground"
    >
      &copy; {new Date().getFullYear()} LLMatscale<span className="text-blue-700">.ai</span>. All rights reserved.
    </motion.p>
  );
}

export default function AdminChatPage() {
  const [token] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) : null
  );
  const chatInputRef = useRef<ClaudeChatInputHandle>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/admin/chat",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }),
    [token]
  );

  const { messages, sendMessage, status, error, stop } = useChat({
    transport,
    // UUIDs made in the browser, as in the other chats (CLAUDE.md §6).
    generateId: () => crypto.randomUUID(),
  });
  const isLoading = status === "streaming" || status === "submitted";

  // Retry after a failure: resend the last question UNDER THE SAME ID so the
  // SDK replaces it and drops the failed reply, instead of appending a copy.
  const retryLastMessage = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const text = messageText(lastUser);
    if (text) sendMessage({ text, messageId: lastUser.id });
  }, [messages, sendMessage]);
  const isWelcome = messages.length === 0;

  // Secure MCP data-source intake: an attached file is treated as a credentials
  // document and routed to the dedicated dialog → /api/admin/mcp/secrets. It is
  // NEVER appended to the chat/prompt, so its contents never reach the model.
  const [credsFile, setCredsFile] = useState<File | null>(null);
  // The platform default model comes from the registry (Admin → Models marks
  // it); the admin chat starts there like every other chat.
  const [defaultModel, setDefaultModel] = useState("claude-sonnet-5");
  useEffect(() => {
    if (!token) return;
    fetch("/api/user/models", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (typeof d?.defaultModel === "string") setDefaultModel(d.defaultModel); })
      .catch(() => {});
  }, [token]);
  const [credsDefaultName, setCredsDefaultName] = useState("");
  const [credsOpen, setCredsOpen] = useState(false);

  const handleSendMessage = useCallback(
    (data: { message: string; files: Array<{ file: File }>; model: string }) => {
      if (!data.message.trim()) return;
      sendMessage({ text: data.message });
    },
    [sendMessage]
  );

  // Triggered by the composer's "Secure Upload" menu item AND the inline
  // "Secure Upload" button in the requirements message — routes a credentials
  // file to the secure dialog (never into the chat/model).
  const handleSecureUpload = useCallback((file: File) => {
    setCredsFile(file);
    setCredsDefaultName(file.name.replace(/\.[^.]+$/, ""));
    setCredsOpen(true);
  }, []);

  // Inline "Secure Upload" button (rendered in the requirements message) opens
  // a hidden file picker; the chosen file goes straight to the secure dialog.
  const secureUploadInputRef = useRef<HTMLInputElement>(null);
  const openSecureUploadPicker = useCallback(() => {
    secureUploadInputRef.current?.click();
  }, []);

  const handleCredsCreated = useCallback(
    (ds: CreatedDataSource) => {
      // Post a NON-SECRET, plain-language prompt so the assistant kicks off the
      // flow itself — connect + auto-discover first (no manual schema). The id is
      // included only so the assistant can act on it; per the system prompt it
      // won't echo IDs/technical details back to the admin. No credentials here.
      // Friendly, meaningful text for the admin. The id rides in a hidden marker
      // that the assistant reads but the UI strips out (see MessageBubble).
      sendMessage({
        text:
          `✅ I've securely saved the connection details for "${ds.name}". Let's set it up as a new data source. [[dsid:${ds.id}]]`,
      });
    },
    [sendMessage]
  );

  return (
    <div className="relative flex h-full flex-col">
      <MCPDataSourceUploadDialog
        open={credsOpen}
        file={credsFile}
        defaultName={credsDefaultName}
        token={token}
        onClose={() => setCredsOpen(false)}
        onCreated={handleCredsCreated}
      />
      {/* Hidden picker for the inline "Secure Upload" button in the chat. */}
      <input
        ref={secureUploadInputRef}
        type="file"
        accept=".txt,.env,.json,.csv,.md,.docx,.xlsx,.yaml,.yml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleSecureUpload(f);
          e.target.value = ""; // allow re-picking the same file
        }}
      />
      <AnimatePresence mode="wait">
        {isWelcome ? (
          <motion.div
            key="welcome"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -16, transition: { duration: 0.2 } }}
            transition={{ duration: 0.3 }}
            className="relative flex h-full w-full items-center justify-center px-6"
            style={{ fontFamily: FONT_STACK }}
          >
            <div className="flex w-full max-w-2xl flex-col items-center text-center">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12, duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="mb-8"
              >
                <h1
                  className="text-[30px] md:text-[38px] font-bold tracking-tight"
                  style={{ color: "var(--chat-heading-ink)" }}
                >
                  Admin Assistant
                </h1>
                <p className="mt-2.5 text-[15px] md:text-[17px]" style={{ color: "var(--chat-subtle-ink)" }}>
                  Manage your platform through conversation
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="w-full"
              >
                <ClaudeChatInput
                  ref={chatInputRef}
                  onSendMessage={handleSendMessage}
                  onSecureUpload={handleSecureUpload}
                  models={ADMIN_MODELS}
                  defaultModel={defaultModel}
                  placeholder="Ask about users, roles, usage, audit logs…"
                  isLoading={isLoading}
                  onStop={stop}
                />
              </motion.div>

              {/* TRY ASKING — exact labels, icons and white-pill style from the
                  approved design. Row 1 holds three chips; "Admin roles" wraps
                  to a centered second row. Each chip pre-fills the chat input. */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25, duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="mt-7 w-full"
              >
                <div
                  className="mb-3.5 text-[11px] font-bold uppercase tracking-[0.16em]"
                  style={{ color: "var(--chat-subtle-ink)" }}
                >
                  Try asking
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2.5">
                  {[
                    { label: "New users this week",    icon: Users,     prompt: "Show new users created this week" },
                    { label: "Recent audit activity",  icon: FileText,  prompt: "Show recent audit activity" },
                    { label: "Token usage this month", icon: LineChart, prompt: "Show token usage this month" },
                    { label: "Admin roles",            icon: Shield,    prompt: "Show all admin roles and their permissions" },
                  ].map((chip) => (
                    <Button
                      key={chip.label}
                      variant="ghost"
                      onClick={() => chatInputRef.current?.setMessage(chip.prompt)}
                      className="inline-flex h-auto items-center gap-2 rounded-full border border-divider-cool bg-white px-3.5 py-2 text-[13px] font-medium shadow-sm transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-md"
                      style={{ color: "var(--chat-heading-ink)" }}
                    >
                      <chip.icon className="size-[15px]" style={{ color: "var(--brand-indigo)" }} aria-hidden="true" />
                      {chip.label}
                    </Button>
                  ))}
                </div>
              </motion.div>
            </div>

            {/* Copyright pinned to the bottom of the welcome container */}
            <CopyrightFooter />
          </motion.div>
        ) : (
          <motion.div
            key="chat"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="relative flex h-full flex-col"
          >
            {/* Same scroll container, spacing and composer dock as the Fab AI
                chat (full-chat-app.tsx): messages render from the moment the
                reply starts, so the tool row's live timer covers the whole
                turn, and the composer stays pinned inside the scroll area. */}
            <ChatContainerRoot className="h-full">
              <ChatContainerContent className="space-y-0 px-5 py-12" role="log" aria-live="polite" aria-label="Conversation messages">
                {messages.map((message, index) => {
                  const isLast = index === messages.length - 1;
                  return (
                    <AdminChatMessage
                      key={message.id}
                      message={message}
                      index={index}
                      isLast={isLast}
                      isLoading={isLoading}
                      showWaitingIndicator={isLast && message.role === "user" && status === "submitted"}
                      token={token}
                      onConsent={(text) => sendMessage({ text })}
                      onSecureUpload={openSecureUploadPicker}
                      onScheduleDone={(summary) => { if (summary) sendMessage({ text: summary }); }}
                      onAlertDone={(summary) => { if (summary) sendMessage({ text: summary }); }}
                    />
                  );
                })}

                {/* Failure — at the END of the conversation, where the reply
                    would have been. A stream-level failure carries the same
                    capture that was written to the error log, so it renders as
                    the same card as every other failure; a request the API
                    refused outright shows its own message, never raw JSON. */}
                {error && (
                  <motion.div
                    key="chat-error"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mx-auto w-full max-w-3xl px-6 pb-4 pt-2"
                  >
                    {(() => {
                      const parsed = errorDetailFromText(error.message);
                      if (parsed) {
                        return (
                          <div className="space-y-2">
                            <ErrorCard detail={parsed} isAdmin />
                            <Button variant="outline" size="sm" onClick={retryLastMessage}>
                              Retry
                            </Button>
                          </div>
                        );
                      }
                      const refused = requestErrorFromText(error.message);
                      return (
                        <SystemMessage variant="error" cta={{ label: "Retry", onClick: retryLastMessage }}>
                          {refused?.message ?? (error.message || "Something went wrong. Please try again.")}
                          {refused?.errorId ? (
                            <span className="mt-1 block font-mono text-[11px] opacity-70">Error ID {refused.errorId}</span>
                          ) : null}
                        </SystemMessage>
                      );
                    })()}
                  </motion.div>
                )}
                <ChatContainerScrollAnchor />
              </ChatContainerContent>

              {/* Scroll to bottom */}
              <div className="pointer-events-none sticky bottom-32 z-10 flex justify-center">
                <ScrollButton className="pointer-events-auto border-border bg-background shadow-md" />
              </div>

              {/* Composer docked at the bottom of the scroll area, no border,
                  so it reads as a continuation of the chat surface. */}
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
                    onSecureUpload={handleSecureUpload}
                    models={ADMIN_MODELS}
                    defaultModel={defaultModel}
                    placeholder="Reply..."
                    isLoading={isLoading}
                    onStop={stop}
                  />
                  <p className="mt-2 text-center text-[10px] text-muted-foreground">
                    &copy; {new Date().getFullYear()} LLMatscale<span className="text-blue-700">.ai</span>. All rights reserved.
                  </p>
                </div>
              </motion.div>
            </ChatContainerRoot>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
