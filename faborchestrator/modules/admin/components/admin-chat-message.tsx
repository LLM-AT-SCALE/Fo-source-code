"use client";

/**
 * One message in the Admin Console chat.
 *
 * Built from the SAME prompt-kit blocks as the Fab AI chat
 * (modules/support-engineer/components/full-chat-app.tsx) so the two read
 * identically: Message / MessageContent for layout, StreamingText for prose,
 * ToolTimeline for the "working…" row, Reasoning for extended thinking,
 * ErrorCard for captured failures and MessageActionBar for Copy. Nothing here
 * is a fork of those blocks — this file only decides what the admin surface
 * adds on top: the consent gates, the Secure Upload hand-off and the two
 * interactive forms the admin system prompt can emit.
 */

import { Fragment, useMemo, useState } from "react";
import type { UIMessage } from "ai";
import { motion } from "motion/react";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/shared/components/ui/button";
import { Message, MessageContent } from "@/shared/components/prompt-kit/message";
import { StreamingText } from "@/shared/components/prompt-kit/streaming-text";
import { Loader } from "@/shared/components/prompt-kit/loader";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/shared/components/prompt-kit/reasoning";
import { TextShimmer } from "@/shared/components/prompt-kit/text-shimmer";
import { ToolTimeline } from "@/shared/components/prompt-kit/tool-timeline";
import { extractToolParts, type ToolPart } from "@/shared/components/prompt-kit/tool";
import { ErrorCard, visibleErrorDetails } from "@/shared/components/prompt-kit/error-card";
import { MessageActionBar } from "@/shared/components/prompt-kit/message-action-bar";
import { ReportScheduleCard, type ScheduleFormInitial } from "@/modules/admin/components/report-schedule-card";
import { AlertThresholdCard, type AlertThresholdInitial } from "@/modules/admin/components/alert-threshold-card";

// ── Admin markers ──
//
// The two admin gates render their acknowledgement checkbox + action button(s)
// as ONE interactive control (ConsentGate). We strip the corresponding lines
// from the markdown so they aren't duplicated, and render the gate only on the
// latest, idle message. The action button is DISABLED until the admin ticks the
// checkbox — so consent is mandatory. Clicking an action just does what the
// admin would otherwise do (send a reply / open Secure Upload); the flow is
// unchanged.
//   • Step-0 consent gate  → "I confirm…" checkbox + [Cancel] [Proceed with Connection]
//   • Requirements listing → "I have read…" checkbox + [Secure Upload]
const CONSENT_BUTTONS_RE =
  /\n?[ \t]*>?[ \t]*\[\s*Cancel\s*\][\s>]*\[\s*Proceed with Connection\s*\][ \t]*/i;
// Acknowledgement checkbox lines (may be a `- [ ]` task item inside a blockquote).
const CONFIRM_ACK_RE =
  /\n?[ \t]*>?[ \t]*(?:[-*][ \t]*)?\[[ xX]?\]\s*I confirm that I am authorized to connect this data source and accept the security risks\.?[ \t]*/i;
const READ_ACK_RE =
  /\n?[ \t]*>?[ \t]*(?:[-*][ \t]*)?\[[ xX]?\]\s*I have read, understood, and accept the terms and security risks outlined above\.?[ \t]*/i;
const CONFIRM_ACK_TEXT = "I confirm that I am authorized to connect this data source and accept the security risks.";
const READ_ACK_TEXT = "I have read, understood, and accept the terms and security risks outlined above.";
// Report-schedule form marker: the model emits [[schedule-form: {json}]] which
// the UI turns into an interactive form (and strips from the rendered text).
const SCHEDULE_FORM_RE = /\[\[schedule-form:\s*(\{[\s\S]*?\})\s*\]\]/i;
// Alert-threshold form marker: [[alert-threshold: {json}]] → interactive form.
const ALERT_THRESHOLD_RE = /\[\[alert-threshold:\s*(\{[\s\S]*?\})\s*\]\]/i;
// Hidden data-source id the UI attaches to the "saved the connection details"
// message so the assistant can act on it; the admin never sees it.
const DSID_RE = /\s*\[\[dsid:[^\]]+\]\]\s*/g;

/** Strip every admin-only marker so the prose reads clean. */
function cleanAdminText(text: string): string {
  return text
    .replace(CONSENT_BUTTONS_RE, "")
    .replace(CONFIRM_ACK_RE, "")
    .replace(READ_ACK_RE, "")
    .replace(SCHEDULE_FORM_RE, "")
    .replace(ALERT_THRESHOLD_RE, "")
    .replace(/\n\s*>?\s*$/, "")
    .trimEnd();
}

function parseFormMarker<T>(re: RegExp, text: string): T | null {
  const m = re.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as T;
  } catch {
    return {} as T; // malformed JSON → empty form, admin fills it
  }
}

// ── Segments ──
//
// A turn is a loop — text, tool, text, tool — and the message renders in that
// order, exactly as the Fab chat does, so the "working…" row sits where the
// work actually happened instead of being hoisted to the top.
type Segment =
  | { type: "text"; content: string }
  | { type: "tools"; content: ToolPart[] };

