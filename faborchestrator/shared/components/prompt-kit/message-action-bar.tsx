"use client";

/**
 * Message action bar — copy, edit, delete, rate, and view the error log.
 *
 * WHY THIS IS SHARED
 * ------------------
 * The three chat surfaces (Fab chat, Modeling Agent, Coding Agent) each had
 * their own hand-rolled row of buttons, and in all three only Copy did
 * anything — Edit, Delete and the thumbs were decorative, with no click
 * handler and no endpoint behind them. Fixing that in three places would have
 * produced three subtly different behaviours, so the behaviour lives here once
 * and each surface passes in what it needs.
 *
 * Every control gives feedback, is reachable by keyboard, and states plainly
 * what it did or why it failed. Nothing fails silently.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Loader2, Pencil, ThumbsDown, ThumbsUp, Trash, TriangleAlert } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { MessageAction, MessageActions } from "@/shared/components/prompt-kit/message";
import { cn } from "@/shared/lib/utils";

export type Feedback = "up" | "down" | null;

export interface MessageActionBarProps {
  messageId: string;
  role: "user" | "assistant";
  /** Plain text of the message, used for Copy. */
  text: string;
  /** Hide while a response is streaming. */
  visible?: boolean;
  className?: string;

  /** Enables Edit (user messages). Omit to hide the control. */
  onEdit?: () => void;
  /** Enables Delete. Receives the id; should perform the delete. */
  onDelete?: (messageId: string) => Promise<void>;
  /** Enables rating (assistant messages). */
  onFeedback?: (messageId: string, feedback: Feedback) => Promise<void>;
  /** Current rating, so it survives a reload. */
  feedback?: Feedback;

  /**
   * Error id for this turn, when it failed. Shows "View error log", which opens
   * the full record in the admin console. Absent on successful turns — the
   * control never appears unless there is something to look at.
   */
  errorId?: string | null;
  /** Only admins can open the console, so only admins are offered the link. */
  isAdmin?: boolean;
}

const ICON_BTN = "h-8 w-8 rounded-none border-0 bg-transparent p-0 hover:bg-transparent";

