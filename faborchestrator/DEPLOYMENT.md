# FabOrchestrator — Deployment Guide

How the Fab app (`faborchestrator/`) is deployed and operated on **AWS EKS**: six
module images from one source tree, one PostgreSQL database, a dedicated VPC with a
Site-to-Site VPN to the on-prem CMF MES, and Lambda-hosted MCP servers.

This file holds no account numbers, resource ids, hostnames or secrets. Those live in
three places only:

| What | Where |
|------|-------|
| Network ids (VPC, subnets, security groups, VPN, RDS) | Terraform (outside this repo) and the parameter defaults of the CloudFormation templates |
| Per-environment values (registry, bucket names, target groups, role ARNs, public URL) | `deploy/helm/faborchestrator/values-<env>.yaml` |
| Secrets (API keys, DB password, SMTP password, encryption key) | AWS Secrets Manager, pulled into the cluster by External Secrets; a git-ignored `values-<env>.secret.yaml` may carry values that are not yet in Secrets Manager |

Read [`CLAUDE.md`](CLAUDE.md) for how the code is organised. Read
[`deploy/cloudformation/eks/README.md`](deploy/cloudformation/eks/README.md) for the
stack-by-stack provisioning order.

---

## 1. TL;DR

**Deploy new app code** → §7: GitHub → Actions → **Deploy** → pick branch and modules →
a reviewer approves. (By hand: build the images in CodeBuild, then `helm upgrade`.)

**Change infrastructure** → edit the template under `deploy/cloudformation/eks/` (or
Terraform for anything network-level), deploy the stack, then the Helm values if an id
changed.

**Change configuration only** → edit `values-<env>.yaml` and `helm upgrade`; secrets
change in Secrets Manager and are picked up on the next refresh (or restart the pod).

> The images build on **Node 22**. A dependency uses `util.markAsUncloneable`; on
> Node 20 `next build` fails with `markAsUncloneable is not a function`.

---

## 2. What runs where

One EKS cluster per environment, one Kubernetes namespace, one Helm release with six
Deployments. Every image is built from the same commit; `deploy/modules.json` says
which routes, assets and Node heap each one owns.

| Image | URL prefixes | Needs |
|-------|--------------|-------|
| `home` | `/`, `/home`, `/settings`, `/register`, password pages, `/api/auth`, `/api/user`, `/api/platform-theme`, and everything nobody else owns (`public/`) | database |
| `support-engineer` | `/chat`, `/reports`, `/api/chat`, `/api/conversations`, `/api/messages`, `/api/artifacts`, `/api/files`, `/api/memory`, `/api/mcp`, `/api/fabinsight` | largest heap, invoke MCP Lambdas, user-upload bucket |
| `master-data-load` | `/modeling-agent`, `/api/modeling-agent`, `/api/cmf` | `templates/`, VPN route to CMF, staging bucket |
| `coding-agent` | `/backend-agent`, `/api/backend-agent` | `po-ui-assets/`, writable `PO_UI_RUNS_DIR` on EFS, one replica |
| `admin` | `/admin`, `/api/admin` | the on-the-fly MCP deploy permissions (§6), and nothing else gets them |
| `fabinsight` | no public route; `/api/health` on its own port | `REPORT_SCHEDULER_ENABLED=true`, exactly one replica, `Recreate` strategy |

Every web image runs with `REPORT_SCHEDULER_ENABLED=false`; only `fabinsight` runs
the scheduler (compile jobs, refresh, expiry, alerts, baselines, shift summaries, MCP
health checks) and the session-log retention sweep.

---

## 3. Architecture

```
 browser ──HTTPS──▶ CloudFront ──▶ ALB (path rules per image) ──▶ pods (private subnets)
                                                                    │
            ┌───────────────────────────────────────────────────────┼──────────────┐
            │  application VPC                                      │              │
            │   private subnets: nodes + pods + Lambdas             ▼              │
            │   ├─ RDS PostgreSQL (same VPC, app tier allowed on 5432)             │
            │   ├─ Secrets Manager interface endpoint                              │
            │   ├─ NAT gateway ──▶ Anthropic API, AWS APIs, ECR                    │
            │   └─ virtual private gateway ──▶ Site-to-Site VPN ──▶ on-prem CMF    │
            │  public subnets: the ALB only                                        │
            └──────────────────────────────────────────────────────────────────────┘
```

