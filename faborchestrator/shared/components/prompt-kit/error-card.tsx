"use client";

/**
 * Failure card — rendered in the chat whenever a tool call fails.
 *
 * WHY A CARD AND NOT JUST TEXT
 * ----------------------------
 * The failure text used to be written by the model, which meant it was
 * paraphrased, softened, and worded differently every run — and carried no way
 * to follow it up. This card is rendered from the `data-errorDetail` part the
 * server streams, so what you see is what was actually captured and stored.
 *
 * Nothing on this card is invented. Every line is a field that was really
 * observed; fields that were not observed are simply not shown. That is what
 * makes it work for failure modes nobody anticipated — there is no template to
 * fall through.
 *
 * The admin deep link is shown ONLY to admins. Everyone else gets the same
 * cause, the same expandable technical detail, and a copyable error id to hand
 * to an administrator — no dead link to a page they cannot open.
 */

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Copy, ExternalLink, Info } from "lucide-react";

export interface ErrorDetailData {
  errorId: string;
  type?: string;
  priority?: "HIGH" | "MEDIUM";
  at?: string;
  connector?: string;
  connectorUrl?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  name?: string;
  message?: string;
  code?: string;
  errno?: number;
  syscall?: string;
  httpStatus?: number;
  responseBody?: string;
  rpcCode?: number;
  rpcMessage?: string;
  causeChain?: string[];
  stack?: string;
  extra?: Record<string, unknown>;
  /** Identical failures collapsed into this one record (see groupFailures). */
  occurrences?: number;
  /** What each occurrence was fetching — e.g. dashboard panel labels. */
  affected?: string[];
  relatedErrorIds?: string[];
  /** The same tool succeeded later in the turn — the answer is complete. */
  recovered?: boolean;
}

/**
 * The admin console's origin. Configured per environment rather than guessed,
 * because Fab and Admin are separate deployments on different hosts.
 */

/** Readable names for the non-tool stages a failure can be recorded under. */
const STAGE_LABELS: Record<string, string> = {
  authorize: "access check",
  loadTools: "loading its tools",
  stepLimit: "step limit reached",
  outputLength: "reply length limit",
  contentFilter: "content filter",
  emptyAnswer: "no answer written",
  rememberServerChoice: "saving your server choice",
  persistAssistantMessage: "saving the reply",
};

/**
 * The line that tells the user what actually went wrong.
 *
 * Built from whatever the capture contains, preferring the deepest real text
 * over any summary — a wrapped fetch error says "fetch failed" at the top and
 * "ECONNREFUSED 10.10.1.109:1433" three levels down, and the second one is the
 * answer. Falls back through every field rather than to a canned sentence.
 */
function realCause(d: ErrorDetailData): string {
  const deepest = d.causeChain?.length ? d.causeChain[d.causeChain.length - 1] : undefined;
  return (
    d.rpcMessage ||
    deepest ||
    d.message ||
    d.responseBody ||
    d.name ||
    "No further detail was captured."
  );
}

/** Short technical tags — only those actually present. */
function signals(d: ErrorDetailData): string[] {
  const out: string[] = [];
  if (d.httpStatus) out.push(`HTTP ${d.httpStatus}`);
  if (d.code) out.push(d.code);
  if (d.syscall) out.push(`syscall ${d.syscall}`);
  if (typeof d.rpcCode === "number") out.push(`JSON-RPC ${d.rpcCode}`);
  if (d.name && d.name !== "Error") out.push(d.name);
  return out;
}

