/**
 * Shared model registry loader.
 *
 * Source of truth (when present) is the `model_registry` table in RDS,
 * managed in the Admin Console. This module reads the active rows and exposes
 * the model list, per-token pricing, default model, allowed ids and
 * thinking config to the Fab app.
 *
 * Behaviour mirrors shared/lib/errors/error-catalog-loader.ts:
 *  - Lazy + cached: first call kicks an async refresh; the cache is reused
 *    on the hot path (TTL ~60s).
 *  - Fail-safe: ANY DB error (network blip, RDS unreachable, or the
 *    table not existing yet → Prisma "P2021" / "does not exist") is
 *    logged and swallowed. Callers get `null` / an empty list and MUST
 *    fall back to their hardcoded values. Model listing / chat must NEVER
 *    break because the registry is missing or empty.
 *  - Single-flight: concurrent refreshes collapse into one query.
 */
import { prisma } from '@/shared/lib/db';
import { logger } from '@/shared/lib/logger';

const TTL_MS = 60_000;

export interface RegistryModel {
  modelId: string;
  displayName: string;
  description: string | null;
  inputCostPer1M: number;
  outputCostPer1M: number;
  cacheReadCostPer1M: number;
  cacheWriteCostPer1M: number;
  thinkingType: string; // none | adaptive | manual
  thinkingBudget: number | null;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
}

export interface RegistryRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ThinkingConfig {
  type: 'none' | 'adaptive' | 'manual';
  budget: number | null;
}

// null  → never loaded, or the last load failed / found no table.
// []    → table exists but has no active rows.
// [...] → active rows, ordered by sortOrder.
let cache: RegistryModel[] | null = null;
let cacheLoadedAt = 0;
let inflight: Promise<void> | null = null;

async function refreshCache(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await prisma.modelRegistry.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      });
      cache = rows.map((r) => ({
        modelId: r.modelId,
        displayName: r.displayName,
        description: r.description ?? null,
        inputCostPer1M: r.inputCostPer1M,
        outputCostPer1M: r.outputCostPer1M,
        cacheReadCostPer1M: r.cacheReadCostPer1M,
        cacheWriteCostPer1M: r.cacheWriteCostPer1M,
        thinkingType: r.thinkingType,
        thinkingBudget: r.thinkingBudget ?? null,
        isActive: r.isActive,
        isDefault: r.isDefault,
        sortOrder: r.sortOrder,
      }));
      cacheLoadedAt = Date.now();
    } catch (err) {
      // Table missing (P2021 / "does not exist"), RDS unreachable, etc.
      // Leave the cache as-is (null on first load) so callers fall back.
      // Push cacheLoadedAt forward so we don't hammer the DB on every call
      // when the table genuinely doesn't exist yet.
      cacheLoadedAt = Date.now();
      logger.warn('[model-registry] load failed — falling back to hardcoded models', {
        route: 'model-registry',
        cause: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Return the active registry models (ordered by sortOrder), or `null` if the
 * table is missing / the load failed, or `[]` if the table is empty. Callers
 * treat null/empty as "fall back to hardcoded".
 */
export async function getRegistryModels(): Promise<RegistryModel[] | null> {
  if (Date.now() - cacheLoadedAt > TTL_MS) {
    await refreshCache();
  }
  return cache;
}

/** True when the registry loaded at least one active model. */
function hasRegistry(models: RegistryModel[] | null): models is RegistryModel[] {
  return Array.isArray(models) && models.length > 0;
}

/** Per-1M rates for a model from the registry, or null to fall back. */
export async function getRegistryRates(modelId: string): Promise<RegistryRates | null> {
  const models = await getRegistryModels();
  if (!hasRegistry(models)) return null;
  const m = models.find((x) => x.modelId === modelId);
  if (!m) return null;
  return {
    input: m.inputCostPer1M,
    output: m.outputCostPer1M,
    cacheRead: m.cacheReadCostPer1M,
    cacheWrite: m.cacheWriteCostPer1M,
  };
}

/** Active model ids from the registry, or [] to fall back. */
export async function getAllowedModelIds(): Promise<string[]> {
  const models = await getRegistryModels();
  if (!hasRegistry(models)) return [];
  return models.map((m) => m.modelId);
}

function normalizeThinkingType(t: string): 'none' | 'adaptive' | 'manual' {
  if (t === 'adaptive' || t === 'manual' || t === 'none') return t;
  return 'none';
}

/** Thinking config for a model from the registry, or null to fall back. */
export async function getThinkingConfig(modelId: string): Promise<ThinkingConfig | null> {
  const models = await getRegistryModels();
  if (!hasRegistry(models)) return null;
  const m = models.find((x) => x.modelId === modelId);
  if (!m) return null;
  return { type: normalizeThinkingType(m.thinkingType), budget: m.thinkingBudget };
}
