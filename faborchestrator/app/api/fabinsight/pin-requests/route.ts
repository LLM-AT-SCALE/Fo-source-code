import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { dashboardAccess } from '@/modules/fabinsight/lib/access';
import { sendMail } from '@/modules/fabinsight/lib/mailer';
import { extractKpis } from '@/modules/fabinsight/lib/pin/kpis';
import { buildTrace, traceServers, type KnownConnection, type TraceStep } from '@/modules/fabinsight/lib/pin/trace';
import { parsePinChoices, type PinChoices } from '@/modules/fabinsight/lib/pin/options';
import { scopeFromTrace } from '@/modules/fabinsight/lib/pin/scope';
import { createPinnedDashboard, describeSchedule, type RequestDecision } from '@/modules/admin/lib/dashboards/dashboard-service';
import { ADMIN_ROLE_NAME } from '@/shared/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_HTML_BYTES = 2_000_000;

/**
 * POST — pin a chat dashboard.
 *
 * Body: {title, html, messageId, artifactIdentifier?, type:'static'|'scheduled',
 *        schedule?, from?, to?, noExpiry?, visibility:{mode:'all'|'roles'|'me', roleIds?}}
 *
 * Any user whose role has the `dashboards` permission may pin. What happens next
 * depends on who pins:
 *  - a platform admin: the dashboard goes live at once. Static → the pinned HTML
 *    is its snapshot, never refreshed. Scheduled → it shows the pinned snapshot
 *    while a compile job (queued here, servers taken from the trace) builds the
 *    replay program; the compile publishes itself with the chosen schedule,
 *    dates and visibility. → 201 {status:'live', dashboardId, url, type, preparing}
 *  - anyone else: a `dashboard_requests` row carrying their choices (so the
 *    approval screen is pre-filled) and an email to the admins.
 *    → 201 {status:'requested', requestId}
 */
/**
 * The pin itself can fail on a database write (lookup, insert). Those threw
 * straight out of the handler as a bare 500, which the chat showed as "Could
 * not send this request (500)" with nothing recorded. Route every unexpected
 * failure through the catalog: the user gets its message and an error id, and
 * the record lands in the admin error log.
 */
export async function POST(request: NextRequest) {
  try {
    return await handlePinRequest(request);
  } catch (e) {
    return handleApiError(e, request, { route: '/api/fabinsight/pin-requests' });
  }
}

