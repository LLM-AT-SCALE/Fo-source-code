# FabOrchestrator

FabOrchestrator is an AI operations platform for semiconductor and electronics
manufacturing. It puts Claude in front of a factory's systems (MES, ERP, quality
and engineering databases) through MCP connectors, and packages that capability
as a set of agents that plant engineers, operators, planners and administrators
use from one login.

Everything lives in [`faborchestrator/`](./faborchestrator): one Next.js
application, organised as modules, where each module ships as its own Docker
image so a deploy, a crash or a scaling change in one module never touches
another.

| Document | Purpose |
|----------|---------|
| This file | What the product is and how it is built |
| [`faborchestrator/DEPLOYMENT.md`](./faborchestrator/DEPLOYMENT.md) | Runbook: EKS architecture, configuration, on-the-fly MCP substrate, image build and Helm rollout, database, monitoring, local Docker run |
| [`faborchestrator/CLAUDE.md`](./faborchestrator/CLAUDE.md) | Working rules for the codebase and the app-level reference |

---

## 1. The agents

Users land on the **cockpit** after login. It links to every agent and shows
the live health of the data connections behind them.

| Agent | What it does | Module |
|-------|--------------|--------|
| **FabInsight** | Ask questions over the factory's live data through MCP connectors, get answers with tables and charts, and turn a chat answer into a scheduled dashboard (pin → admin approval → compiled replay program → refreshed on a schedule, with KPI alerts and shift summaries). | `modules/fabinsight`, `modules/support-engineer`, `modules/mcp` |
| **AI Support Engineer** | The same chat surface for operations support work (routine questions, documents, files). | `modules/support-engineer` |
| **Master Data Load** | The Modeling Agent for Critical Manufacturing (CMF): guides the loading of master data, validates spreadsheets against the KSP template, stages and loads packages, tracks execution. | `modules/master-data-load` |
| **Coding Agent** | Turns a requirement document (.docx) into a CMF deployment unit: UI page export, queries and the master-data file, generated deterministically from a typed specification and validated against the client's delivered artifacts. | `modules/coding-agent`, `lib/po-ui` |
| **Admin Console** | Users, roles, platform models, MCP registry and on-the-fly MCP servers, dashboard approval and compilation, usage and cost, error log, audit, alert thresholds, shift summaries. Admins reach it from the cockpit. | `modules/admin` |

All three chats (FabInsight / Support Engineer, Master Data Load, Coding Agent)
share one chat engine: streaming answers, file upload and preview (PDF, DOCX,
XLSX, PPTX, images), artifacts (HTML and code with live preview), reasoning
display, choice cards, and per-connector tool toggles.

---

## 2. How it works

### 2.1 One login, one database, six images

- **Login** issues a session token used by every module (30-day absolute
  expiry, 30-minute idle eviction, session audit trail).
- **PostgreSQL** (Prisma 7) holds everything: users, roles, sessions,
  conversations and messages, artifacts, MCP registry and connections,
  dashboards and their versions, compile jobs, schedules, alerts, usage,
  audit and error logs.
- **Images** are built from the one source tree by `deploy/Dockerfile.image`
  (`deploy/modules.json` says which routes each image owns):

  | Image | Owns |
  |-------|------|
  | `home` | login, cockpit, settings, auth and user APIs |
  | `chat` | FabInsight and Support Engineer chat, reports, MCP connections, dashboards APIs |
  | `master-data-load` | Modeling Agent pages and CMF APIs (runs in the CMF VPC) |
  | `coding-agent` | Coding Agent pages and APIs (needs `po-ui-assets/` and a writable runs volume) |
  | `admin` | Admin Console pages and APIs (the only image with the Lambda-creation IAM policy) |
  | `fabinsight-worker` | the scheduler: compile jobs, dashboard refresh, expiry, alerts, baselines, shift summaries, MCP health checks, session-log retention |

  A load balancer routes by URL prefix; each image serves its own static
  assets under `/_fab/<image>/`, and a small guard (`proxy.ts`) makes a link
  that crosses images a plain page load.

### 2.2 MCP connectors

- Admins register MCP servers in the **registry** (HTTPS servers, or
  `lambda-invoke://` servers the platform created itself) and assign them
  **per agent** to roles or users. Assigned servers connect automatically for
  every user in the role; a role can also let users add their own.
- **On-the-fly MCP servers**: from a database's connection details the Admin
  Console discovers the schema, has the model write a manifest of read-only
  tools, and deploys a per-source Lambda MCP server on a fixed, reviewed
  runtime (Postgres and SQL Server variants in `lambda/mcp-onthefly/`). The
  executable code never comes from the model; only the tool manifest does.
- **Health checks** run every 5 minutes on every server in three stages:
  reachable (`initialize`), tools (`tools/list`), data (one read-only tool
  call that proves the database answers). The data probe is never typed by
  hand: on-the-fly servers expose a built-in `health_check`; other servers get
  a no-argument listing tool, or the model reads the tool list, proposes
  calls and the first one that really returns data is kept. Status is
  **Healthy**, **DB not reachable**, **Server down** or **Not checked**, shown
  on every Admin Console MCP card and, per agent, in the cockpit for the
  servers the signed-in user can use.

### 2.3 FabInsight dashboards

Dashboards are built in chat with MCP tools only; the platform holds no SQL
and opens no database sockets of its own.

1. A user pins a chat dashboard as a **request** (reason, HTML, the MCP call
   trace, the KPIs).
2. An admin **approves** it: which servers, refresh schedule, expiry,
   visibility (everyone, roles or users).
3. A **compiler agent** turns the captured trace and HTML into a **replay
   program**; the admin reviews the preview, can ask for refinements, and
   publishes it as a version (versions and rollback are kept).
