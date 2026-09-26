# FabOrchestrator — Project Guide (CLAUDE.md)

_Part 1: how to work in this repo · Part 2: app reference_

Working guidance for Claude on this codebase: how the code is organised, the rules
to follow, and the pitfalls to avoid. Read it before changing code; update it only when
*how something works* changes. It holds no status, backlog or fix notes — the project
explanation for people and the runbook is [`DEPLOYMENT.md`](DEPLOYMENT.md); fix detail lives in commit
messages. Deployment runbook: [`DEPLOYMENT.md`](DEPLOYMENT.md). Part 2 below holds the
app-level reference (structure, agents, FabInsight, models).

---

## 1. What this repository is

One Next.js 16 / React 19 / TypeScript app (`faborchestrator/`, port 3000) on **one
PostgreSQL database**, organised as modules that each ship as their own Docker image:

| Module | Folder | Role |
|--------|--------|------|
| **Home** | `modules/home` | Login, cockpit, settings — the entry point that links to every other module |
| **AI Support Engineer / FabInsight** | `modules/support-engineer`, `modules/fabinsight`, `modules/mcp` | End-user chat: Claude + MCP tools, dashboards built in chat, reports |
| **Master Data Load** | `modules/master-data-load` | Modeling Agent (CMF) |
| **Coding Agent** | `modules/coding-agent` | PO UI generation (`backend-agent` routes) |
| **Admin Console** | `modules/admin` (`app/admin`, `app/api/admin`) | Users, roles, models, MCP registry + on-the-fly MCP, dashboard approval & compile, usage, **error log**, audit. Admins reach it from the cockpit; gated by `requireAdmin` |
| **FabInsight worker** | `deploy/worker` | Scheduler process (no web server) |

Stack: Vercel AI SDK v6 + `@ai-sdk/anthropic` · Prisma 7 + `@prisma/adapter-pg` ·
Tailwind v4 + shadcn/Radix · Zod · Playwright (browser checks).

Production: AWS EKS, one image per module (built in CodeBuild, rolled out with the
Helm chart in `deploy/helm/`), RDS PostgreSQL (**TimeZone = UTC**). Runbook:
`DEPLOYMENT.md`. The network is Terraform-owned; everything on top of it is
CloudFormation in `deploy/cloudformation/eks/` (cluster, edge, workload IAM, image
build, logs). No account ids or resource ids in the docs — they live in the
per-environment Helm values.

---

## 2. Branches and how code moves

| Branch | Owner | Purpose |
|--------|-------|---------|
| `vikraman-rearchitecture` | Vikraman | **The architecture branch.** MCP-only dashboards, role-driven MCP, model registry tiers. Target for integrated work. |
| `vikraman-modularize` | Vikraman | Later restructure into `modules/` (537 files). **Not merged** — its compile-cap fix was ported by hand. |
| `yokesh-error_log` | Yokesh | Original error-log work on the OLD architecture. Superseded by the port below. |
| `yokesh-rearch-errorlog` | Yokesh | Working branch: the error-log work on top of `vikraman-rearchitecture`. |

**Pushing to `vikraman-rearchitecture` — rules:**
1. Never rename it, never force-push it.
2. `git fetch origin vikraman-rearchitecture` first; if the remote moved past our base, **stop and ask** — do not merge on our own.
3. Before pushing: typecheck, run the test suites, production-build, load key pages in a browser (§8).
4. Push as a fast-forward: `git push origin yokesh-rearch-errorlog:vikraman-rearchitecture`.
5. Push only with the owner's explicit approval. Tell Vikraman before it lands.

---

## 3. Local development

**Worktree:** `C:\Users\yokes\Downloads\FabOrch-rearch` (git worktree of `FabOrchestrator`).

**Database:** a local PostgreSQL 17 copy of production (`claude_ai_athena`, restored
from a `pg_dump` of RDS). The pre-copy seed DB is kept as `claude_ai_athena_seed_backup`.
- The local DB is set to **UTC** (`ALTER DATABASE claude_ai_athena SET timezone TO 'UTC'`)
  to match RDS. With a non-UTC database, Prisma's raw queries read `timestamptz` as UTC
  and every time shows shifted (this caused a 5 h 30 m error-log bug locally).
- Production data is on this laptop: treat it as confidential.

**Env files:** `faborchestrator/.env` (git-ignored). `.env.aws-backup` holds the AWS
values. The local copy has `SMTP_SERVER` commented out (`# LOCAL-COPY-DISABLED`) so the
copied shift summaries/alerts cannot email real people. `KEY_ENCRYPTION_SECRET` matches
production, so copied MCP credentials decrypt.

