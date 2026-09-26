-- Built-in Admin role: exists by default with full access to the entire platform.
-- Idempotent — safe to run on every environment. The app also repairs this row on
-- every server boot (instrumentation.ts → ensureAdminRole), so this file is for
-- databases that are provisioned before the app first starts.
INSERT INTO roles (id, name, description, is_system_role, permissions, allowed_models,
                   custom_instructions_enabled, custom_instructions_max_length,
                   personal_mcp_enabled, personal_mcp_max_count,
                   daily_request_limit, daily_token_limit, created_at, updated_at)
SELECT gen_random_uuid(), 'Admin',
       'Full access to the entire platform. Built in; cannot be restricted or deleted.',
       true,
       '["admin","chat","mcp","artifacts","file_upload","web_search","dashboards","modeling_agent","backend_agent"]'::jsonb,
       COALESCE((SELECT jsonb_agg(model_id ORDER BY sort_order) FROM model_registry WHERE is_active),
                '["claude-sonnet-5","claude-opus-5","claude-fable-5","claude-fable-5-1"]'::jsonb),
       true, 4000, true, 99, NULL, NULL, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Admin');

UPDATE roles SET
  description                   = 'Full access to the entire platform. Built in; cannot be restricted or deleted.',
  is_system_role                = true,
  permissions                   = '["admin","chat","mcp","artifacts","file_upload","web_search","dashboards","modeling_agent","backend_agent"]'::jsonb,
  allowed_models                = COALESCE((SELECT jsonb_agg(model_id ORDER BY sort_order) FROM model_registry WHERE is_active), allowed_models),
  custom_instructions_enabled   = true,
  custom_instructions_max_length = 4000,
  personal_mcp_enabled          = true,
  personal_mcp_max_count        = 99,
  daily_request_limit           = NULL,
  daily_token_limit             = NULL,
  updated_at                    = NOW()
WHERE name = 'Admin';

-- Members of the Admin role are platform admins.
UPDATE users SET is_admin = true
WHERE role_id = (SELECT id FROM roles WHERE name = 'Admin') AND is_admin = false;