4. The **worker** replays the program on schedule with no model in the loop,
   stores the snapshot, watches KPI thresholds for **alerts**, samples
   baselines and sends **shift summaries** by email.

### 2.4 Roles and permissions

- Permissions: `admin`, `chat`, `mcp`, `artifacts`, `file_upload`,
  `web_search`, `dashboards`, `modeling_agent`, `backend_agent` (the Coding
  Agent). Roles also choose the platform models their users may use, daily
  request and token limits, prompt chips, custom instructions and personal
  MCP rights.
- The **Admin** role is built in and has full access to the entire platform.
  It is created or repaired on every server start, cannot be renamed,
  restricted or deleted, and assigning it to a user makes them an admin.
- **Platform models** come from the model registry (managed in the Admin
  Console): FabOrchestrator 1–4, mapped to Claude Sonnet 5, Opus 5, Fable 5
  and Fable 5.1 (default).

### 2.5 Errors, audit and observability

- Every failure is shown where it happened with its real cause (the server's
  own message) and leaves one record in the **error log**, which admins see
  live in the Admin Console. Scheduled repeats are grouped.
- **Audit** covers logins and sessions, prompts and responses (with tokens
  and cost), admin actions, CMF loads and dashboard decisions.
- **Usage and cost** per user, role, model and day, with exports.

---

## 3. Technology

| Area | Choice |
|------|--------|
| Framework | Next.js 16 (App Router, Turbopack), React 19, TypeScript 5 |
| AI | Vercel AI SDK v6 with the Anthropic provider; Claude 5 family |
| Data | PostgreSQL, Prisma 7 with the pg adapter; AES-256-GCM for stored credentials; scrypt password hashing |
| UI | Tailwind CSS v4, shadcn/Radix components, Recharts |
| Integrations | MCP (HTTP and Lambda-invoke transports), CMF REST and SQL Server, S3 for uploads, SMTP for email, AWS Lambda for on-the-fly MCP servers and CMF token refresh |
| Infrastructure | Docker images per module, ECS Fargate, ALB, optional CloudFront, RDS; everything as CloudFormation in `faborchestrator/deploy/cloudformation/` |

---

## 4. Repository layout

```
faborchestrator/
  app/                 routes only (pages and /api); logic lives in modules/
    admin/  api/admin/ chat/  home/  modeling-agent/  backend-agent/  reports/  settings/ ...
  modules/
    home/              cockpit, navigation, live agent status
    support-engineer/  the chat application (shared by FabInsight)
    fabinsight/        pin, compiler, replay, refresh, alerts, expiry, scheduler, shift summaries
    mcp/               MCP client, connect, access rules, health checks, AI probe choice
    master-data-load/  Modeling Agent: CMF client, validation, chat tools
    coding-agent/      Coding Agent glue around lib/po-ui
    admin/             Admin Console screens and services (users, roles, dashboards, email, OTF MCP)
  shared/              cross-cutting code: auth, permissions, errors, storage, UI kit, hooks
  lib/po-ui/           the PO UI generation pipeline (kept verbatim)
  lib/generated/       Prisma client (generated, not committed)
  lambda/              Lambda sources: on-the-fly MCP runtimes, discovery, CMF token refresh
  deploy/              modules.json, Dockerfile.image, docker-compose.local.yml, scripts/, cloudformation/
  prisma/              schema.prisma, additive SQL files, seed
  po-ui-assets/        prompts, skeletons and dictionaries for the Coding Agent
  templates/           KSP master-data templates
  public/              static assets
  scripts/             operational scripts (admin/, seed-dashboards)
```

---

## 5. Running it locally

```bash
cd faborchestrator
npm install                 # also generates the Prisma client
# .env: ANTHROPIC_API_KEY, DATABASE_URL, KEY_ENCRYPTION_SECRET, APP_URL, SMTP_* ... (full list in DEPLOYMENT.md §5)
npm run db:seed             # first time: default roles, the built-in Admin role and a bootstrap admin user
npm run dev                 # http://localhost:3000 — Admin Console at /admin
```

The database should run in UTC, like production. Additive SQL files in
`prisma/` create the newer tables on an existing database; they are idempotent.

Checks before shipping:

```bash
npx tsc --noEmit
npm run lint
npm run build
```

Six-image run with Docker (mirrors the AWS layout):

```bash
docker compose -f deploy/docker-compose.local.yml up --build   # router on http://localhost:8080
```

---

## 6. Deploying

`faborchestrator/DEPLOYMENT.md` is the runbook. In short: the app runs on
AWS EKS behind CloudFront and an ALB, one Deployment per module image, with
the network owned by Terraform and the cluster, edge, per-module IAM roles,
image build and logging owned by CloudFormation stacks under
`deploy/cloudformation/eks/`. `deploy/scripts/aws-build-images.sh` builds all
six images in CodeBuild from the committed code, `helm upgrade` with
`deploy/helm/faborchestrator` rolls them out, and
`deploy/scripts/module-closure.mjs --affected <file>` tells you which images a
change touches.

---

## 7. Security notes

- Bearer-token authentication on every API route; sessions are random 32-byte
  tokens with idle eviction and an audit trail.
- Passwords hashed with scrypt; API keys and MCP credentials encrypted with
  AES-256-GCM under `KEY_ENCRYPTION_SECRET`.
- Role checks on every agent and admin route; admins are decided by one rule
  (`isPlatformAdmin`) used everywhere.
- On-the-fly MCP runtimes are read-only, bounded, and only the `admin` image
  carries the IAM rights to create Lambdas and secrets.
- The Coding Agent's run output and the client's evidence corpora are never
  committed; they are provisioned per environment.