- **Edge.** CloudFront is the only public entry. The ALB accepts requests only from
  CloudFront's origin-facing address ranges **and** only when they carry the
  origin-verify header the edge stack was deployed with; everything else gets 403.
  ALB path rules mirror `deploy/modules.json` (admin first, home catch-all last), and
  each image serves its static assets under `/_fab/<image>/` so six builds share one
  origin. Pods join the target groups through `TargetGroupBinding` objects created by
  the Helm chart.
- **CMF.** SQL Server and the CMF REST API are on-prem, reached over the VPN from
  the private subnets. The VPN is AWS-to-site and always up; it does not depend on
  anyone's laptop VPN. `master-data-load` pods and the MCP Lambdas that query CMF use
  a security group whose egress allows SQL Server (1433) towards the on-prem range.
- **MCP servers.** Every MCP server the chat and the scheduler use is a Lambda in
  the same private subnets, invoked through the Lambda API (`lambda-invoke://` URLs in
  the registry). The `support-engineer` and `fabinsight` pod roles may invoke them;
  only the `admin` pod role may create them (§6).
- **Database.** RDS PostgreSQL in the same VPC, `TimeZone = UTC`. It is small: keep
  `PG_POOL_MAX` low on every module and the chat at two replicas at most.
- **Identity.** Each module runs under its own IAM role through EKS Pod Identity;
  nothing carries static AWS keys.

---

## 4. Infrastructure as code

The network (VPC, subnets, NAT, VPN, RDS, VPC endpoints) is owned by **Terraform**
outside this repo and is only referenced by id. Everything the application needs on
top of it is CloudFormation under `deploy/cloudformation/`, deployed in this order
(commands in `deploy/cloudformation/eks/README.md`):

| # | Template | Owns |
|---|----------|------|
| 1 | `ecr.yaml` | one ECR repository per module image |
| 2 | `eks/eks-cluster.yaml` | EKS control plane, managed node group, node security group, add-ons (VPC CNI, CoreDNS, kube-proxy, Pod Identity agent, metrics-server, EFS CSI, CloudWatch observability) |
| 3 | `eks/eks-edge.yaml` | ALB, listener and path rules, target groups, EFS for Coding Agent runs, CloudFront distribution |
| 4 | `eks/eks-workload-iam.yaml` | Pod Identity roles per module, the load-balancer controller role, the External Secrets role |
| 5 | `eks/eks-build.yaml` | CodeBuild batch that builds the six images from a source zip |
| 6 | `eks/eks-logs.yaml` | saved CloudWatch Logs Insights queries |
| 7 | `eks/eks-cicd.yaml` | in-VPC CodeBuild deploy project (helm) with an EKS access entry; the permissions the GitHub Actions OIDC role needs |

Then two cluster controllers by Helm (AWS Load Balancer Controller, External Secrets
Operator) and the application chart `deploy/helm/faborchestrator`.

`platform.yaml`, `service.yaml`, `networking.yaml`, `iam.yaml`, `cloudfront.yaml` and
`deploy/scripts/aws-deploy.sh` are the earlier **ECS/Fargate** path. They are kept for
reference and are not what runs today. `mcp-onthefly.yaml` describes the on-the-fly
MCP substrate for that path; on EKS the equivalent resources are provisioned as
described in §6.

Review a change set before touching a live stack:
`aws cloudformation deploy … --no-execute-changeset`.

---

## 5. Configuration

`deploy/helm/faborchestrator/values.yaml` holds the defaults shared by every
environment (module list, replicas, heap sizes, resources, autoscaling).
`values-<env>.yaml` holds what differs per environment. Secrets never go in either;
they are Secrets Manager entries that the chart maps to environment variables.