async function handlePinRequest(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const access = await dashboardAccess(auth.user.id);
  if (!access.canPin) {
    return NextResponse.json({ error: 'Your role cannot pin dashboards. Ask an admin to enable Dashboard Scheduling for your role.' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const title = String(body.title ?? '').trim().slice(0, 120);
  const html = typeof body.html === 'string' ? body.html : '';
  const messageId = typeof body.messageId === 'string' ? body.messageId : '';
  const artifactIdentifier = typeof body.artifactIdentifier === 'string' ? body.artifactIdentifier.slice(0, 200) : null;

  if (!title) return NextResponse.json({ error: 'A dashboard name is required.' }, { status: 400 });
  if (!html.trim()) return NextResponse.json({ error: 'The dashboard has no content to pin.' }, { status: 400 });
  if (html.length > MAX_HTML_BYTES) return NextResponse.json({ error: 'This dashboard is too large to pin.' }, { status: 413 });
  if (!messageId) return NextResponse.json({ error: 'Cannot pin: the dashboard is not linked to a saved message yet. Wait for the reply to finish, then try again.' }, { status: 400 });

  const now = new Date();
  const choices = parsePinChoices(body, now);
  if ('error' in choices) return NextResponse.json({ error: choices.error }, { status: 400 });

  // Roles must exist (a stale dialog could send a deleted one).
  if (choices.roleIds.length) {
    const found = await prisma.role.findMany({ where: { id: { in: choices.roleIds } }, select: { id: true } });
    if (found.length !== choices.roleIds.length) {
      return NextResponse.json({ error: 'One of the selected roles no longer exists. Reopen Pin and choose again.' }, { status: 400 });
    }
  }

  // The message must belong to the requester's own conversation. The chat route
  // persists the stream's message id, so a live-turn id normally matches; older
  // turns fall back to the artifact identifier inside the persisted text.
  const messageSelect = { id: true, parts: true, conversationId: true, conversation: { select: { activeMcpIds: true } } } as const;
  let message = await prisma.message.findFirst({
    where: { id: messageId, conversation: { userId: auth.user.id } },
    select: messageSelect,
  });
  if (!message && artifactIdentifier) {
    message = await prisma.message.findFirst({
      where: {
        role: 'assistant',
        conversation: { userId: auth.user.id },
        content: { contains: `identifier="${artifactIdentifier}"` },
      },
      orderBy: { createdAt: 'desc' },
      select: messageSelect,
    });
  }
  if (!message) return NextResponse.json({ error: 'Cannot pin: the message this dashboard came from was not found.' }, { status: 404 });

  // Connections active in that conversation resolve legacy (un-namespaced) parts
  // and give the trace human-readable server names.
  const activeIds = Array.isArray(message.conversation.activeMcpIds)
    ? (message.conversation.activeMcpIds as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const known: KnownConnection[] = activeIds.length
    ? (
        await prisma.mcpConnection.findMany({
          where: { id: { in: activeIds } },
          select: { id: true, name: true, serverUrl: true, registryId: true },
        })
      ).map((c) => ({ id: c.id, name: c.name, serverUrl: c.serverUrl, registryId: c.registryId }))
    : [];

  const trace = buildTrace(message.parts, known);
  // A static snapshot needs no data calls; a scheduled one is rebuilt from them.
  if (!trace.length && choices.type === 'scheduled') {
    return NextResponse.json(
      { error: 'This dashboard was not built from connected data tools, so it cannot be refreshed on a schedule. Pin it as a static snapshot, or ask for it again with a data connection enabled.' },
      { status: 422 },
    );
  }

  const extracted = extractKpis(html);
  const kpis = extracted.kpis.map((k) => ({ label: k.label, key: k.key, source: k.source }));
  const servers = traceServers(trace);
  const base = { title, html, kpis, trace, messageId: message.id, conversationId: message.conversationId, artifactIdentifier };

  if (access.isAdmin) {
    const out = await pinLive({ ...base, adminId: auth.user.id, choices, now });
    return NextResponse.json(
      { status: 'live', type: choices.type, dashboardId: out.dashboardId, url: `/reports?d=${encodeURIComponent(out.dashboardId)}`, preparing: choices.type === 'scheduled' },
      { status: 201 },
    );
  }

  const created = await prisma.dashboardRequest.create({
    data: {
      requesterId: auth.user.id,
      conversationId: message.conversationId,
      messageId: message.id,
      artifactIdentifier,
      title,
      reason: '',
      html,
      kpis,
      trace: JSON.parse(JSON.stringify(trace)),
      status: 'requested',
      // Not an approval yet: only what the requester chose, to pre-fill the admin's screen.
      decision: { requested: JSON.parse(JSON.stringify(choices)) },
    },
    select: { id: true, createdAt: true },
  });

  await audit(auth.user.id, 'dashboard.requested', created.id, { title, kpiCount: kpis.length, calls: trace.length, servers, type: choices.type });

  // Best-effort admin notification; the admin app's badge is the primary channel.
  void notifyAdmins({ requestId: created.id, title, requester: auth.user.email ?? auth.user.id, kpis: kpis.slice(0, 12).map((k) => k.label), choices });

  return NextResponse.json({ status: 'requested', requestId: created.id, type: choices.type }, { status: 201 });
}

type PinBase = {
  title: string;
  html: string;
  kpis: { label: string; key: string; source: string }[];
  trace: TraceStep[];
  messageId: string;
  conversationId: string;
  artifactIdentifier: string | null;
};

/**
 * An admin's pin: live at once. One transaction writes the request (kept as the
 * record, with the trace a later edit compiles from), the dashboard (the pinned
 * HTML is its snapshot) and — for a scheduled pin — the compile job, which
 * publishes itself into this dashboard when it is ready (decision.autoPublish).
 */
async function pinLive(p: PinBase & { adminId: string; choices: PinChoices; now: Date }): Promise<{ dashboardId: string; requestId: string }> {
  const { choices } = p;
  const visibility = { visibleToAll: choices.visibleToAll, roleIds: choices.roleIds, userIds: [] as string[] };
  const scheduled = choices.type === 'scheduled' && !!choices.schedule;
  const scope = scheduled ? await scopeFromTrace(p.trace) : ({ mode: 'all' } as const);

  const decision: Record<string, unknown> = scheduled
    ? ({
        type: 'scheduled',
        mode: 'create',
        targetDashboardId: null,
        connectionScope: scope,
        schedule: choices.schedule!,
        expiresAt: choices.expiresAt,
        startsAt: choices.startsAt,
        autoPublish: true,
        visibility,
        requested: JSON.parse(JSON.stringify(choices)),
        decidedById: p.adminId,
        decidedAt: p.now.toISOString(),
        note: null,
      } satisfies RequestDecision & { type: string })
    : {
        type: 'static',
        mode: 'create',
        targetDashboardId: null,
        visibility,
        requested: JSON.parse(JSON.stringify(choices)),
        decidedById: p.adminId,
        decidedAt: p.now.toISOString(),
        note: null,
      };

  const result = await prisma.$transaction(async (tx) => {
    const req = await tx.dashboardRequest.create({
      data: {
        requesterId: p.adminId,
        conversationId: p.conversationId,
        messageId: p.messageId,
        artifactIdentifier: p.artifactIdentifier,
        title: p.title,
        reason: '',
        html: p.html,
        kpis: p.kpis,
        trace: JSON.parse(JSON.stringify(p.trace)),
        status: scheduled ? 'approved' : 'live',
        decision: JSON.parse(JSON.stringify(decision)),
        decidedById: p.adminId,
        decidedAt: p.now,
      },
      select: { id: true },
    });
    const dash = await createPinnedDashboard(tx, {
      requestId: req.id,
      title: p.title,
      html: p.html,
      kpis: p.kpis,
      scope,
      expiresAt: choices.expiresAt ? new Date(choices.expiresAt) : null,
      visibility,
      adminId: p.adminId,
      requesterId: p.adminId,
      snapshotAt: p.now,
    });
    let jobId: string | null = null;
    if (scheduled) {
      const [job] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO dashboard_compile_jobs
           (id, kind, request_id, dashboard_id, base_version_id, connection_scope, status, created_by_id, created_at)
         VALUES (gen_random_uuid()::text, 'create', $1, NULL, NULL, $2::jsonb, 'queued', $3, now())
         RETURNING id`,
        req.id,
        JSON.stringify(scope),
        p.adminId,
      );
      jobId = job.id;
    }
    return { requestId: req.id, dashboardId: dash.id, slug: dash.slug, jobId };
  });

  const meta = { title: p.title, type: choices.type, direct: true, dashboardId: result.dashboardId, slug: result.slug, jobId: result.jobId, servers: traceServers(p.trace), schedule: choices.schedule ? describeSchedule(choices.schedule) : null, startsAt: choices.startsAt, expiresAt: choices.expiresAt, visibility };
  await audit(p.adminId, 'dashboard.requested', result.requestId, meta);
  await audit(p.adminId, scheduled ? 'report.request_approved' : 'report.dashboard_live', result.requestId, meta);
  return result;
}

async function audit(userId: string, action: string, targetId: string, metadata: Record<string, unknown>) {
  await prisma
    .$executeRawUnsafe(
      `INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'DashboardRequest', $3, $4::jsonb, now())`,
      userId,
      action,
      targetId,
      JSON.stringify(metadata),
    )
    .catch(() => {});
}

/** GET — the caller's own pin requests (newest first). */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.dashboardRequest.findMany({
    where: { requesterId: auth.user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, title: true, status: true, dashboardId: true, createdAt: true, decidedAt: true },
  });
  return NextResponse.json({ requests: rows });
}

/** The requester's choices in one line, for the admin email. */
function choicesText(c: PinChoices): string {
  const who = c.visibilityMode === 'all' ? 'all roles' : c.visibilityMode === 'me' ? 'only the requester' : `${c.roleIds.length} selected role${c.roleIds.length === 1 ? '' : 's'}`;
  if (c.type === 'static') return `Static snapshot, visible to ${who}`;
  const when = c.schedule ? describeSchedule(c.schedule) : 'on a schedule';
  const from = c.fromDate ? ` from ${c.fromDate}` : '';
  const to = c.toDate ? ` until ${c.toDate}` : ', no expiry';
  return `Refreshed ${when}${from}${to}, visible to ${who}`;
}

async function notifyAdmins(p: { requestId: string; title: string; requester: string; kpis: string[]; choices: PinChoices }) {
  try {
    const admins = await prisma.user.findMany({
      where: { status: 'ACTIVE', OR: [{ isAdmin: true }, { role: { name: ADMIN_ROLE_NAME } }, { role: { permissions: { array_contains: ['admin'] } } }] },
      select: { email: true },
    });
    const to = [...new Set(admins.map((a) => (a.email || '').trim().toLowerCase()).filter(Boolean))];
    if (!to.length) return;
    const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const link = `${base}/admin/dashboard-requests/${p.requestId}`;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
    const html = `
      <p><b>New dashboard request</b></p>
      <p><b>${esc(p.title)}</b> was pinned by ${esc(p.requester)}.</p>
      <p>Requested: ${esc(choicesText(p.choices))}.</p>
      ${p.kpis.length ? `<p>KPIs: ${p.kpis.map(esc).join(', ')}</p>` : ''}
      <p><a href="${link}">Review it in the Admin Console</a> — the requester's choices are already filled in.</p>`;
    await sendMail(to, `Dashboard request — ${p.title}`, html, 'FabOrchestrator Dashboards');
  } catch (e) {
    console.warn('[pin-requests] admin notification failed:', e instanceof Error ? e.message : e);
  }
}
