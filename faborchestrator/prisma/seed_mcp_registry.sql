-- Platform MCP servers (API Gateway endpoints, auth "none"). Idempotent:
--  1. a server already registered under its NAME gets the current URL (and its
--     role/user assignments follow, with their session cleared so the next
--     connect uses the new endpoint);
--  2. a name not yet registered is inserted.
-- Apply with psql; the 5-minute health check re-probes changed servers.
CREATE TEMP TABLE platform_mcp (display_name text, server_url text);
INSERT INTO platform_mcp VALUES
  ('CM MES - Assembly',            'https://1wepjieref.execute-api.us-west-2.amazonaws.com/mcp'),
  ('CMF - Critical Manufacturing', 'https://m6p4ggcgx0.execute-api.us-west-2.amazonaws.com/mcp'),
  ('CM MES - Lab Data',            'https://2oma6vpnpa.execute-api.us-west-2.amazonaws.com/mcp'),
  ('Opcenter - Siemens',           'https://nlgp824txd.execute-api.us-west-2.amazonaws.com/mcp'),
  ('Lumentum Server',              'https://hphhkx67l4.execute-api.us-west-2.amazonaws.com/mcp'),
  ('Opcenter - CoreSi',            'https://xe57w1dw1m.execute-api.us-west-2.amazonaws.com/mcp'),
  ('PSI_Quantum_Views',            'https://nqm52dnzdi.execute-api.us-west-2.amazonaws.com/mcp'),
  ('PSIQ Jira Tickets',            'https://o971r54920.execute-api.us-west-2.amazonaws.com/mcp');

-- 1. existing servers: new URL, health reset so the next check probes the new endpoint
UPDATE mcp_registry r
   SET server_url = p.server_url, health_status = 'unknown', health_checked_at = NULL,
       health_detail = NULL, health_probe = NULL, is_active = true, updated_at = now()
  FROM platform_mcp p
 WHERE r.display_name = p.display_name AND r.server_url IS DISTINCT FROM p.server_url;

UPDATE mcp_connections c
   SET server_url = r.server_url, session_id = NULL, status = 'disconnected',
       last_error = NULL, updated_at = now()
  FROM mcp_registry r JOIN platform_mcp p ON p.display_name = r.display_name
 WHERE c.registry_id = r.id AND c.server_url IS DISTINCT FROM r.server_url;

-- 2. new servers
INSERT INTO mcp_registry (id, display_name, server_url, auth_type, is_active, created_at, updated_at)
SELECT gen_random_uuid()::text, p.display_name, p.server_url, 'none', true, now(), now()
  FROM platform_mcp p
 WHERE NOT EXISTS (SELECT 1 FROM mcp_registry r WHERE r.display_name = p.display_name);

DROP TABLE platform_mcp;
