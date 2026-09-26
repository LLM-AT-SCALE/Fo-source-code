/**
 * On-the-Fly MCP — shared types + Zod schemas for the admin build pipeline.
 * v1 supports Postgres only. The credential VALUE never lives here or in the DB;
 * it is written to Secrets Manager and referenced by ARN.
 */
import { z } from 'zod';

const SUPPORTED_ENGINES = ['postgres', 'sqlserver'] as const;
export type Engine = (typeof SUPPORTED_ENGINES)[number];

/**
 * The connection object parsed from the uploaded credentials document. Stored
 * (whole) in Secrets Manager; the runtime Lambda reads it by ARN. host/port/
 * database are echoed into the DB row for display; user/password never are.
 *
 * `instance` is for SQL Server NAMED instances (resolved via SQL Browser / UDP
 * 1434 + a dynamic port); when set, `port` is ignored by the mssql runtime.
 */
export const CredsDocSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive().optional(),
  user: z.string().min(1),
  password: z.string().min(1),
  database: z.string().min(1),
  instance: z.string().min(1).optional(),
  ssl: z.boolean().optional(),
});
export type CredsDoc = z.infer<typeof CredsDocSchema>;

/** Non-secret intake metadata supplied alongside the creds document. */
export const IntakeMetaSchema = z.object({
  name: z.string().min(1).max(120),
  engine: z.enum(SUPPORTED_ENGINES).default('sqlserver'),
  // Optional allow-list of schemas. Empty = auto-discover everything (all
  // non-system schemas). Business users don't need to think about this.
  schemas: z.array(z.string().min(1)).default([]),
});
export type IntakeMeta = z.infer<typeof IntakeMetaSchema>;

/** A single generated tool = data (name + inputs + one read-only SELECT). */
const ManifestToolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'tool name must be a simple identifier'),
  description: z.string().max(500).optional(),
  inputSchema: z.object({
    // Tolerant on purpose: the model often omits inputSchema "type" or emits a
    // property as {} (no "type") / with extra JSON-Schema keys (format/enum).
    // Rejecting those failed the WHOLE manifest ("response did not match schema").
    // Accept any property shape; codegen normalizes (forces type:"object" and
    // backfills a default property "type" of string) so the deployed tools are
    // still well-formed for the runtime + FO.
    type: z.string().optional(),
    properties: z.record(z.string(), z.record(z.string(), z.any())).default({}),
    required: z.array(z.string()).optional(),
  }),
  sql: z.string().min(1),
});
export type ManifestTool = z.infer<typeof ManifestToolSchema>;

export const ManifestSchema = z.object({
  server: z.string().min(1),
  description: z.string().optional(),
  // Codegen targets a small set of VERY rich tools (hard-capped to MAX_TOOLS≈20
  // in codegen). Keep a little schema headroom above that so generateObject never
  // rejects a slightly-over output — the extra are trimmed after validation.
  tools: z.array(ManifestToolSchema).min(1).max(30),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** Result of static-checking a generated manifest before deploy. */
export interface StaticCheckResult {
  ok: boolean;
  errors: string[];
  toolCount: number;
}
