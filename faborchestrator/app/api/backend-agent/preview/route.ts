import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { loadPipelineConfig } from '@/lib/po-ui/generate/config';
import { rawSettings } from '@/lib/po-ui/generate/assemble';
import { loadLabels, renderPreview, type PageJson } from '@/lib/po-ui/render/preview';
import {
  DESCRIPTOR_PREVIEW_NOTE,
  pageJsonFromDescriptor,
  pageToPreview,
} from '@/lib/po-ui/render/from-descriptor';
import { parseDescriptor } from '@/lib/po-ui/descriptor';
import { readState, specIsNewerThanArtifact } from '@/modules/coding-agent/lib/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function settingsOf(xmlPath: string): PageJson {
  const raw = rawSettings(readFileSync(xmlPath, 'utf-8'));
  if (raw === null) throw new Error('that artifact carries no <Settings> payload');
  return JSON.parse(
    raw
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#xD;/g, '\r')
      .replace(/&#xA;/g, '\n')
      .replace(/&#x9;/g, '\t')
      .replace(/&amp;/g, '&'),
  ) as PageJson;
}

/**
 * The mock screen, rendered the way the CMF client renders it.
 *
 * WHICHEVER OF THE TWO IS NEWER — the generated artifact, or the specification
 * it was built from. Deciding on existence alone ("an artifact exists, so show
 * the artifact") is wrong the moment an engineer revises the PRD of a page that
 * has already been generated: the descriptor gains a field, the artifact does
 * not, and the reader is shown the old screen while being told it carries the
 * change. Measured on the standalone app, 2026-09-02, on the step whose entire
 * purpose is to confirm a change by looking at it.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const conversationId = searchParams.get('conversationId') ?? '';

  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: auth.user.id, deletedAt: null },
    select: { id: true },
  });
  if (!owned) {
    return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  }

  const state = readState(conversationId);
  const cfg = loadPipelineConfig();
  const fromSpec = !state.primary || specIsNewerThanArtifact(state);

  try {
    if (fromSpec && state.descriptorPath && existsSync(state.descriptorPath)) {
      const d = parseDescriptor(
        JSON.parse(readFileSync(state.descriptorPath, 'utf-8')),
        'descriptor.json',
      );
      // Prefer the page this conversation actually built, so the preview and the
      // download never show different screens.
      const page = pageToPreview(d, state.primary?.name);
      if (page) {
        const html = renderPreview(
          pageJsonFromDescriptor(page, cfg.page.layoutColumns),
          {
            title: page.name,
            source: DESCRIPTOR_PREVIEW_NOTE,
            origin: state.primary
              ? 'the requirement as it now stands — the generated page is older than this'
              : 'the requirement document, before any code is generated',
          },
        );
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    }

    if (!state.primary) {
      return NextResponse.json(
        { error: 'There is nothing to draw yet.' },
        { status: 404 },
      );
    }

    loadLabels(cfg.packageDir);
    const html = renderPreview(settingsOf(state.primary.xmlPath), {
      title: state.primary.name,
      source: state.storyName ?? 'generated',
    });
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (e) {
    return NextResponse.json(
      { error: `The screen could not be drawn: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