### Core
| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | built by the chart from the DB user, host, port, name and the password secret |
| `ANTHROPIC_API_KEY` | server-side Claude key (secret) |
| `KEY_ENCRYPTION_SECRET` | AES-256-GCM key, 64 hex chars (secret). One key for the whole platform; to rotate it run `node scripts/admin/reencrypt-encryption-key.mjs` first |
| `APP_URL` | the one public origin; every email link is built from it |
| `NODE_OPTIONS` | set by the chart from each module's `heapMb` |
| `PG_POOL_MAX` | Prisma pool size per pod; keep the total well under the RDS connection limit |
| `SMTP_SERVER`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` | invitation, password-reset, dashboard-live, alert and health-change emails |
| `REPORT_SCHEDULER_ENABLED` | `true` on `fabinsight` only |
| `CHAT_THINKING_EFFORT` | optional: `low` / `medium` / `high` (default) / `max` |
| `CHAT_PROGRESS_EVERY` | optional: tool calls a chat turn may make in silence before the model writes a short progress note (default 8, 0 = off) |
| `MCP_HEALTH_INTERVAL_MS`, `MCP_HEALTH_PROBE_MODEL` | MCP health check interval (default 5 min) and the model that picks a data probe when no obvious tool exists |

`NEXT_PUBLIC_*` variables are inlined at build time; changing one needs a new image.

### Master Data Load (CMF)
| Var | Purpose |
|-----|---------|
| *(none needed for the databases)* | The databases the Master Data Load agent can use are ONLY the enabled rows in Admin → Database Connections (`cmf_connections`), per user grants. There is no env-configured default database. |
| `CMF_BUILTIN_PROFILES` | **Local development only.** `1` adds two env-driven profiles (`source` from `CMF_SQL_SERVER`/`CMF_SQL_INSTANCE`/`CMF_SQL_DB`/`CMF_SQL_USER`/`CMF_SQL_PASS`/`CMF_BASE_URL`/`HOST_RESOLVER`/`CMF_TOKEN_SECRET_ID`, `target` from their `_TARGET` twins). Never set it in a deployed environment. |
| `CMF_TLS_INSECURE` | CMF REST TLS policy (`0` verifies certificates) |
| `TOKEN_SAFETY_MARGIN_SEC` | how close to expiry a stored CMF bearer token counts as expired (default 60 s) |
| `CMF_TOKEN_REFRESH_MIN`, `CMF_TOKEN_RETRY_MIN`, `CMF_TOKEN_SAVE_TIMEOUT_MS` | **CMF token refresh is in-app.** The `fabinsight` worker logs in to the CMF portal for every enabled connection in Admin → Database Connections and writes the bearer token to `cmf_bearer_tokens` every 45 min (retry 5 min after a failure); the `admin` pod fetches it immediately when a connection is saved or "Refresh token now" is clicked. Nothing to provision; the pods need the VPN route to the CMF portal (`:443` and `:9091`). |
| `CMF_CHROMIUM_PATH` | the Chromium the portal login runs in. `deploy/Dockerfile.image` installs it in the `fabinsight` and `admin` images and sets this to `/usr/bin/chromium-browser`; give those two containers ~512 MB of memory headroom for the browser |
| `CMF_TOKEN_PROVISIONER` | legacy: `lambda` makes the Admin Console provision the per-connection `cmf-token-<key>` Lambda + EventBridge schedule instead (needs `CMF_LAMBDA_*` and the workload-IAM switch, §6). Default: in-app. |
| `CMF_TOKEN_REGION`, `CMF_TOKEN_SECRET_ID` | legacy fallback only: a connection whose row still names a Secrets Manager secret is read from there when the token table has no fresh token |
| `S3_BUCKET` | staging bucket for uploaded and generated workbooks |
| `S3_UPLOAD_BUCKET`, `S3_PRESIGN_TTL_SECONDS` | user uploads for chat |

### Coding Agent
| Var | Purpose |
|-----|---------|
| `PO_UI_RUNS_DIR` | run output; an EFS access point mounted by the chart (`runsVolume`) |
| `PO_UI_ASSETS_DIR` | only if the client evidence corpus is not at `po-ui-assets/` inside the image |
| `BACKEND_AGENT_REQUIRE_PERMISSION` | `1` turns on the role check |

### Admin Console
| Var | Purpose |
|-----|---------|
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | bootstrap user for `npm run db:seed` only. The built-in **Admin** role needs no setup: every boot creates or repairs it (`ensureAdminRole`); `prisma/ensure_admin_role.sql` does the same for a database provisioned before the app starts |
| `MCP_OTF_*` | on-the-fly MCP provisioning, §6 |
| `CMF_LAMBDA_*` | legacy/optional: only with `CMF_TOKEN_PROVISIONER=lambda`, §6 |

Admins sign in through the normal login and open the Admin Console from the cockpit
profile menu or the chat sidebar. `/admin/*` and `/api/admin/*` are gated by
`requireAdmin`. There is no separate admin login, token or domain.

### IAM per module (Pod Identity roles, `eks-workload-iam.yaml`)
| Module | Grants |
|--------|--------|
| `support-engineer` | read/write the user-upload bucket; invoke the MCP Lambdas |
| `fabinsight` | invoke the MCP Lambdas (dashboard replay, health checks) |
| `master-data-load` | read/write the staging bucket; (legacy) read the CMF token secret |
| `admin` | the on-the-fly MCP deploy policy (§6); legacy/optional: CMF token Lambda provisioning |
| `home`, `coding-agent` | none |

---

## 6. On-the-fly MCP servers

The Admin Console turns a database's credentials into a private MCP server: intake →
connectivity test → schema discovery → code generation → **deploy a per-source Lambda**
→ register and assign. The `admin` pod does the deploying through the Lambda API, so
the following must already exist in the environment's account and VPC. None of it is
created by the EKS stacks; check each item before the first use of the feature.

| Piece | Purpose | Env var on `admin` |
|-------|---------|--------------------|
| Runtime execution role | shared by every generated server; VPC access plus read of `mcp/onthefly/*` secrets | `MCP_OTF_RUNTIME_ROLE_ARN` (deploy refuses without it) |
| Artifact bucket with `runtime-base/<version>.zip` and `runtime-base/<version>-mssql.zip` | base runtimes the generated code is layered onto (`lambda/mcp-onthefly/runtime*`) | `MCP_OTF_ARTIFACT_BUCKET`, `MCP_OTF_RUNTIME_VERSION` |
| Discovery Lambda | reads `information_schema` from inside the VPC (`lambda/mcp-onthefly/discovery`) | `MCP_OTF_DISCOVERY_FUNCTION` |
| Subnets + security group for Postgres targets | egress 5432 | `MCP_OTF_SUBNET_IDS`, `MCP_OTF_SECURITY_GROUP_ID` |
| Subnets + security group for SQL Server targets | egress **1433 towards the on-prem range** over the VPN; the Postgres-only runtime group is not enough | `MCP_OTF_CMF_SUBNET_IDS`, `MCP_OTF_CMF_SECURITY_GROUP_ID` |
| Admin deploy policy on the `admin` pod role | create/update/delete `mcp-otf-*` functions, `iam:PassRole` on the runtime role only, `ec2:Describe*` for VPC placement, `mcp/onthefly/*` secrets, the artifact bucket | attached by `eks-workload-iam.yaml` |

**Provisioning the discovery Lambda** (once per environment, and again after its code
changes):

```bash
cd faborchestrator
node lambda/mcp-onthefly/discovery/build.mjs            # → lambda/mcp-onthefly/discovery-v1.zip
# with the environment's MCP_OTF_* values and admin credentials in the shell:
node scripts/admin/deploy-discovery-lambda.mjs
```

The function needs the runtime role, the private subnets and security groups that
reach **both** database kinds. If it is missing, "Discover" fails with a
function-not-found error and every existing on-the-fly server shows **Server down** in
the health check, because their functions are also absent.

**CMF token Lambdas are legacy.** The CMF bearer token is refreshed in-app (the
`fabinsight` worker's `cmf-token` stage and the `admin` pod on save — see the Master
Data Load variables in §5); nothing is provisioned per connection and the
`EnableCmfTokenProvisioning` switch on the workload IAM stack stays off. Only if an
environment must keep the old per-connection `cmf-token-<key>` Lambdas for a release:
set `CMF_TOKEN_PROVISIONER=lambda` and the `CMF_LAMBDA_*` variables on `admin`, and turn
the switch on (`lambda/cmf-token` still holds the function's source).

Code-generation tuning (`MCP_OTF_MAX_TOOLS`, `MCP_OTF_CODEGEN_MAX_TABLES`,
`MCP_OTF_CODEGEN_MAX_TOKENS`, `MCP_OTF_CODEGEN_MAX_COLS`, `MCP_OTF_CODEGEN_MODEL`) has
safe code defaults.

---

## 7. Routine deploy

Images are built in **CodeBuild from the committed code**: no Docker on a laptop and
no GitHub access from AWS.

### From GitHub Actions (normal path)

**Actions → Deploy → Run workflow**: "Use workflow from" = the branch, environment,
then tick the modules (or **All modules**).

```
plan    package the commit to S3; images already in ECR for this commit are reused
build   CodeBuild <env>-eks-images, only the ticked modules          (~10–15 min)
deploy  waits for a reviewer of the GitHub environment → approve →
        CodeBuild <env>-eks-deploy (in the VPC) runs deploy/scripts/ci-deploy.sh:
        ticked modules → this commit, every other module keeps its running image,
        helm upgrade --atomic (failed rollout rolls itself back), page smoke test
```

- **Reviewers** are set on the GitHub environment (Settings → Environments). They get
  an email / GitHub notification and approve on the run page ("Review deployments").
- **Which modules:** one module for a change inside that module; **All modules** for a
  database change (apply the schema change first, never `prisma db push`) or a change
  under `shared/`, `prisma/` or `deploy/helm/`.
- **Rollback:** Actions → **Rollback** (empty revision = previous), same approval.
- The workflows live in `.github/workflows/` and must exist on the default branch for
  the Run button to appear; a branch without `deploy/helm/` stops at the plan step.
- AWS side: the OIDC role (Terraform) plus `eks/eks-cicd.yaml`. GitHub never talks to
  the cluster; the deploy CodeBuild reaches its private endpoint.

### By hand

```bash
cd faborchestrator
git status --porcelain -- .          # uncommitted changes are NOT built
deploy/scripts/aws-build-images.sh   # git archive HEAD → S3 → CodeBuild batch → ECR <prefix>/<module>:<commit> and :latest
REF=<commit> deploy/scripts/aws-build-images.sh   # build another commit
IMAGES=admin,home deploy/scripts/aws-build-images.sh   # only these images

# roll the release to that tag
helm upgrade --install faborchestrator deploy/helm/faborchestrator \
  -n faborchestrator --create-namespace \
  -f deploy/helm/faborchestrator/values-<env>.yaml \
  -f deploy/helm/faborchestrator/values-<env>.secret.yaml \   # only if it exists
  --set image.tag=<commit>           # or --set-string modules.<module>.tag=<commit> per module

kubectl -n faborchestrator rollout status deploy/<module>   # per module
kubectl -n faborchestrator get pods
```

- **Which modules a change touches:** `node deploy/scripts/module-closure.mjs --affected <file>`.
  Everything is rebuilt anyway; the tag is what matters.
- **Rollback:** `helm rollback faborchestrator <revision>` or `helm upgrade … --set image.tag=<previous commit>`.
- **Verify:** log in, open the cockpit, `/chat`, `/admin` and `/admin/errors`; the MCP
  health pills on the admin MCP page and the cockpit should be green within one
  scheduler tick.
- **Rolling updates:** `support-engineer` and `coding-agent` wait up to two minutes for
  streaming chats to finish; `fabinsight` and `coding-agent` use `Recreate` so two
  schedulers or two EFS writers never overlap.

Settings that must stay in place at the edge: ALB idle timeout long enough for
streaming replies, CloudFront origin read timeout raised for the same reason, request
body limit large enough for master-data workbooks, health check `GET /api/health`.

---

## 8. Database

Migrations are **not** run by the deploy and `prisma db push` is never used on a
shared database. Apply the SQL under `prisma/` by hand, in a `psql` session against the
target database, before rolling out code that needs the new schema. The files are
additive and idempotent:

`create_cmf_dataloader.sql`, `create_dashboards.sql`, `create_prompt_chips.sql`,
`update_model_registry_tiers.sql`, `add_mcp_agent.sql`, `ensure_admin_role.sql`,
`create_mcp_health.sql` (plus the older `create_*` / `alter_*` files that every
environment already has).

The database must run with `TimeZone = UTC`; a non-UTC setting shifts every raw-query
timestamp.

**Fresh database** (new environment, or a deliberate wipe): `scripts/db/fresh-database.sh`
drops every schema, creates the tables from `prisma/schema.prisma`, adds the indexes
Prisma cannot express (`prisma/fresh_extras.sql`), seeds configuration only (platform
settings, the four platform models, default prompt chips, the built-in Admin role, the
role templates) and one admin user who must change the password at first login. It
prints a dry run unless given `--yes`. For an RDS instance run it from inside the VPC
through the environment's CodeBuild migration project with
`scripts/db/fresh-database.buildspec.yml`, which takes a compressed backup to the
artifact bucket before dropping anything. MCP servers, data sources, dashboards and
connections are created in the Admin Console afterwards, never seeded.

---

## 9. Monitoring and troubleshooting

Container logs go to CloudWatch through the observability add-on, one stream per pod,
under `/aws/containerinsights/<cluster>/application`; control-plane logs under
`/aws/eks/<cluster>/cluster`; image builds under `/codebuild/<project>`. Retention is
set by command, not by CloudFormation (see the EKS README). Saved Logs Insights
queries (one per module, errors across modules, error counts) are installed by
`eks-logs.yaml`. Quick look without the console:

```bash
kubectl -n faborchestrator logs deploy/<module> --since=10m
```

| Symptom | Cause / fix |
|---------|-------------|
| 403 straight from the ALB | request did not come through CloudFront, or the origin-verify secret differs between the edge stack and CloudFront |
| Pod `CrashLoopBackOff` right after start | missing secret in Secrets Manager or the External Secrets role cannot read it; `kubectl describe externalsecret` |
| Chat: `CMF SQL not configured` | `CMF_SQL_*` missing on `master-data-load` |
| Loader: `File storage (S3) request failed: NoSuchBucket` / `AccessDenied` | `S3_BUCKET` names a bucket in another account, or the pod role lacks the bucket grant |
| Loader: token failure ("No valid CMF token is available") | the connection's portal login is failing — Admin → Database Connections shows `In-app · failed: <reason>` in the Refresher column; fix the portal user / password and click "Refresh token now". If every connection shows "waiting for the first refresh", the `fabinsight` worker is not running the scheduler or has no Chromium (`CMF_CHROMIUM_PATH`; error log system "CMF portal login") |
| Admin → MCP: `Discover` fails with function not found | discovery Lambda not provisioned in this account (§6) |
| Admin → MCP: SQL Server source times out on deploy/probe | the CMF security group has no 1433 egress to the on-prem range |
| Health check: many servers **Server down** at once | the registry points at Lambda functions that do not exist in this account |
| Health check: **DB not reachable** | the Lambda is up but its target database refuses the probe; check the secret and the security group |
| Too many DB connections | lower `PG_POOL_MAX` or replicas; the RDS instance is small |

---

## 10. Run the six images locally

```bash
cd faborchestrator
cat > deploy/.env.local-docker <<'EOF2'
DATABASE_URL=postgresql://<user>@host.docker.internal:5432/faborch_local
APP_URL=http://localhost:8080
SMTP_SERVER=
EOF2
docker compose -f deploy/docker-compose.local.yml up --build   # six images + router on :8080
docker compose -f deploy/docker-compose.local.yml ps           # all "healthy"
node deploy/scripts/module-closure.mjs                         # what each image contains
```

`deploy/Dockerfile.image` (`ARG IMAGE=<name>`) copies the tree, runs
`deploy/scripts/prune-for-image.mjs` (keeps the common files and that image's routes,
no-ops `instrumentation.ts` on web images, drops unreachable modules and asset
folders), then `prisma generate` and `next build` with `assetPrefix=/_fab/<image>`.
`deploy/scripts/local-router.mjs` plays the ALB path rules on one port.

Cross-image navigation: each build has its own `deploymentId` (`<image>.<stamp>`) and
`proxy.ts` answers an RSC request carrying another image's id with an empty HTML
response, so a link that crosses images becomes a plain page load and no runtime is
shared between images.

---

## 11. Retired

The single-container **Elastic Beanstalk** environments (Fab app and the separate
admin app) and the earlier **App Runner** service are superseded by the EKS
deployment above. Keep an old environment only until the cut-over is confirmed, then
terminate it and remove its database security-group rule.