function segmentParts(parts: unknown[]): Segment[] {
  const out: Segment[] = [];
  const seen = new Set<string>();
  let text = "";
  let run: ToolPart[] = [];

  const flushText = () => {
    if (text.trim()) out.push({ type: "text", content: text.trim() });
    text = "";
  };
  const flushTools = () => {
    if (run.length > 0) out.push({ type: "tools", content: run });
    run = [];
  };

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const type = p.type as string | undefined;
    if (!type) continue;

    if (type === "text" && typeof p.text === "string") {
      flushTools();
      text += (text ? "\n\n" : "") + p.text;
    } else if (type === "step-start") {
      // Step boundary: keep the text on either side of it apart, but let tool
      // calls across consecutive steps group into one row.
      flushText();
    } else if (type.startsWith("tool-")) {
      flushText();
      for (const tool of extractToolParts([part])) {
        const id = tool.toolCallId || tool.type;
        if (seen.has(id)) continue;
        seen.add(id);
        run.push(tool);
      }
    }
    // reasoning parts are rendered separately, above the prose
  }
  flushText();
  flushTools();
  return out;
}

function reasoningText(parts: unknown[]): string {
  return parts
    .filter((p): p is { type: string; text?: string } => !!p && typeof p === "object" && (p as { type?: string }).type === "reasoning")
    .map((p) => p.text || "")
    .filter(Boolean)
    .join("\n\n");
}

/** Plain text of a message — what Copy puts on the clipboard. */
export function messageText(message: UIMessage): string {
  return (message.parts || [])
    .filter((p) => p.type === "text")
    .map((p) => ("text" in p ? p.text : ""))
    .join("")
    .replace(DSID_RE, " ")
    .trim();
}

// ── Tool group ──
//
// Exactly the Fab AI chat's indicator: the shared ToolTimeline row ("Looking up
// users … 1.2s"), nothing else.
function AdminToolGroup({ tools, isStreaming }: { tools: ToolPart[]; isStreaming: boolean }) {
  return <ToolTimeline tools={tools} isStreaming={isStreaming} />;
}

// ── Consent gate ──
//
// A checkbox the admin MUST tick before the action button(s) enable. Local state.
function ConsentGate({
  checkboxLabel,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  hint = "Please tick the box above to continue.",
  active = true,
  initiallyChecked = false,
}: {
  checkboxLabel: string;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  hint?: string;
  /** True on the current step (interactive). Historical steps render the
   *  checkbox read-only and hide the action buttons, but the checked state is
   *  retained so past acknowledgements stay visibly checked in the chat. */
  active?: boolean;
  /** Initial checkbox state. Past (superseded) steps mount already-checked
   *  (the flow only advanced because the box was ticked); the live step starts
   *  UNCHECKED so the admin must tick it before the action button enables. */
  initiallyChecked?: boolean;
}) {
  const [checked, setChecked] = useState(initiallyChecked);
  return (
    <div className="mt-1 space-y-2 px-4">
      <label className={`flex items-start gap-2 text-sm${active ? " cursor-pointer" : ""}`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          disabled={!active}
          className="mt-0.5 h-4 w-4 shrink-0 rounded-[4px] border border-input accent-primary disabled:cursor-default disabled:opacity-100"
        />
        <span>{checkboxLabel}</span>
      </label>
      {active && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {secondaryLabel && onSecondary && (
              <Button variant="outline" size="sm" onClick={onSecondary}>
                {secondaryLabel}
              </Button>
            )}
            <Button
              size="sm"
              onClick={onPrimary}
              disabled={!checked}
              aria-disabled={!checked}
              title={!checked ? hint : undefined}
            >
              {primaryLabel}
            </Button>
          </div>
          {!checked && <p className="text-xs text-muted-foreground">{hint}</p>}
        </>
      )}
    </div>
  );
}

// ── Message ──

export interface AdminChatMessageProps {
  message: UIMessage;
  index: number;
  isLast: boolean;
  /** The request is in flight (submitted or streaming). */
  isLoading: boolean;
  /** Streaming pulse-dot after the last user message while the reply has not started. */
  showWaitingIndicator?: boolean;
  token: string | null;
  onConsent: (text: string) => void;
  onSecureUpload: () => void;
  onScheduleDone: (summary: string | null) => void;
  onAlertDone: (summary: string | null) => void;
}

