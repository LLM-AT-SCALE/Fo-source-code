/**
 * Prompt chips — the shortcut bubbles Fab AI shows above the composer for every
 * role. One shared library (`prompt_chips`); every chip is selectable for every
 * role. Each role stores an ordered id list (`roles.prompt_chip_ids`). Pure
 * helpers + zod schemas here; the API routes and role service use them.
 */

import { z } from "zod";

export const CHIP_ICONS = [
  "factory", "clock", "trend", "wrench", "funnel", "grid", "bars",
  "gauge", "table", "alert", "list", "search", "chart", "spark",
] as const;
export type ChipIcon = (typeof CHIP_ICONS)[number];

export const DEFAULT_CHIP_ICON: ChipIcon = "chart";

const DASHBOARDS_PERMISSION = "dashboards";


const label = z.string().trim().min(1, "Label is required").max(60, "Label must be 60 characters or fewer");
const prompt = z.string().trim().min(1, "Prompt is required").max(2000, "Prompt must be 2000 characters or fewer");
const blurb = z.string().trim().max(160, "Blurb must be 160 characters or fewer");
const icon = z.enum(CHIP_ICONS);

export const CreateChipSchema = z.object({
  label,
  blurb: blurb.optional(),
  prompt,
  icon: icon.optional(),
});

export const UpdateChipSchema = z
  .object({
    label: label.optional(),
    blurb: blurb.optional(),
    prompt: prompt.optional(),
    icon: icon.optional(),
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to update" });

/** Row shape of the Prisma `PromptChip` model (camelCase fields, mapped to snake_case columns). */
export type ChipRow = {
  id: string;
  label: string;
  blurb: string;
  prompt: string;
  icon: string;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
};

export type ClientChip = {
  id: string;
  label: string;
  blurb: string;
  prompt: string;
  icon: ChipIcon;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
};

function isChipIcon(v: unknown): v is ChipIcon {
  return typeof v === "string" && (CHIP_ICONS as readonly string[]).includes(v);
}

export function toClientChip(r: ChipRow): ClientChip {
  return {
    id: r.id,
    label: r.label,
    blurb: r.blurb ?? "",
    prompt: r.prompt,
    icon: isChipIcon(r.icon) ? r.icon : DEFAULT_CHIP_ICON,
    isDefault: r.isDefault,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
  };
}

/** Sanitise an arbitrary JSON value into an ordered, de-duplicated id list. */
export function chipIdList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()))];
}

function hasDashboardsPermission(permissions: unknown): boolean {
  return Array.isArray(permissions) && permissions.some((p) => p === DASHBOARDS_PERMISSION);
}

/** Minimal chip shape the rules below need. */
export type ChipInfo = { id: string; isDefault?: boolean; isActive?: boolean; sortOrder?: number };

/**
 * The server-side rule for what gets stored on `roles.prompt_chip_ids`: exactly
 * what the admin chose, cleaned (strings only, trimmed, de-duplicated, order
 * kept). Chips are one flat list for every role; the `dashboards` permission
 * carries no filtering behaviour.
 */
export function normalizeRoleChips(chipIds: unknown): string[] {
  return chipIdList(chipIds);
}

/**
 * The chips a role gets when none were chosen explicitly: with Dashboard
 * Scheduling, every active `is_default` chip by sort order; otherwise none.
 * (Ticking the permission in the role form appends the same set.)
 */
export function defaultChipIds(chips: ChipInfo[], permissions: unknown): string[] {
  if (!hasDashboardsPermission(permissions)) return [];
  return chips
    .filter((c) => c.isDefault && c.isActive !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((c) => c.id);
}

/** Union that keeps the existing order and appends `added` in their given order. */
export function appendChipIds(existing: string[], added: string[]): string[] {
  return [...new Set([...existing, ...added])];
}