**Run:**
```bash
cd faborchestrator && npm run dev     # :3000 — Admin Console at /admin
```
Unset `ANTHROPIC_API_KEY` in the shell first if one is exported globally.

**Test login without a password:** insert a row into `sessions` (token ≥ 32 chars) for
the user and set `llmatscale_auth_token` in localStorage (one token for the whole
app, Admin Console included). Delete the row afterwards.

**Machine constraints:** the C: drive runs near full and the OS kills background dev
servers under memory pressure — check free space before installs/builds.

---

## 4. Architecture map

### 4.0 Where code lives (module layout)

The Fab app is grouped by **feature module**, with everything cross-cutting under `shared/`:

```
faborchestrator/
  modules/
    support-engineer/   Fab AI chat itself (full-chat-app, system prompts, uploads, files)
    fabinsight/         dashboards: pin → compile → replay → refresh → alerts → summaries
    mcp/                MCP client, connect, access, tool keys
    master-data-load/   Modeling Agent (CMF)
    coding-agent/       PO UI generation (the `backend-agent` routes)
    home/               cockpit / landing surfaces
    admin/              Admin Console: components/ (shell + screens), lib/{ai,dashboards,services,email,mcp,constants}, admin.css (scoped .admin-* rules)
  shared/
    lib/                errors/, storage, db, validation, auth, session, logger, …
    components/         ui/, prompt-kit/ (error-card, ask-user-card, message-action-bar)
    hooks/
  lib/po-ui/            the ported PO UI pipeline (kept verbatim — do not diverge)
  lambda/               Lambda sources deployed by CI (mcp-onthefly runtimes; cmf-token is legacy — the app refreshes CMF tokens itself) — never bundled by next build
  deploy/               per-image build: modules.json, Dockerfile.image, compose, worker entry
  app/                  routes (incl. app/admin, app/api/admin); they import from modules/ and shared/
```


**Rules:** a module owns its own `lib/` and `components/`; anything two modules need goes
in `shared/`. Import by alias (`@/modules/…`, `@/shared/…`), never by a long relative path —
relative imports are what broke when the code was regrouped.

### 4.1 A chat turn (`faborchestrator/app/api/chat/route.ts`)
```
POST /api/chat  (validated by ChatRequestSchema, shared/lib/validation.ts)
 ├─ auth, model check (model_registry), prompt-audit row started (PENDING)
 ├─ MCP: role permission → entitled connections → autoConnectMcp (modules/mcp/lib/mcp-connect.ts)
 │       → tools loaded per connection (modules/mcp/lib/mcp-client.ts), keys mcp_<conn8>__<tool>
 │       → unusable / refused connectors become error cards (preflightFailures)
 ├─ tools: web search, select_server (multi-server), ask_user (choice cards)
 ├─ streamText (maxOutputTokens, stopWhen: step limit | ask_user shown)
 ├─ stream: tokens → client; then tool failures, end-of-turn diagnosis, files
 └─ onFinish: save user+assistant messages (same ids as the client), usage, audit SUCCESS
```

### 4.1b Roles, permissions and the built-in Admin role
- Permission keys live in one place: `shared/lib/permissions.ts` (`ALL_PERMISSIONS`,
  labels, `isPlatformAdmin`, `hasPermission`). Add a new key there first.
- **Admin is built in and has 100% access.** `ensureAdminRole()` (role-service) runs on
  every server boot, in the seed and after every save of the role: it creates the row
  when missing and re-applies every permission, every active model, personal MCP and no
  limits. It cannot be renamed, restricted or deleted; the role form shows it locked.
- A user is a platform admin when `users.is_admin` is set, their role is Admin, or their
  role carries `admin`. Every gate (`requireAdmin`, model restriction, Modeling Agent,
  Coding Agent, CMF access, dashboards, MCP) goes through `isPlatformAdmin`, so admins
  always pass. Assigning the Admin role sets `is_admin`; assigning another role clears it.

### 4.2 MCP connections
- Role permission `mcp` gates everything. Role-assigned servers auto-connect for every
  user in the role; failures retry after 2 min.
- `personalMcpEnabled` lets a user add/disconnect servers (per-user disable list in
  `users.preferences.mcpDisabledIds` — a choice, never reported as an error).
- Several servers connected → system prompt adds scope rules; `select_server` records
  the user's pick for the conversation.

