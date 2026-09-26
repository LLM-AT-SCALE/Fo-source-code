import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { readState } from '@/modules/coding-agent/lib/state';
import { unitEntries } from '@/modules/coding-agent/lib/unit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * ONE FILE OUT OF THE DEPLOYMENT UNIT, as text, so the panel can show it.
 *
 * The standalone lets an engineer click an artifact in the transcript and read
 * the code beside the conversation that produced it. That is the review step:
 * the XML is what actually reaches a tenant, and a validator verdict of "25
 * passed" is a summary, not a substitute for looking.
 *
 * SERVED FROM THE UNIT, not from a path in the query string. The unit is the
 * exact set of files the download contains, so this can only ever return
 * something that is genuinely part of the deliverable — and a name that is not
 * in it is a 404 rather than an arbitrary read of the server's disk.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const conversationId = searchParams.get('conversationId') ?? '';
  const name = searchParams.get('name') ?? '';
  const page = searchParams.get('page') ?? undefined;

  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: auth.user.id, deletedAt: null },
    select: { id: true },
  });
  if (!owned) {
    return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  }

  /* The PRD is not in the unit — it is the specification, not an artifact that
     ships — but it is the one other thing worth opening in the panel. */
  if (name === 'PRD.md') {
    const prd = readState(conversationId).prdMarkdown;
    return prd
      ? NextResponse.json({ name, language: 'markdown', content: prd })
      : NextResponse.json({ error: 'No PRD has been written yet.' }, { status: 404 });
  }

  const state = readState(conversationId);
  const artifact = page
    ? state.artifacts.find((a) => a.name === page)
    : state.primary;
  if (!artifact) {
    return NextResponse.json(
      { error: 'Nothing has been generated in this conversation yet.' },
      { status: 404 },
    );
  }

  /*
   * MATCHED ALLOWING FOR THE UNIT'S IMPORT-ORDER PREFIX.
   *
   * The pipeline reports the page it wrote as `<Page>.xml`; the unit stores it as
   * `300_<Page>.xml`, because the number is what carries import order — queries
   * first, then the page, then the master data. Both names are right for their
   * own purpose, and an exact match between them fails: clicking the page
   * artifact in the transcript answered "the unit does not contain
   * CustomProductionOrderManagementUI.xml", which is true and useless.
   *
   * Exact match first, so a file whose real name begins with digits can never be
   * shadowed by the fallback. The fallback strips only a LEADING run of digits
   * and one separator, which is the whole of the convention.
   */
  const entries = unitEntries(artifact.dir, artifact.name);
  const bare = (n: string): string => n.replace(/^\d+[_-]/, '');
  const hit = entries.find((e) => e.name === name)
    ?? entries.find((e) => bare(e.name) === bare(name));
  if (!hit) {
    return NextResponse.json(
      { error: `The unit does not contain "${name}".` },
      { status: 404 },
    );
  }

  const content = typeof hit.data === 'string' ? hit.data : hit.data.toString('utf-8');
  const language = name.endsWith('.xml')
    ? 'xml'
    : name.endsWith('.json')
      ? 'json'
      : name.endsWith('.md')
        ? 'markdown'
        : 'text';

  return NextResponse.json({ name, language, content });
}
