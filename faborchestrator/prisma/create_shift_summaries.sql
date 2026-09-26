-- Shift-summary emails (Lumentum V06, section "Scheduled Dashboard"). One row per
-- send time: at each shift boundary the Fab scheduler emails an overall summary +
-- each chosen dashboard's cached summary to the recipient roles. Apply ONCE to the
-- shared RDS (hand-applied, not prisma migrate). Idempotent.

CREATE TABLE IF NOT EXISTS shift_summaries (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name               TEXT             NOT NULL,
  send_time          TEXT             NOT NULL,                         -- "HH:MM" in `timezone`
  timezone           TEXT             NOT NULL DEFAULT 'America/Los_Angeles',  -- PST/PDT
  recipient_role_ids JSONB            NOT NULL DEFAULT '[]'::jsonb,     -- empty = default alert roles
  dashboard_ids      JSONB            NOT NULL DEFAULT '[]'::jsonb,     -- empty = the 7 curated dashboards
  source_key         TEXT             NOT NULL DEFAULT 'lumentum',
  is_active          BOOLEAN          NOT NULL DEFAULT true,
  next_send_at       TIMESTAMPTZ,
  last_send_at       TIMESTAMPTZ,
  last_status        TEXT,
  created_by_id      TEXT,
  created_at         TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shift_summaries_name_uidx ON shift_summaries (name);
CREATE INDEX IF NOT EXISTS shift_summaries_active_next_idx ON shift_summaries (is_active, next_send_at);

-- Seed the 3 swing shifts (start + end), times interpreted in PST. Empty role/
-- dashboard lists = default roles (Shift Lead/Supervisor/Admin) + the 7 curated.
INSERT INTO shift_summaries (name, send_time, timezone, is_active) VALUES
  ('Swing 1 — start', '06:00', 'America/Los_Angeles', true),
  ('Swing 1 — end',   '15:00', 'America/Los_Angeles', true),
  ('Swing 2 — start', '14:00', 'America/Los_Angeles', true),
  ('Swing 2 — end',   '23:00', 'America/Los_Angeles', true),
  ('Swing 3 — start', '22:00', 'America/Los_Angeles', true),
  ('Swing 3 — end',   '07:00', 'America/Los_Angeles', true)
ON CONFLICT (name) DO NOTHING;