### 4.3 Dashboards (MCP-only)
```
chat dashboard → Pin dialog (Static | Scheduled: frequency, From, To or no expiry; visibility, All roles default)
   → admin pinning: live at once (Static = pinned snapshot, no compile; Scheduled = snapshot + compile job
     against the chat's servers, published into the same dashboard on success)
   → anyone else: dashboard_requests row carrying the choices → admin approves in one click → dashboard_compile_jobs
   → compiler agent (modules/fabinsight/lib/compiler) turns the chat's MCP trace into a replay program
   → replay (modules/fabinsight/lib/replay) runs the program with no model → cached snapshot
   → scheduler refreshes on schedule; expiry retires; alerts watch KPI thresholds
```
Compiler budget: **40 steps / 15 data calls** by default
(`FABINSIGHT_COMPILER_MAX_STEPS` / `_MAX_MCP_CALLS`, `0` = no cap), inside a 15-minute
timeout. The caps are not a wall — from half the budget every step is told what it has
spent and to write the program, and from three quarters `validate_program` is the only
tool it may call. Uncapped was tried and does not work: one compile ran 254 queries in
15 minutes without ever writing a program. Because the run is bounded, the admin compile
panel shows a **real** percentage (stage bands + steps spent + a time floor, never
backwards, never full until finished).