export function MessageActionBar({
  messageId,
  role,
  text,
  visible = true,
  className,
  onEdit,
  onDelete,
  onFeedback,
  feedback = null,
  errorId,
  isAdmin = false,
}: MessageActionBarProps) {
  const [copied, setCopied] = useState(false);
  const [rating, setRating] = useState<Feedback>(feedback);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Keep in step when the message reloads with a stored rating.
  useEffect(() => setRating(feedback), [feedback]);

  if (!visible) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — your browser blocked clipboard access.");
    }
  };

  const rate = async (next: Exclude<Feedback, null>) => {
    if (!onFeedback || ratingBusy) return;
    // Clicking the active rating clears it, so a misclick is recoverable.
    const value: Feedback = rating === next ? null : next;
    const previous = rating;
    setRating(value); // optimistic
    setRatingBusy(true);
    try {
      await onFeedback(messageId, value);
    } catch {
      setRating(previous); // put it back — never show a rating that did not save
      toast.error("Could not save your feedback. Please try again.");
    } finally {
      setRatingBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete(messageId);
      setConfirmOpen(false);
      toast.success(role === "user" ? "Message and its reply deleted" : "Message deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the message.");
    } finally {
      setDeleting(false);
    }
  };

  const errorHref =
    isAdmin && errorId
      ? `/admin/errors/${encodeURIComponent(errorId)}`
      : null;

  return (
    <>
      <MessageActions className={className}>
        {onEdit && (
          <MessageAction tooltip="Edit" delayDuration={100}>
            <Button variant="ghost" size="icon" className={ICON_BTN} onClick={onEdit} aria-label="Edit message">
              <Pencil />
            </Button>
          </MessageAction>
        )}

        {onDelete && (
          <MessageAction tooltip="Delete" delayDuration={100}>
            <Button
              variant="ghost"
              size="icon"
              className={ICON_BTN}
              onClick={() => setConfirmOpen(true)}
              aria-label="Delete message"
            >
              <Trash />
            </Button>
          </MessageAction>
        )}

        <MessageAction tooltip={copied ? "Copied" : "Copy"} delayDuration={100}>
          <Button variant="ghost" size="icon" className={ICON_BTN} onClick={copy} aria-label="Copy message">
            {copied ? <Check className="text-emerald-600" /> : <Copy />}
          </Button>
        </MessageAction>

        {onFeedback && (
          <>
            <MessageAction tooltip={rating === "up" ? "Remove rating" : "Good response"} delayDuration={100}>
              <Button
                variant="ghost"
                size="icon"
                className={cn(ICON_BTN, rating === "up" && "text-emerald-600")}
                onClick={() => rate("up")}
                disabled={ratingBusy}
                aria-pressed={rating === "up"}
                aria-label="Good response"
              >
                <ThumbsUp className={cn(rating === "up" && "fill-current")} />
              </Button>
            </MessageAction>
            <MessageAction tooltip={rating === "down" ? "Remove rating" : "Bad response"} delayDuration={100}>
              <Button
                variant="ghost"
                size="icon"
                className={cn(ICON_BTN, rating === "down" && "text-destructive")}
                onClick={() => rate("down")}
                disabled={ratingBusy}
                aria-pressed={rating === "down"}
                aria-label="Bad response"
              >
                <ThumbsDown className={cn(rating === "down" && "fill-current")} />
              </Button>
            </MessageAction>
          </>
        )}

        {/* Only rendered when this turn actually failed. */}
        {errorHref && (
          <MessageAction tooltip="View error log" delayDuration={100}>
            <Button
              variant="ghost"
              size="icon"
              className={cn(ICON_BTN, "text-amber-600")}
              asChild
              aria-label="View error log"
            >
              <a href={errorHref} target="_blank" rel="noopener noreferrer">
                <TriangleAlert />
              </a>
            </Button>
          </MessageAction>
        )}
      </MessageActions>

      {/* Delete confirmation — destructive and irreversible, so never one click. */}
      <Dialog open={confirmOpen} onOpenChange={(o) => !deleting && setConfirmOpen(o)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Delete this message?</DialogTitle>
            <DialogDescription>
              {role === "user"
                ? "This removes your message and the response it produced. This cannot be undone."
                : "This removes this response. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-28 overflow-auto rounded-md bg-muted p-3 text-sm text-muted-foreground">
            {text.trim().slice(0, 300) || "(no text content)"}
            {text.trim().length > 300 && "…"}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Inline editor shown in place of a user message bubble.
 *
 * Deliberately edits where the message sits rather than in a modal: the point
 * of an edit is to adjust the question in context, and a dialog hides the
 * conversation it belongs to.
 */
export function InlineMessageEditor({
  initialText,
  busy,
  onSave,
  onCancel,
}: {
  initialText: string;
  busy?: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, []);

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  };

  const changed = value.trim() !== initialText.trim();
  const valid = value.trim().length > 0;

  return (
    <div className="w-full rounded-2xl border border-border bg-background p-2">
      <textarea
        ref={ref}
        value={value}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          grow(e.target);
        }}
        onKeyDown={(e) => {
          // Enter saves, Shift+Enter is a newline, Escape cancels — the same
          // contract as the composer below it.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (valid && changed) onSave(value.trim());
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={1}
        className="w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
        aria-label="Edit your message"
      />
      <div className="mt-1 flex items-center justify-between gap-2 px-1">
        <span className="text-xs text-muted-foreground">
          Saving replaces the answer below it.
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onSave(value.trim())}
            disabled={busy || !valid || !changed}
          >
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Save &amp; resend
          </Button>
        </div>
      </div>
    </div>
  );
}
