-- Prompt chips: the shortcut bubbles shown above the Fab AI composer. Every role
-- carries chips; 'dashboard' chips additionally need Dashboard Scheduling (the
-- `dashboards` role permission) and auto-select when it is switched on.
-- Additive + idempotent. Run directly against the shared DB. NEVER `prisma db push`.
--
-- Model: one shared library (prompt_chips); each role carries an ordered list of
-- chip ids (roles.prompt_chip_ids). Every chip is selectable for every role.
-- Nothing is pre-selected; enabling Dashboard Scheduling on a role auto-selects
-- every default chip (is_default — all seeded chips), and the admin can add or
-- remove any chip at any time.
--
-- Icon keys (rendered by both apps): factory | clock | trend | wrench | funnel |
-- grid | bars | gauge | table | alert | list | search | chart | spark

CREATE TABLE IF NOT EXISTS prompt_chips (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  blurb         TEXT NOT NULL DEFAULT '',
  prompt        TEXT NOT NULL,
  icon          TEXT NOT NULL DEFAULT 'chart',
  is_default    BOOLEAN NOT NULL DEFAULT false,   -- auto-selected when Dashboard Scheduling is enabled
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_by_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prompt_chips_active_idx ON prompt_chips (is_active, sort_order);

ALTER TABLE prompt_chips DROP COLUMN IF EXISTS kind;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS prompt_chip_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The seven standard chips (stable ids so environments match). Idempotent:
-- only label/blurb/prompt/icon are refreshed; admins' active/default flags stay.
INSERT INTO prompt_chips (id, label, blurb, prompt, icon, is_default, sort_order) VALUES
  ('chip-factory-operations', 'Factory Operations', 'Live factory status and current production',
   'Can you create me the dashboard for below - Factory Status - with WIP lot count, Equipment, Yield qty - Current Production - with active lot count, Running Equipment and Cycle Time for each Step.',
   'factory', true, 10),
  ('chip-lot-history', 'Lot History', 'Step-by-step travel history for one lot',
   'Can you fetch the lot history for lot id "26FHEAEB1E00000" - with from step to step, Tracking equipment name, time Qty, operator name.',
   'clock', true, 20),
  ('chip-process-analytics', 'Process Analytics', 'WIP, cycle time and utilisation trends',
   'Can you create me the Dashboard for WIP Trend and Cycle time trend and Equipment Utilization for current Week.',
   'trend', true, 30),
  ('chip-maintenance', 'Maintenance', 'Scheduled maintenance and overdue equipment',
   'Can you Create Equipment dashboard Equipment scheduled for Maintenance and Equipment that passing the due.',
   'wrench', true, 40),
  ('chip-bottleneck-risk', 'Bottleneck Risk', 'Lots at risk against the coming Monday due date',
   'Can you give me the bottleneck lot that nearing the expiry date on coming Monday.',
   'funnel', true, 50),
  ('chip-product-analytics', 'Product Analytics', 'Yield, cycle time, WIP heat map and Pareto for one product',
   'Can you create me the dashboard for below Requirement - yield and Loss Qty for product "HL13B5" and key operation - Cycle Time for each Step for this products lots. - Equipment Utilization for this Product. - WIP heat map - Bottleneck analysis - Cycle time distribution - Downtime Pareto',
   'grid', true, 60),
  ('chip-executive-overview', 'Executive Overview', 'Fab-wide KPIs: throughput, yield, WIP, OTD',
   'Can you create me the dashboard for below Required items - Factory thruput - Average Cycle Time per step. - Yield Analysis. - Active WIP. - Bottleneck Area. - On-Time Delivery',
   'bars', true, 70)
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label, blurb = EXCLUDED.blurb, prompt = EXCLUDED.prompt, icon = EXCLUDED.icon, updated_at = now();

-- Simple general chips — default too, so enabling Dashboard Scheduling selects all eleven.
INSERT INTO prompt_chips (id, label, blurb, prompt, icon, is_default, sort_order) VALUES
  ('chip-active-lots', 'Active Lots', 'Lots currently in process, by step',
   'List the lots currently in process with their current step, quantity and how long they have been at that step.',
   'list', true, 110),
  ('chip-equipment-status', 'Equipment Status', 'Which tools are running, idle or down right now',
   'Show the current status of all equipment: running, idle or down, with the lot on each running tool.',
   'gauge', true, 120),
  ('chip-holds', 'Lots On Hold', 'Held lots and their hold reasons',
   'List the lots currently on hold with the hold reason, how long they have been held and who placed the hold.',
   'alert', true, 130),
  ('chip-yield-today', 'Yield Today', 'Yield by step for the current day',
   'Give me today''s yield by step: units in, units out and yield percentage, highlighting the lowest three steps.',
   'chart', true, 140)
ON CONFLICT (id) DO UPDATE SET
  label = EXCLUDED.label, blurb = EXCLUDED.blurb, prompt = EXCLUDED.prompt, icon = EXCLUDED.icon,
  is_default = EXCLUDED.is_default, updated_at = now();

-- Roles that have Dashboard Scheduling get every default chip they do not already
-- carry (existing selection first, then the missing defaults in sort order).
UPDATE roles r
   SET prompt_chip_ids = COALESCE(r.prompt_chip_ids, '[]'::jsonb) || (
     SELECT COALESCE(jsonb_agg(c.id ORDER BY c.sort_order), '[]'::jsonb)
       FROM prompt_chips c
      WHERE c.is_default AND c.is_active
        AND NOT (COALESCE(r.prompt_chip_ids, '[]'::jsonb) ? c.id))
 WHERE r.permissions::jsonb ? 'dashboards';
