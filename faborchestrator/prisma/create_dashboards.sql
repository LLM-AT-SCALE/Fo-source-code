-- FabInsight rearchitecture: dashboard requests, dashboards, versions, compile jobs.
-- Additive + idempotent. Run directly against claude_ai_athena (shared DB).
-- NEVER `prisma db push` (would drop tables the admin app / other apps own).
--
-- Flow: a user pins a chat dashboard -> dashboard_requests (Fab AI writes).
-- Admin approves -> dashboard_compile_jobs (admin writes, Fab AI tick claims).
-- Compiler produces a replay program -> admin go-live -> dashboards +
-- dashboard_versions (admin writes). Scheduler replays the current version
-- through the MCP client and stores the snapshot on dashboards (Fab AI writes).

-- 1. Pin requests --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_requests (
  id                  TEXT PRIMARY KEY,
  requester_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id     TEXT,
  message_id          TEXT,
  artifact_identifier TEXT,
  title               TEXT NOT NULL,
  reason              TEXT NOT NULL,
  html                TEXT NOT NULL,
  kpis                JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{label, ...}] extracted from the HTML
  trace               JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ordered MCP calls {seq, connectionId, registryId, serverUrl, toolName, args, result}
  -- requested | approved | denied | compiling | compile_failed | preview_ready | live | cancelled
  status              TEXT NOT NULL DEFAULT 'requested',
  -- {mode:'create'|'extend', targetDashboardId?, connectionScope, schedule, expiresAt, decidedById, note}
  decision            JSONB,
  decided_by_id       TEXT,
  decided_at          TIMESTAMPTZ,
  dashboard_id        TEXT,                                  -- set at go-live (dashboards.id)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboard_requests_status_idx    ON dashboard_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS dashboard_requests_requester_idx ON dashboard_requests (requester_id);

-- 2. Dashboards (replaces pinned_dashboards; the old table stays one release) --
CREATE TABLE IF NOT EXISTS dashboards (
  id                  TEXT PRIMARY KEY,
  -- Stable key used by report_schedules.dashboard_id, alert_thresholds.dashboard_id,
  -- shift_summaries.dashboard_ids. Seeded dashboards keep their legacy ids.
  slug                TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'custom',        -- seeded | custom
  status              TEXT NOT NULL DEFAULT 'live',          -- live | paused | expired
  current_version_id  TEXT,
  kpis                JSONB NOT NULL DEFAULT '[]'::jsonb,
  visible_to_all      BOOLEAN NOT NULL DEFAULT false,
  visibility_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- {mode:'fixed', servers:[{registryId, serverUrl}]} | {mode:'all'}
  connection_scope    JSONB NOT NULL DEFAULT '{"mode":"all"}'::jsonb,
  expires_at          TIMESTAMPTZ,
  expiry_warned_at    TIMESTAMPTZ,
  source_request_id   TEXT,
  created_by_id       TEXT NOT NULL,
  requester_id        TEXT,
  -- snapshot (written by the Fab AI scheduler)
  metric_columns      JSONB NOT NULL DEFAULT '[]'::jsonb,
  cached_html         TEXT,
  cached_summary      TEXT,
  cached_sets         JSONB,
  refreshed_at        TIMESTAMPTZ,
  last_status         TEXT,
  per_server_status   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboards_status_idx     ON dashboards (status);
CREATE INDEX IF NOT EXISTS dashboards_expires_at_idx ON dashboards (expires_at);

-- 3. Versions (one row per go-live / rollback target) -------------------------
CREATE TABLE IF NOT EXISTS dashboard_versions (
  id                  TEXT PRIMARY KEY,
  dashboard_id        TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  version_no          INTEGER NOT NULL,
  program             JSONB NOT NULL,                        -- replay program (programVersion 1)
  template_html       TEXT NOT NULL,                         -- captured HTML with data-fab-* markers
  kpis                JSONB NOT NULL DEFAULT '[]'::jsonb,
  connection_scope    JSONB NOT NULL DEFAULT '{"mode":"all"}'::jsonb,
  refine_history      JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{instruction, jobId, at, by}]
  created_from_job_id TEXT,
  approved_by_id      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dashboard_id, version_no)
);

-- 4. Compile jobs (admin inserts, Fab AI scheduler tick claims) ----------------
CREATE TABLE IF NOT EXISTS dashboard_compile_jobs (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,                         -- create | extend | refine
  request_id          TEXT REFERENCES dashboard_requests(id) ON DELETE CASCADE,
  dashboard_id        TEXT,                                  -- extend/refine target
  base_version_id     TEXT,                                  -- version to start from (extend/refine)
  instruction         TEXT,                                  -- admin refine text
  connection_scope    JSONB NOT NULL DEFAULT '{"mode":"all"}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'queued',        -- queued | claimed | preview_ready | failed
  attempts            INTEGER NOT NULL DEFAULT 0,
  claimed_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  result_program      JSONB,
  result_template     TEXT,
  result_html         TEXT,
  result_kpis         JSONB,
  result_notes        JSONB,
  usage               JSONB,                                 -- token usage / cost of the compile
  error               TEXT,
  created_by_id       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboard_compile_jobs_status_idx ON dashboard_compile_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS dashboard_compile_jobs_request_idx ON dashboard_compile_jobs (request_id);
CREATE INDEX IF NOT EXISTS dashboard_compile_jobs_dashboard_idx ON dashboard_compile_jobs (dashboard_id);

-- 5. Sticky MCP server choice for the multi-server chat rules ------------------
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS selected_connection_id TEXT;

-- 6. Alert thresholds from the SQL era used curated metric keys (e.g.
-- 'equipment_idle_pct') that no longer resolve: every metric is now
-- custom:<dashboard slug>:<set>:<column> on a live dashboard. Pause them so the
-- admin app shows them as legacy instead of silently never firing.
UPDATE alert_thresholds
   SET is_active = false, updated_at = now()
 WHERE metric_key NOT LIKE 'custom:%' AND is_active;
