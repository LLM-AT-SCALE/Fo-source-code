"use client"

import * as React from "react"
import { useMemo, useState, useRef, useEffect } from "react"
import { useChat } from "@ai-sdk/react"
import { ErrorCard, visibleErrorDetails, errorDetailFromText, requestErrorFromText } from "@/shared/components/prompt-kit/error-card"
import { DefaultChatTransport, type UIMessage } from "ai"
import { Loader2 } from "lucide-react"
import { Markdown } from "@/shared/components/prompt-kit/markdown"
import { Button } from "@/shared/components/ui/button"

const AUTH_TOKEN_KEY = "llmatscale_auth_token"
const DEFAULT_MODEL = "claude-fable-5-1"

const sv = (children: React.ReactNode, size = 14) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {children}
    </svg>
)

const CHIPS: { label: string; icon: React.ReactNode }[] = [
    { label: "Yield variance · Line 4", icon: sv(<><polyline points="3 17 9 11 13 15 21 7" /><polyline points="14 7 21 7 21 14" /></>) },
    { label: "Compliance · Fab West", icon: sv(<><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9.2 12l2 2 3.6-3.6" /></>) },
    { label: "Monthly OEE trend", icon: sv(<path d="M3 12h4l3 8 4-16 3 8h4" />) },
]

function getAuthHeaders(): Record<string, string> {
    const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) || "" : ""
    return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

function getMessageText(message: UIMessage): string {
    if (!message.parts || !Array.isArray(message.parts)) return ""
    return message.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as { text?: string }).text === "string")
        .map((p) => p.text)
        .join("")
}

export function CockpitAsk() {
    const [input, setInput] = useState("")
    const scrollRef = useRef<HTMLDivElement>(null)

    const requestBody = useMemo(() => ({ model: DEFAULT_MODEL, activeMcpIds: [] as string[], webSearch: false, enableReasoning: false }), [])
    const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat", body: requestBody, headers: getAuthHeaders() }), [requestBody])

    const { messages, status, sendMessage, stop, error } = useChat({
        transport,
        experimental_throttle: 80,
        onError: (err) => console.error("[Cockpit Ask] Error:", err),
    })

    const isStreaming = status === "streaming" || status === "submitted"
    const hasMessages = messages.length > 0

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }, [messages, isStreaming])

    const submit = (text: string) => {
        const trimmed = text.trim()
        if (!trimmed || isStreaming) return
        sendMessage({ text: trimmed }, { body: requestBody })
        setInput("")
    }

    const onSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        submit(input)
    }

    return (
        <>
            {hasMessages && (
                <div
                    ref={scrollRef}
                    className="mx-auto mt-[26px] max-h-[380px] w-full max-w-[780px] overflow-y-auto rounded-2xl border bg-white p-5 text-left"
                    style={{ borderColor: "var(--border-light)", boxShadow: "0 10px 34px rgba(22,28,52,.07)" }}
                >
                    {messages.map((m) => {
                        const text = getMessageText(m)
                        // Failures arrive as data parts, not text. A reply that is
                        // ONLY a failure used to render as nothing at all — the
                        // question simply went unanswered on screen.
                        const failures = m.role === "assistant" ? visibleErrorDetails(m.parts, false) : []
                        if (!text && failures.length === 0) return null
                        if (m.role === "user") {
                            return (
                                <div key={m.id} className="mb-4 flex justify-end">
                                    <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px]" style={{ background: "var(--brand-indigo-bg)", color: "var(--text-ink)" }}>
                                        {text}
                                    </div>
                                </div>
                            )
                        }
                        return (
                            <div key={m.id} className="mb-4 flex gap-3">
                                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-white" style={{ background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))" }}>
                                    {sv(<path d="M3 12h4l3 8 4-16 3 8h4" />)}
                                </div>
                                <div className="min-w-0 flex-1">
                                    {text && (
                                        <div className="prose prose-sm max-w-none" style={{ color: "var(--text-ink)" }}>
                                            <Markdown>{text}</Markdown>
                                        </div>
                                    )}
                                    {failures.map((d) => (
                                        <ErrorCard key={d.errorId} detail={d} isAdmin={false} />
                                    ))}
                                </div>
                            </div>
                        )
                    })}
                    {isStreaming && messages[messages.length - 1]?.role === "user" && (
                        <div className="flex items-center gap-2 px-2 text-sm" style={{ color: "var(--text-muted-cool)" }}>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Thinking…
                        </div>
                    )}
                    {error && (
                        <div className="mt-2 rounded-lg px-3 py-2 text-sm text-red-600" style={{ background: "var(--cockpit-error-bg)", border: "1px solid var(--cockpit-error-border)" }}>
                            {/* The API's own message — never the raw JSON body. */}
                            {errorDetailFromText(error.message)?.message ??
                                requestErrorFromText(error.message)?.message ??
                                (error.message || "Something went wrong.")}
                        </div>
                    )}
                </div>
            )}

            {/* ASK BAR */}
            <form
                onSubmit={onSubmit}
                className="cockpit-askbar mx-auto mt-[26px] flex max-w-[780px] items-center gap-3 rounded-2xl border bg-white py-2.5 pl-5 pr-2.5"
                style={{ borderColor: "var(--border-light)", boxShadow: "0 10px 34px rgba(22,28,52,.07)" }}
            >
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask anything, or describe a task to orchestrate…"
                    className="flex-1 border-0 bg-transparent text-[15px] outline-none placeholder:text-[var(--text-subtle)]"
                    style={{ color: "var(--text-ink)" }}
                />
                {isStreaming ? (
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={stop}
                        className="flex h-auto items-center gap-[7px] rounded-[11px] border-0 px-[18px] py-[11px] text-[13.5px] font-bold hover:opacity-90 active:scale-100"
                        style={{ background: "var(--cockpit-surface)", color: "var(--text-ink)" }}
                    >
                        Stop
                    </Button>
                ) : (
                    <Button
                        type="submit"
                        variant="ghost"
                        className="flex h-auto items-center gap-[7px] rounded-[11px] border-0 px-[18px] py-[11px] text-[13.5px] font-bold text-white transition-transform hover:-translate-y-px hover:bg-transparent active:scale-100 dark:hover:bg-transparent"
                        style={{ background: "linear-gradient(135deg,var(--brand-indigo),var(--cockpit-indigo))", boxShadow: "0 4px 12px rgba(91,84,232,.32)" }}
                    >
                        Ask
                        {sv(<><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>, 15)}
                    </Button>
                )}
            </form>

            {/* CHIPS */}
            {!hasMessages && (
                <div className="mt-4 flex flex-wrap justify-center gap-2.5">
                    {CHIPS.map((c) => (
                        <Button
                            key={c.label}
                            type="button"
                            variant="ghost"
                            onClick={() => submit(c.label)}
                            className="cockpit-chip flex h-auto items-center gap-[7px] rounded-[20px] border bg-white px-[15px] py-2 text-[13px] font-bold transition-all hover:-translate-y-px hover:bg-white active:scale-100 dark:hover:bg-white"
                            style={{ color: "var(--text-ink)", borderColor: "var(--border-light)", boxShadow: "0 2px 10px rgba(22,28,52,.05)" }}
                        >
                            <span className="flex" style={{ color: "var(--brand-indigo)" }}>{c.icon}</span>
                            {c.label}
                        </Button>
                    ))}
                </div>
            )}
        </>
    )
}