### 4.4 Background jobs (in-app timer, `modules/fabinsight/lib/scheduler-runner.ts`, every minute)
| Stage | What it does |
|-------|--------------|
| compile-jobs | claims approved dashboard requests and compiles them |
| refresh | replays dashboards whose schedule is due (reconnects dropped MCP connections first) |
| expiry | warns before / retires after a dashboard's end date |
| alerts | checks discrepancy thresholds against dashboard snapshots |
| baselines | samples metric history |
| shift-summaries | builds scheduled summary emails |
| cmf-token | every minute, after mcp-health: logs in to the CMF portal for every enabled Admin → Database Connections row with portal credentials whose bearer token is missing, expired or older than `CMF_TOKEN_REFRESH_MIN` (45 min) and writes it to `cmf_bearer_tokens` — the in-app replacement for the per-connection `cmf-token-<key>` Lambda (`modules/master-data-load/lib/cmf/token-refresh.ts`; the login itself is a headless-Chromium walk through the AuthPortal SPA, `portal-login.ts`). One browser at a time, each connection independent; a failed login is retried every `CMF_TOKEN_RETRY_MIN` (5 min); a row saved since the last attempt is retried at once. The first tick after boot is the boot refresh. Saving a connection also fetches its token immediately from the admin pod, and admins can "Refresh token now"; status (`In-app · refreshed 5 min ago · expires in 52 min` / `In-app · failed: …`) comes from the token table plus the error log — no new column. Failures are recorded with system "CMF portal login". Off when `CMF_TOKEN_PROVISIONER=lambda` (legacy Lambda kept for one release) |
| mcp-health | every 5 min: checks every active MCP registry server in three stages — reachable (`initialize`), tools (`tools/list`), data (one read-only `tools/call`: the runtime's built-in `health_check` on on-the-fly servers, else a no-argument listing tool, else a call the model chooses from the tool list and that is verified before it is saved — `modules/mcp/lib/mcp-health-probe-llm.ts`; admins can re-run that with "Let AI choose", nothing is typed by hand); status healthy / degraded (server up, database not answering) / down / unknown stored on `mcp_registry` + history in `mcp_health_checks`; shown on the admin MCP cards and the cockpit per agent (`GET /api/mcp/health`) |

Each stage runs under an error context (`shared/lib/errors/run-context.ts`), so anything it
records names the job and the admin who configured it.

---

## 5. Error handling — how it works (the error log)

**Principle:** a failure is shown **only when something really failed**, always with
its **true cause** (the server's own message, status, code — never "something went
wrong"), and every failure leaves **one record** an admin can find.

### 5.1 Pipeline
```
failure ─► CAPTURE  shared/lib/errors/error-detail.ts  (captureError: message, code, status, cause chain)
        ─► RECORD   shared/lib/errors/error-audit.ts   (recordError → error_audit_logs)
        ─► SHOW     chat: data-errorDetail part → shared/components/prompt-kit/error-card.tsx
                    admin: Admin → Errors (list + detail)
```
- `withCapture(ctx, fn)` wraps a call and throws a captured error; `recordCaptured(ctx, err)`
  records an already-caught one without throwing (background work that continues).
- `ctx.type` states the category when the caller knows it; otherwise it is inferred
  (network code / HTTP status). Unknown → `SQL_CALL_FAILURE`, so **always pass `type`**
  for configuration and job failures (`INVALID_PARAMETER`, `LAMBDA_MCP_CRASH`, …).
- Scheduled repeats are written once per 15 min per (job, system, cause) with a
  suppressed count (`ERROR_REPEAT_WINDOW_MS`). User-facing failures are never suppressed.
  Connector-down records are rate-limited per connector+cause; the user still gets the card.

### 5.2 What the chat reports (all in `app/api/chat/route.ts` unless noted)
| Situation | Where decided | User sees |
|-----------|---------------|-----------|
| Connector deleted / switched off / another user's / not assigned / no MCP permission | refused-connector block | the exact rule, with the connector's name |
| Connector cannot connect or has no tools | `mcp-client.ts` `toolsFromConnection` + `mcp-connect.ts` | the stored `lastError`, "retried every 2 minutes" |
| Tool returned an error | `shared/lib/errors/stream-tool-failures.ts` | the source's own message |
| Tool **threw** / invalid input | same file — reads `tool-error` parts from `step.content` | the thrown message |
| Model recovered after a failure | same | grey note, **admins only** |
| Step limit / length / filter / no text | `shared/lib/errors/turn-outcome.ts` | "cut off: used all 20 tool steps…", etc. (not for ask_user turns) |
| Refused before replying (session, invalid model, 500) | client: `requestErrorFromText` | the API's message + Retry, never raw JSON, at the bottom |
| Message could not be sent | client: `reportUnsent` | toast with reason + "Copy text" |

### 5.3 Admin error log
`app/admin/errors` (module `modules/admin`) — list polls every 10 s while visible ("Live · updated
…"), groups repeats by default, rows open a detail page with the full capture.
Verified end to end: a chat failure appears on an open page within ~2 s, same cause.

### 5.4 Adding a new failure point — checklist
1. Capture the **real** error object, not a rewritten string.
2. User waiting? stream a `data-errorDetail` part (or return `{ errorDetail }` from a tool).
3. Background? `recordCaptured({ system, operation, target, userId, type }, err)`.
4. Do not report user choices or model self-corrections as errors.
5. Check the failure end to end in the browser and the admin error log.

---

## 6. Chat UI conventions

- **Action bar:** user message = Edit · Delete · Copy. AI reply = Copy · 👍 · 👎 (+ ⚠ error-log
  link for admins when that turn failed). **No Delete on AI replies.**
- **Message ids are UUIDs made in the browser** (`crypto.randomUUID()`, `useChat({ generateId })`)
  and the server saves the user message under the same id (`clientMessageId`,
  `shared/lib/storage.ts`). Otherwise Delete/Edit fail with "message not found" until reload.
- Deleting a user message removes the reply it produced; deleting the **last** message
  soft-deletes the conversation, removes it from the sidebar, and opens a new chat.
- **Choice cards** (`ask_user` tool → `shared/components/prompt-kit/ask-user-card.tsx`):
  ↑/↓, 1–9, Enter, ←/→ between questions, free-text row. The pick is sent as a normal message.
- **Dialogs:** no `slide-in-from-*` classes — in Tailwind v4 they stack on the centring
  translate and the dialog swoops in (`shared/components/ui/dialog.tsx`).
- The three chats (Fab AI, Modeling Agent, Coding Agent) must behave the same; change all three.

---

## 7. Configuration knobs worth knowing

| Variable | Default | Effect |
|----------|---------|--------|
| `CHAT_MAX_OUTPUT_TOKENS` | 64000 | per model call, thinking included |
| `FABINSIGHT_COMPILER_TIMEOUT_MS` | 900000 | compile budget (only bound by default) |
| `FABINSIGHT_COMPILER_MAX_STEPS` / `_MAX_MCP_CALLS` | 0 (off) | optional compile caps |
| `ERROR_REPEAT_WINDOW_MS` | 900000 | scheduled-failure repeat window |
| `REPORT_TICK_INTERVAL_MS` | 60000 | scheduler tick |
| `REPORT_SCHEDULER_ENABLED` | true | runs the scheduler + session-log retention in this process; `false` on web images |
| `MCP_HEALTH_INTERVAL_MS` | 300000 | how often the worker health-checks every MCP server (5 min) |
| `CHAT_PROGRESS_EVERY` | 8 | tool calls a chat turn may make in silence before the model is asked for a two-sentence progress note (0 = off); all three chats |
| `CMF_TOKEN_REFRESH_MIN` | 45 | how old a CMF bearer token may get before the `cmf-token` stage logs in again (per connection); `CMF_TOKEN_RETRY_MIN` (5) is the retry gap after a failed login, `CMF_TOKEN_SAVE_TIMEOUT_MS` (60000) how long a save / "Refresh token now" waits for the login before answering "still running", `CMF_CHROMIUM_PATH` the Chromium the login runs in (set by the image), `CMF_TOKEN_PROVISIONER=lambda` the legacy per-connection Lambda instead |
| `CMF_BUILTIN_PROFILES` | off | local development only: `1` adds env-driven `source`/`target` CMF profiles; otherwise the Master Data Load agent knows only the enabled rows in Admin → Database Connections |

---

## 8. Verification before anything ships

```bash
cd faborchestrator
npx tsc --noEmit
npm run lint
npm run build                # production build (catches CSS/bundling errors typecheck misses)
```
Then load `/chat`, `/admin` and `/admin/errors` in a browser. Playwright is available
through the Claude Code plugin; drive the real UI with a temporary session (§3) to check
user-facing changes. There are no automated test suites in this repo.

---

## 9. Known pitfalls (learned the hard way)

- **SDK v6 ignores `maxTokens`** — use `maxOutputTokens`. Without it `@ai-sdk/anthropic`
  caps unknown model ids (all Claude 5 ids) at **4,096 tokens including thinking**.
- **Thrown tool errors live only in `step.content`** (`tool-error`), not `step.toolResults`.
- **`hasToolCall` stops on errored calls too** — stop on a *shown* ask_user instead.
- **Non-UTC Postgres** shifts every raw-query timestamp (see §3).
- **CSS merge conflicts** can drop a closing brace; typecheck will not notice — build or load a page.
- `git` CRLF warnings on Windows are harmless.
- Local test rows (sessions, conversations) must be cleaned up; `conversations.created_at`
  is `timestamp` without zone.

---

## Part 2 — App reference

### Quick Reference

| Item | Value |
|------|-------|
| **Framework** | Next.js 16.1.4 + React 19.2.3 |
| **Language** | TypeScript 5 |
| **Database** | PostgreSQL + Prisma 7.3.0 |
| **AI Provider** | Anthropic API (Claude Sonnet 5, Opus 5, Fable 5, Fable 5.1 — see Platform models) |
| **Styling** | TailwindCSS v4 + Radix UI |
| **Node Version** | 20+ |

### Project Overview

LLMatscale.ai is a full-stack AI chat application featuring Claude models powered by the Anthropic API.

### Project Structure

```
faborchestrator/
├── app/                        # Next.js App Router — routes only; logic lives in modules/
│   ├── api/                   # chat, conversations, auth, files, mcp, user, fabinsight,
│   │                          #   modeling-agent, backend-agent, messages, admin/**
│   ├── chat/ backend-agent/ modeling-agent/ admin/ register/ …   # pages
│   ├── layout.tsx  page.tsx (login)  globals.css
│
├── modules/                    # one folder per feature; each owns its lib/ and components/
│   ├── support-engineer/      # Fab AI chat
│   │   ├── components/        #   full-chat-app.tsx, viewers, chat input
│   │   └── lib/               #   system-prompts, anthropic-files, s3-upload, context-window
│   ├── fabinsight/            # dashboards (MCP-only)
│   │   ├── lib/               #   pin/, replay/, compiler/, refresh, alerts, expiry,
│   │   │                      #   scheduler-runner, shift-summary, baselines, html-escape
│   │   └── components/        #   prompt-bubbles, dashboard views
│   ├── mcp/lib/               # mcp-client, mcp-connect, mcp-access, mcp-tool-key, mcp-lambda
│   ├── master-data-load/      # Modeling Agent (CMF): chat-cmf/, cmf/, validation/
│   ├── coding-agent/          # PO UI generation (the backend-agent routes)
│   ├── home/components/       # cockpit / landing
│   └── admin/                 # Admin Console (app/admin + app/api/admin): components/,
│                              #   lib/{ai,dashboards,services,email,mcp,constants}, admin.css
│
├── shared/                     # cross-cutting — used by more than one module
│   ├── lib/                   #   errors/ (capture, error-detail, error-audit, run-context,
│   │                          #     stream-tool-failures, turn-outcome, silent-failure)
│   │                          #   storage, db, validation, auth-middleware, encryption,
│   │                          #   client-session, greeting, save-answer, turn-registry,
│   │                          #   message-files, model-registry, model-pricing, logger
│   ├── components/            #   ui/ (Radix wrappers), prompt-kit/ (error-card,
│   │                          #     ask-user-card, message-action-bar), settings-modal
│   └── hooks/
│
├── lib/po-ui/                  # ported PO UI pipeline (verbatim; do not diverge)
├── lib/generated/              # Prisma client output
├── lambda/                     # Lambda sources built by CI (mcp-onthefly runtimes, cmf-token)
├── deploy/                     # per-module images: modules.json, Dockerfile.image, compose, scripts/
├── po-ui-assets/               # prompts + corpora (corpus/ & samples/ gitignored)
├── prisma/                     # schema.prisma, migrations, SQL DDL
└── scripts/  templates/  public/
```

**Import rule:** always by alias — `@/modules/<name>/…`, `@/shared/…`. Relative paths
across folders break the moment code is regrouped.

### Database Schema

| Model | Purpose | Key Fields |
|-------|---------|------------|
| **User** | Authentication & settings | email, passwordHash, anthropicApiKey (encrypted), preferences |
| **Session** | Session management | token, expiresAt (30-day) |
| **Conversation** | Chat sessions | title, model, isPinned, isShared |
| **Message** | Chat messages | role (user/assistant/tool), content, parts, metadata |
| **Artifact** | Generated visualizations | type (html/code), title, content |
| **McpConnection** | MCP server connections | serverUrl, authType, availableTools |
| **PasswordResetToken** | Password recovery | token, expiresAt |

### Key Features

### Authentication
- Scrypt password hashing with timing-safe comparison
- 30-day session tokens stored in PostgreSQL
- Bearer token authentication for all API routes
- AES-256-GCM encryption for API keys/MCP credentials

### AI Chat
- Real-time streaming via Anthropic API with Vercel AI SDK `useChat` hook
- Four platform models from the shared model registry (FabOrchestrator 1–4)
- Adaptive thinking on every platform model
- File upload and preview (PDF, DOCX, XLSX, PPTX, images, text)
- Container skills for document generation (PPTX, DOCX, PDF, XLSX)
- Sandpack live React preview
- MCP tool integration
- Artifact generation (HTML/code)

### Environment Variables

```env
# Anthropic API
ANTHROPIC_API_KEY=sk-ant-...

# PostgreSQL
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/llmatscale_ai"

# Encryption (64 hex chars = 32 bytes for AES-256)
KEY_ENCRYPTION_SECRET="your_64_hex_character_key"
```

### Getting Started

```bash
# Install dependencies
npm install

# Push database schema
npm run db:push

# Start development server
npm run dev
```

### Available Scripts

```bash
npm run dev          # Development server
npm run build        # Production build
npm run start        # Production server
npm run lint         # ESLint
npm run db:generate  # Regenerate Prisma client
npm run db:migrate   # Run migrations
npm run db:push      # Push schema directly
npm run db:studio    # Prisma Studio GUI
npm run db:reset     # Reset database (WARNING: deletes data)
```

### Coding Agent (PO UI generation)

A fourth agent, alongside Fab AI chat and the Modeling Agent. It reads a CMF
requirement document (.docx) and produces the **deployment unit** an engineer
imports into Critical Manufacturing: the UI page export, the queries it consumes
and the master-data file that declares its labels.

**The model never writes XML.** It reads the requirement, asks what the document
leaves open and writes a typed specification (`SpecDescriptor`); OUR code turns
that specification into the page, its queries and the unit deterministically,
then validates the result against the client's own delivered artifacts. That
split is the point of the module — the parts that must be exact are not
generated.

#### Layout

| Path | What lives there |
|------|------------------|
| `lib/po-ui/` | The pipeline itself. **Ported verbatim from the standalone app** — the only edit is dropping `.ts` from relative imports. Do not diverge: `app/test/prevalidate.test.ts` in the standalone gates the copies against each other. |
| `modules/coding-agent/lib/` | The FabOrchestrator glue — run directories, chat tools, access, state, the deployment unit, pre-validation. |
| `app/api/backend-agent/` | Routes: `chat`, `upload`, `prd`, `preview`, `file`, `download`, `prevalidation`, `access`. |
| `app/backend-agent/` | The page. |
| `modules/master-data-load/components/backend-*`, `prevalidation-card`, `work-panel`, `wait-ladder` | The interface. |
| `po-ui-assets/` | Prompts, skeletons, dictionaries and the evidence corpora. |

#### Assets are NOT all in the repo

`po-ui-assets/config`, `package`, `graph` and `schema` are curated and committed.
`corpus/` and `samples/` are the CLIENT'S OWN artifacts — delivered CMF exports
and requirement documents — and are gitignored.

A fresh checkout therefore runs the app but **cannot generate** until those are
provisioned. Drop them in place, or point `PO_UI_ASSETS_DIR` at a populated
asset root.

#### Access

Open to every signed-in user while the agent is evaluated. Set
`BACKEND_AGENT_REQUIRE_PERMISSION=1` to switch on the `backend_agent` role check
(`modules/coding-agent/lib/access.ts`). The client gate is a courtesy; the chat route
enforces it independently.

#### Naming

The UI calls it the **Coding Agent**. The identifiers — the `backend_agent`
permission, the `/backend-agent` route, the `po-ui-agent` modules — still say
back-end agent, deliberately: renaming the permission would invalidate grants
already made in the Admin Console.

#### Environment

| Variable | Purpose |
|----------|---------|
| `PO_UI_ASSETS_DIR` | Asset root, when not `po-ui-assets/` beside the app |
| `PO_UI_RUNS_DIR` | Run output, default `.po-ui-runs/` (gitignored — it holds customer content) |
| `BACKEND_AGENT_MODEL` | Overrides the model in `pipeline.json` for a deliberate experiment |
| `BACKEND_AGENT_REQUIRE_PERMISSION` | Turns the role check on |

### FabInsight dashboards (MCP-only)

Dashboards are built in chat through connected MCP tools only — Fab AI holds no
SQL and opens no database sockets. A user with the `dashboards` role permission
pins a chat dashboard through one dialog (Static or Scheduled, dates, visibility —
`modules/fabinsight/components/pin-dashboard-dialog.tsx`). An admin's pin goes live
directly; anyone else's becomes a request pre-filled with those choices that an admin
approves in one click. For Scheduled dashboards a compiler agent turns the captured tool-call
trace + HTML into a **replay program**; the scheduler replays it with no model in
the loop and stores the snapshot.

| Path | What lives there |
|------|------------------|
| `modules/mcp/lib/mcp-tool-key.ts` | Tool keys are `mcp_<conn8>__<name>` — namespaced per connection; tool outputs carry `_mcp` (connection/registry/server/tool). |
| `modules/fabinsight/lib/pin/` | Pin capture: `trace.ts` (ordered MCP calls from `messages.parts`), `kpis.ts` (KPI labels from the HTML). |
| `app/api/fabinsight/pin-requests` | POST takes the dialog's choices (type, schedule, from/to/noExpiry, visibility). Admin: creates the live dashboard (Static snapshot, or snapshot + compile job). Others: a `dashboard_requests` row with the choices, and emails admins. |
| `modules/fabinsight/lib/replay/` | Program schema, relative-time expressions, MCP result parser, server resolver, `runProgram`, template binder (`data-fab-*` markers). |
| `modules/fabinsight/lib/compiler/` | Compiler agent (`compileDashboard`) + `claimCompileJobs` (claims `dashboard_compile_jobs` written by the Admin Console). |
| `modules/fabinsight/lib/refresh.ts` | `refreshDashboard` / `runDueReportRefresh` — replay the current version, keep the last-good snapshot on total failure. |
| `modules/fabinsight/lib/expiry.ts` | Warn before / expire after `dashboards.expires_at`. |
| `modules/fabinsight/lib/visibility.ts` | Who can see a dashboard (all / roles / users / requester); used by the read routes, alerts and shift summaries. |
| `modules/fabinsight/lib/scheduler-runner.ts` | The in-app tick: compile jobs → refresh → expiry → alerts → baselines → shift summaries. |
| `prisma/create_dashboards.sql` | DDL for `dashboard_requests`, `dashboards`, `dashboard_versions`, `dashboard_compile_jobs` (+ `conversations.selected_connection_id`). Additive; run directly, never `db push`. |
| `scripts/seed-dashboards.ts` | Export / import standard dashboards (`kind='seeded'`). |
| `prisma/create_prompt_chips.sql`, `modules/fabinsight/components/prompt-bubbles.tsx` | Prompt chips: shared `prompt_chips` library + `roles.prompt_chip_ids`; a role with Dashboard Scheduling gets the default seven auto-selected (admin can add/create); `GET /api/fabinsight/access` returns `chips`, rendered above the composer. |

MCP access (`modules/mcp/lib/mcp-access.ts`, `modules/mcp/lib/mcp-connect.ts`): the `mcp` role permission
gates every MCP surface (no permission → no connections listed, no tools, no
Connectors menu, no MCP settings tab). The servers the admin assigns to a role
are **connected automatically** for every user in it (`autoConnectMcp`:
initialize + tools/list, persisted on the row; failures retried after 2 min).
The role option "Users can manage MCP connections" (`personalMcpEnabled`) lets a
user connect / disconnect ANY entitled server — an assigned one is switched off
for that user only (`users.preferences.mcpDisabledIds`, the shared row is never
touched) — and add / edit / delete their own servers (Add button in Settings) up
to `personalMcpMaxCount`, at least 1; a server a user adds is visible to that user
only. Without the option every entitled server is simply connected and the cards
show no controls. The composer keeps per-connection
on/off toggles either way.

Multi-server chat: when more than one MCP server is connected the system prompt
groups tools per server and adds the scope rules (ask when unscoped, check each
server for a named entity, fan out for cross-server questions); the model records
the user's choice with `select_server` (sticky per conversation).

Compiler behaviour (learned the hard way on the first real compile): the in-scope
servers' MCP tools are attached to the model directly (one server → its tools,
several → all), `toolChoice: 'required'` so every step is a tool call, per-step
output capped (`FABINSIGHT_COMPILER_MAX_TOKENS`, 10k) because a 32k-token step
took five minutes, `validate_program({dryRun:false})` for cheap structural
iteration and ONE live replay before `emit_program`. Servers that return Python
literals (single quotes, rows as arrays) are handled by `replay/mcp-result.ts`.
A string argument that embeds dates uses `{"$template": "...{{from}}...", "vars": {...}}`.
Knobs: `FABINSIGHT_COMPILER_MODEL`, `_MAX_STEPS` and `_MAX_MCP_CALLS` (both 0 = no cap,
the default — the timeout is the only bound), `_MAX_TOKENS` (10000), `_TIMEOUT_MS` (15 min). Typical compile: ~2 min, ~150k input tokens.

Env: `FABINSIGHT_COMPILER_*` above, `FABINSIGHT_EXPIRY_WARN_DAYS`, `APP_URL`
(links in admin emails point at `/admin/...` on the same origin), plus the existing `SMTP_*`, `REPORT_TICK_*`,
`FABINSIGHT_CRON_SECRET`, `FABINSIGHT_REFRESH_FAIL_NOTIFY_MIN`.

### Platform models

The shared `model_registry` table (managed in the Admin Console under Models) is the
source of truth: it decides which models exist on the platform, their display
names, pricing and the default. Role forms only offer models active in the
registry; Fab AI lists the registry rows (users see the display name, admins the
real name) and falls back to the hardcoded list below only when the table is
empty or unreachable. Display names are tiers — the lower the number, the lower
the tier.

| Display name | Model ID | Tier |
|--------------|----------|------|
| FabOrchestrator 1 | claude-sonnet-5 | Fast and efficient for everyday work |
| FabOrchestrator 2 | claude-opus-5 | Strong reasoning for complex tasks |
| FabOrchestrator 3 | claude-fable-5 | Advanced reasoning for demanding work |
| FabOrchestrator 4 | claude-fable-5-1 | Most capable model (default) |

Changing the set: run `prisma/update_model_registry_tiers.sql`
(idempotent; also rewrites `roles.allowed_models`) and update the fallback lists
(`shared/lib/errors/parameter-values.ts`, `app/api/user/models/route.ts`, the
`CLAUDE_MODELS` constants in the chat components) plus `shared/lib/model-pricing.ts`.

### Architecture

#### Data Flow
1. User authenticates → Session token in localStorage
2. Frontend uses `useChat` hook → Calls `/api/chat`
3. Backend validates session → Streams from Anthropic API
4. Messages saved to PostgreSQL → Artifacts extracted and stored
5. Frontend displays streaming response with markdown/code highlighting

#### Security
- All API routes require Bearer token authentication
- Passwords hashed with scrypt (salt + derived key)
- API keys/MCP credentials encrypted with AES-256-GCM
- Session tokens are cryptographically random (32+ bytes)
- Cascade deletes maintain referential integrity

### File References

#### Key Files
| File | Purpose |
|------|---------|
| `modules/support-engineer/components/full-chat-app.tsx` | Main chat UI (86KB) |
| `shared/components/settings-modal.tsx` | Settings modal (42.7KB) |
| `shared/components/ui/claude-style-chat-input.tsx` | Custom chat input (39.7KB) |
| `app/api/chat/route.ts` | Chat endpoint |
| `shared/lib/storage.ts` | All database CRUD operations |
| `shared/lib/auth-middleware.ts` | Authentication utilities |
| `shared/lib/anthropic.ts` | Anthropic SDK client |
| `modules/support-engineer/lib/anthropic-files.ts` | Anthropic Files API client |
| `modules/support-engineer/lib/system-prompts.ts` | System prompts |
| `prisma/schema.prisma` | Database schema |
| `app/globals.css` | Theme variables & styles |

#### Documentation
| File | Content |
|------|---------|
| `CLAUDE.md` | This guide (Part 1: working rules, Part 2: app reference) |
| `DEPLOYMENT.md` | Runbook, env vars, per-module images |

### Contributing

1. Use TypeScript for all new files
2. Run `npm run lint` before committing
3. Follow existing patterns in each layer
4. Test endpoints thoroughly
5. Update documentation when adding features

### External Documentation

- [Next.js](https://nextjs.org/docs) | [Vercel AI SDK](https://sdk.vercel.ai/docs) | [Anthropic API](https://docs.anthropic.com/en/docs)
- [Prisma](https://www.prisma.io/docs) | [Radix UI](https://www.radix-ui.com/primitives) | [TailwindCSS](https://tailwindcss.com/docs)
