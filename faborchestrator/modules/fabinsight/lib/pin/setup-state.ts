/**
 * Where a pinned dashboard stands before it has a refresh program of its own.
 *
 * A dashboard pinned from the chat is live at once and shows the pinned HTML as
 * its snapshot. Until a compile is published into it (current_version_id set):
 *   - `static`: pinned as a snapshot — never refreshed, by design;
 *   - `preparing`: scheduled, automatic refresh is still being set up;
 *   - `setup_failed`: scheduled, but setting up automatic refresh failed (an admin
 *     can retry from the request; the error log has the cause).
 * `null` = a normal dashboard (it has a version) or one with no pin record.
 */

import { prisma } from '@/shared/lib/db';
import type { PinSetup } from '@/modules/fabinsight/lib/pin/options';

export { PIN_SETUP_TEXT, type PinSetup } from '@/modules/fabinsight/lib/pin/options';

type Row = { id: string; currentVersionId: string | null; sourceRequestId: string | null };

export async function pinSetupStates(rows: Row[]): Promise<Map<string, PinSetup>> {
  const out = new Map<string, PinSetup>();
  const pending = rows.filter((r) => !r.currentVersionId && r.sourceRequestId);
  if (!pending.length) return out;
  const requests = await prisma.dashboardRequest.findMany({
    where: { id: { in: pending.map((r) => r.sourceRequestId!) } },
    select: { id: true, status: true, decision: true },
  });
  const byId = new Map(requests.map((r) => [r.id, r]));
  for (const r of pending) {
    const req = byId.get(r.sourceRequestId!);
    if (!req) continue;
    const type = (req.decision as { type?: unknown } | null)?.type;
    if (type === 'static') out.set(r.id, 'static');
    else if (['approved', 'compiling', 'preview_ready'].includes(req.status)) out.set(r.id, 'preparing');
    else if (['compile_failed', 'denied', 'requested'].includes(req.status)) out.set(r.id, 'setup_failed');
  }
  return out;
}