export function AdminChatMessage({
  message,
  index,
  isLast,
  isLoading,
  showWaitingIndicator = false,
  token,
  onConsent,
  onSecureUpload,
  onScheduleDone,
  onAlertDone,
}: AdminChatMessageProps) {
  const isAssistant = message.role === "assistant";
  const isStreaming = isLoading && isLast && isAssistant;
  const parts = useMemo(() => (Array.isArray(message.parts) ? message.parts : []), [message.parts]);
  const plainText = messageText(message);

  // Assistant-only derivations. Cheap, but keyed on parts so a long table is
  // not re-segmented on every unrelated render.
  const segments = useMemo(() => (isAssistant ? segmentParts(parts) : []), [isAssistant, parts]);
  const reasoning = isAssistant ? reasoningText(parts) : "";
  const errors = isAssistant ? visibleErrorDetails(parts, true) : [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring" as const, stiffness: 200, damping: 25, delay: index * 0.02 }}
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
          <div className="group min-w-0 flex-1">
            {reasoning && (
              <Reasoning isStreaming={isStreaming}>
                <ReasoningTrigger>
                  {isStreaming ? <TextShimmer duration={2}>Thinking</TextShimmer> : "Thinking"}
                </ReasoningTrigger>
                <ReasoningContent
                  markdown
                  className="ml-2 border-l-2 border-l-slate-200 px-2 pb-1 dark:border-l-slate-700"
                >
                  {reasoning}
                </ReasoningContent>
              </Reasoning>
            )}

            {segments.length === 0 ? (
              // Nothing to show yet: the reply is on its way (or was empty).
              isStreaming ? (
                <MessageContent role="assistant">
                  <Loader variant="pulse-dot" size="md" className="justify-start" />
                </MessageContent>
              ) : null
            ) : (
              segments.map((segment, segIndex) => {
                const isLastSegment = segIndex === segments.length - 1;
                if (segment.type === "tools") {
                  return (
                    <AdminToolGroup key={`tools-${segIndex}`} tools={segment.content} isStreaming={isStreaming} />
                  );
                }
                const cleaned = cleanAdminText(segment.content);
                if (!cleaned.trim()) return <Fragment key={`text-${segIndex}`} />;
                return (
                  <MessageContent key={`text-${segIndex}`} role="assistant">
                    <StreamingText
                      content={cleaned}
                      isStreaming={isStreaming && isLastSegment}
                      markdown
                      charsPerTick={4}
                      cursorStyle="pulse-dot"
                      showCursor={isStreaming && isLastSegment}
                    />
                  </MessageContent>
                );
              })
            )}

            {/* Admin gates and forms — derived from the FULL text so a marker
                split across segments still counts. Mounted for past steps too
                (read-only) so a ticked acknowledgement stays visible in history. */}
            {!isStreaming && (() => {
              const isConsentGate = CONSENT_BUTTONS_RE.test(plainText) || CONFIRM_ACK_RE.test(plainText);
              const isRequirements = !isConsentGate && READ_ACK_RE.test(plainText);
              const showGate = isLast && !isLoading;
              const scheduleInitial = parseFormMarker<ScheduleFormInitial>(SCHEDULE_FORM_RE, plainText);
              const alertInitial = parseFormMarker<AlertThresholdInitial>(ALERT_THRESHOLD_RE, plainText);
              return (
                <>
                  {isConsentGate && (
                    <ConsentGate
                      active={showGate}
                      initiallyChecked={!isLast}
                      checkboxLabel={CONFIRM_ACK_TEXT}
                      primaryLabel="Proceed with Connection"
                      onPrimary={() => onConsent("Proceed with Connection")}
                      secondaryLabel="Cancel"
                      onSecondary={() => onConsent("Cancel")}
                      hint="Please confirm the box above to proceed with the connection."
                    />
                  )}
                  {isRequirements && (
                    <ConsentGate
                      active={showGate}
                      initiallyChecked={!isLast}
                      checkboxLabel={READ_ACK_TEXT}
                      primaryLabel="🛡️ Secure Upload"
                      onPrimary={onSecureUpload}
                      hint="Please tick the box above, then upload your credentials securely."
                    />
                  )}
                  {scheduleInitial && (
                    <div className="px-4">
                      <ReportScheduleCard initial={scheduleInitial} active={showGate} token={token} onDone={onScheduleDone} />
                    </div>
                  )}
                  {alertInitial && (
                    <div className="px-4">
                      <AlertThresholdCard initial={alertInitial} active={showGate} token={token} onDone={onAlertDone} />
                    </div>
                  )}
                </>
              );
            })()}

            {/* Captured failures, rendered from streamed `data-errorDetail`
                parts — the cause shown is the one that was actually recorded. */}
            {errors.map((detail) => (
              <ErrorCard key={detail.errorId} detail={detail} isAdmin />
            ))}

            <MessageActionBar
              messageId={message.id}
              role="assistant"
              text={cleanAdminText(plainText)}
              visible={!isStreaming}
              className={cn(
                "-ml-2.5 mt-1 flex gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100",
                isLast && "opacity-100"
              )}
              isAdmin
              errorId={errors[0]?.errorId ?? null}
            />
          </div>
        ) : (
          <div className="group max-w-[85%] sm:max-w-[75%]">
            <MessageContent role="user" className="inline-block w-fit max-w-full whitespace-pre-wrap">
              {plainText}
            </MessageContent>
            <MessageActionBar
              messageId={message.id}
              role="user"
              text={plainText}
              visible={!isLoading}
              className="mr-1 mt-1 flex justify-end gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            />
          </div>
        )}
      </Message>

      {/* Pulse-dot after the question while the reply has not started. */}
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
  );
}
