/**
 * GET /api/user/models
 * Returns models with user-facing labels.
 * Admin users see real model names. Regular users see custom labels.
 * Models not in user's role are returned as disabled (grayed out).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { getRegistryModels } from '@/shared/lib/model-registry';

// All platform models with custom labels for users — FALLBACK used whenever
// the shared model_registry table is empty or does not exist yet.
// 'available: true' = users can select it; 'available: false' = shown but grayed out (coming soon)
// Tiered by capability: the lower the number, the lower the tier.
const ALL_MODELS = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', label: 'FabOrchestrator 1', available: true },
  { id: 'claude-opus-5', name: 'Claude Opus 5', label: 'FabOrchestrator 2', available: true },
  { id: 'claude-fable-5', name: 'Claude Fable 5', label: 'FabOrchestrator 3', available: true },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', label: 'FabOrchestrator 4', available: true },
];

// The model selected by default (FabOrchestrator 4, the top tier).
const DEFAULT_MODEL_ID = 'claude-fable-5-1';

// Shape shared by both the registry-backed and hardcoded model lists.
type BaseModel = { id: string; name: string; label: string; available: boolean };

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const userWithRole = await prisma.user.findUnique({
      where: { id: auth.user.id },
      include: { role: true },
    });

    const isAdmin = (userWithRole as { isAdmin?: boolean })?.isAdmin || false;
    const allowedModelIds = userWithRole?.role?.allowedModels;
    const allowedList = Array.isArray(allowedModelIds) ? allowedModelIds as string[] : [];

    // Prefer the shared model_registry (managed in the Admin Console). If the table
    // is empty / missing / unreadable, getRegistryModels() returns null/[] and
    // we fall back to the hardcoded ALL_MODELS list.
    const registry = await getRegistryModels();
    const baseModels: BaseModel[] =
      registry && registry.length > 0
        ? registry.map((m) => ({
            id: m.modelId,
            name: m.displayName,
            label: m.displayName,
            available: true,
          }))
        : ALL_MODELS;

    // The registry's isDefault model, else the hardcoded default.
    const registryDefaultId =
      registry && registry.length > 0
        ? registry.find((m) => m.isDefault)?.modelId
        : undefined;
    const defaultModelId = registryDefaultId ?? DEFAULT_MODEL_ID;

    // Build model list with enabled/disabled status
    // A model is enabled only if: it's marked 'available' AND the user's role allows it
    const models = baseModels.map((m) => {
      const roleAllows = allowedList.length === 0 || allowedList.includes(m.id);
      const isEnabled = m.available && roleAllows;
      return {
        id: m.id,
        // Admin sees real names, users see custom labels
        name: isAdmin ? m.name : m.label,
        realName: m.name,
        label: m.label,
        enabled: isAdmin ? roleAllows : isEnabled,
      };
    });

    // Default to the registry/hardcoded default if enabled for this user, else first enabled.
    const enabledModels = models.filter((m) => m.enabled);
    const defaultModel =
      enabledModels.find((m) => m.id === defaultModelId)?.id ??
      enabledModels[0]?.id ??
      models[0]?.id ??
      DEFAULT_MODEL_ID;

    // `isAdmin` rides along so the chat can decide whether to offer the
    // "View error details" link. Without it the client shows every user a
    // control that only an admin can open, which lands them on a sign-in page.
    return NextResponse.json({ models, defaultModel, isAdmin });
  } catch (error) {
    console.error('Get models error:', error);
    return NextResponse.json({
      models: ALL_MODELS.map((m) => ({ id: m.id, name: m.label, enabled: true })),
      defaultModel: DEFAULT_MODEL_ID,
      // Fail closed: on the fallback path assume NOT an admin, so a failure
      // here can never expose an admin-only control.
      isAdmin: false,
    });
  }
}
