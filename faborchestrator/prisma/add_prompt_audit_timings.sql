-- REQ-04 — per-request timing breakdown on the prompt audit log.
--
-- Additive and idempotent: safe to run more than once, and safe to run while
-- both apps are live. Until it HAS been run, the apps still work — the write is
-- a separate best-effort statement (lib/ai/prompt-audit.ts recordPromptTimings),
-- so a missing column costs the timings, never the audit row.
--
--   psql "$DATABASE_URL" -f prisma/add_prompt_audit_timings.sql
--
-- Shape of the stored JSON (see faborchestrator/lib/perf-timer.ts):
--   totalMs        end-to-end, from handler entry
--   ttftMs         time to first token — what the user reads as "it started"
--   streamMs       first token -> last token
--   phases         { auth, parseBody, registryRates, mcpToolLoad, step:<tools>, ... }
--   toolWaitedMs   what the turn really waited on tools (sum of per-step slowest)
--   toolSerialMs   what those tools would have cost run one after another
--   toolBlockingMs straggler wait: finished tools idling on their slowest sibling
--   toolDetail     [{ name, ms, ok, step }]  per tool call
--   slowest        the five most expensive phases, worst first

ALTER TABLE "prompt_audit_logs" ADD COLUMN IF NOT EXISTS "timings" jsonb;

-- Reach for the slow turns first. Partial, so it stays small: rows without
-- timings (pre-migration, or a failed write) are not worth indexing.
CREATE INDEX IF NOT EXISTS prompt_audit_logs_ttft_idx
  ON "prompt_audit_logs" ((("timings" ->> 'ttftMs')::numeric) DESC)
  WHERE "timings" IS NOT NULL;