export function ErrorCard({
  detail,
  /**
   * Whether the viewer can actually open the admin console. Only admins get
   * the deep link: showing it to everyone sends a business user to a sign-in
   * page they cannot pass, which is worse than not offering it. Everyone can
   * still expand the full technical detail inline, below.
   */
  isAdmin = false,
}: {
  detail: ErrorDetailData;
  isAdmin?: boolean;
}) {
  /** Whether the card is expanded past its one-line resting state. */
  const [shown, setShown] = useState(false);
  /** Whether the full field-by-field capture is expanded, inside that. */
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const cause = realCause(detail);
  const tags = signals(detail);
  // Internal stage names are for the record; the card says them in words.
  const step = detail.toolName ? (STAGE_LABELS[detail.toolName] ?? detail.toolName) : undefined;
  const where = detail.connector
    ? `“${detail.connector}”${step ? ` · ${step}` : ""}`
    : (step ?? "A data source");
  // One card for N identical failures — say how many, so "8 panels down for
  // one reason" reads as one fact rather than as eight separate tiles.
  const occ = detail.occurrences ?? 1;
  const count = occ > 1 ? ` — ${occ} queries, same cause` : "";

  /*
   * RECOVERED vs BLOCKING.
   *
   * A failure the model corrected course on — a probe query the database
   * rejected, then re-run with the right columns — is real and is recorded,
   * but the answer above it is complete. Rendering it in amber under a
   * finished dashboard says "something is wrong" when nothing is. So a
   * recovered failure is a quiet grey note; only a failure that actually
   * cost the user their answer is a warning.
   */
  const recovered = detail.recovered === true;
  const tone = recovered
    ? "border-border bg-muted/40"
    : "border-amber-500/40 bg-amber-500/5";
  const Icon = recovered ? Info : AlertTriangle;
  const iconTone = recovered ? "text-muted-foreground" : "text-amber-600";
  const headline = recovered
    ? `${where} hit an error on the way to this answer and recovered${count} — the result above is complete.`
    : `${where} couldn’t complete this request${count}.`;
  const expandedHeadline = recovered
    ? `${where} failed once and was retried successfully${count}.`
    : `${where} did not return an answer${count}.`;

  const href =
    isAdmin
      ? `/admin/errors/${encodeURIComponent(detail.errorId)}`
      : null;

  const copyId = () => {
    navigator.clipboard.writeText(detail.errorId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  /*
   * COLLAPSED BY DEFAULT.
   *
   * The card used to open with the raw cause on display. That is the right
   * thing when someone is debugging, and the wrong thing in the middle of a
   * conversation: a database error is not what the reader asked for, and it
   * dominated the transcript every time one occurred.
   *
   * So the resting state is one quiet line saying which system failed, with a
   * button. Everything else — the cause, the codes, the ids, the full capture
   * — is one click away and unchanged.
   */
  if (!shown) {
    return (
      <div
        role={recovered ? "note" : "alert"}
        className={`my-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${tone}`}
        data-testid="chat-error-card"
        data-recovered={recovered ? "true" : undefined}
      >
        <Icon className={`h-4 w-4 shrink-0 ${iconTone}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{headline}</span>
          {/* The cause itself, without a click: "couldn't complete" alone left
              the reader to open the card to learn anything. A recovered
              failure stays a quiet one-liner. */}
          {!recovered && cause && cause !== "No further detail was captured." && (
            <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{cause}</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => setShown(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent"
        >
          <ChevronRight className="h-3.5 w-3.5" />
          {recovered ? "Details" : "Show error"}
        </button>
      </div>
    );
  }

  return (
    <div
      role={recovered ? "note" : "alert"}
      className={`my-3 rounded-lg border p-3 text-sm ${tone}`}
      data-testid="chat-error-card"
      data-recovered={recovered ? "true" : undefined}
    >
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconTone}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">{expandedHeadline}</p>
            <button
              type="button"
              onClick={() => {
                setShown(false);
                setOpen(false);
              }}
              className="shrink-0 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
            >
              Hide
            </button>
          </div>

          {/* The real reason — verbatim, never reworded. */}
          <p className="mt-1 break-words text-muted-foreground">{cause}</p>

          {detail.affected && detail.affected.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Affected: {detail.affected.join(" · ")}
            </p>
          )}

          {tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <span
                  key={t}
                  className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View error details
              </a>
            )}

            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent"
              aria-expanded={open}
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {open ? "Hide" : "Show"} technical detail
            </button>

            <button
              type="button"
              onClick={copyId}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 font-mono text-[11px] text-muted-foreground hover:bg-accent"
              title={
                isAdmin
                  ? "Copy the error ID"
                  : "Copy this ID and send it to your administrator — they can open the full record with it"
              }
            >
              <Copy className="h-3 w-3" />
              {copied ? "copied" : detail.errorId.slice(0, 8)}
            </button>
          </div>

          {open && (
            <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
              {/* Rendered from the capture itself, so unforeseen fields show up
                  without this component knowing about them in advance. */}
              {Object.entries(detail)
                .filter(([k, v]) => k !== "errorId" && v !== null && v !== undefined && v !== "")
                .map(([k, v]) => {
                  const text =
                    typeof v === "string"
                      ? v
                      : Array.isArray(v)
                        ? v.join("\n")
                        : typeof v === "object"
                          ? JSON.stringify(v, null, 2)
                          : String(v);
                  const block = text.includes("\n") || text.length > 100;
                  return (
                    <div key={k}>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {k}
                      </div>
                      {block ? (
                        <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-2 text-[11px]">
                          {text}
                        </pre>
                      ) : (
                        <div className="mt-0.5 break-all font-mono text-xs">{text}</div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Pull every `data-errorDetail` payload out of a message's parts. */
export function errorDetailsFromParts(parts: unknown): ErrorDetailData[] {
  if (!Array.isArray(parts)) return [];
  const seen = new Set<string>();
  /*
   * Grouped by cause, not just deduped by id. The server already collapses
   * identical dashboard failures, but a model that retries a failing tool, or
   * a transcript saved before that change, can still carry the same failure
   * several times — and eight tiles for one fact is what this prevents.
   */
  const byCause = new Map<string, ErrorDetailData>();
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type !== "data-errorDetail") continue;
    const data = p.data as ErrorDetailData | undefined;
    if (!data?.errorId || seen.has(data.errorId)) continue;
    seen.add(data.errorId);
    const key = `${data.connector ?? ""}::${(data.rpcMessage || data.message || data.responseBody || data.name || "").slice(0, 300)}`;
    const prior = byCause.get(key);
    if (!prior) {
      byCause.set(key, { ...data });
      continue;
    }
    prior.occurrences = (prior.occurrences ?? 1) + (data.occurrences ?? 1);
    // Recovered only if every occurrence recovered; one blocking failure wins.
    prior.recovered = prior.recovered === true && data.recovered === true;
    if (data.affected?.length) prior.affected = [...(prior.affected ?? []), ...data.affected];
    prior.relatedErrorIds = [...(prior.relatedErrorIds ?? []), data.errorId, ...(data.relatedErrorIds ?? [])];
  }
  return [...byCause.values()];
}

/**
 * Build a card payload from a stream-level error MESSAGE.
 *
 * Tool failures arrive as structured `data-errorDetail` parts. Stream-level
 * failures — the provider rejecting the request, a timeout, a bad key — cannot:
 * the UI stream is erroring, so there is nothing left to write a data part to.
 * All that reaches the client is the text the route returned.
 *
 * That text carries the real cause and `(errorId=…)`, because the route now
 * composes it from the same capture that was written to error_audit_logs. So
 * we parse those two pieces back out and render the SAME card, rather than
 * leaving the most common failure class looking different from every other one.
 *
 * Returns null when the text has no error id — i.e. it did not come from our
 * capture — so genuinely unknown errors still fall back to the plain banner.
 */
/**
 * A request the API refused before any reply began — expired session, invalid
 * model, rate limit, server error. The chat SDK surfaces the raw response body
 * as the error text, so without this the user saw a JSON blob. Returns the
 * envelope's own human message and id.
 */
export function requestErrorFromText(
  text: string | undefined | null,
): { message: string; errorId?: string; type?: string } | null {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const body = JSON.parse(text.slice(start)) as { error?: unknown; message?: unknown };
    const e = body.error;
    if (e && typeof e === "object") {
      const o = e as { message?: unknown; errorId?: unknown; type?: unknown };
      if (typeof o.message === "string" && o.message.trim()) {
        return {
          message: o.message,
          errorId: typeof o.errorId === "string" ? o.errorId : undefined,
          type: typeof o.type === "string" ? o.type : undefined,
        };
      }
    }
    if (typeof e === "string" && e.trim()) return { message: e };
    if (typeof body.message === "string" && body.message.trim()) return { message: body.message };
  } catch {
    /* not JSON — the caller shows the text as it is */
  }
  return null;
}

export function errorDetailFromText(text: string | undefined | null): ErrorDetailData | null {
  if (!text) return null;
  const m = /\(errorId=([0-9a-f-]{36})\)/i.exec(text);
  if (!m) return null;
  const message = text.replace(m[0], "").trim();
  const status = /\bHTTP (\d{3})\b/.exec(message);
  return {
    errorId: m[1],
    message: message || "The request failed.",
    httpStatus: status ? Number(status[1]) : undefined,
  };
}

/**
 * The failures a given viewer should see.
 *
 * A RECOVERED failure — the agent hit an error, corrected course and still
 * delivered the answer — is shown to admins only. It is useful to someone
 * tuning prompts (the agent wasted a query on a bad guess) and noise to a
 * business user, who got their answer and has nothing to act on. Blocking
 * failures are shown to everyone. The record is written either way.
 */
export function visibleErrorDetails(parts: unknown, isAdmin: boolean): ErrorDetailData[] {
  return errorDetailsFromParts(parts).filter((d) => isAdmin || d.recovered !== true);
}
