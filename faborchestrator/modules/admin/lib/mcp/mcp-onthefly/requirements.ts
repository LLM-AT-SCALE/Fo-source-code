/**
 * On-the-Fly MCP — the parameter checklist shown to the admin (Step 1).
 *
 * Surfaced by the admin chat tool `list_mcp_datasource_requirements` so the admin
 * knows exactly what to put in the credentials document BEFORE uploading it. The
 * upload goes to the dedicated /api/admin/mcp/secrets endpoint (never chat), so
 * the values never reach the LLM.
 */
interface RequirementField {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  notes?: string;
}

const SQLSERVER_REQUIREMENTS: RequirementField[] = [
  { key: 'host', label: 'Server / IP', required: true, secret: false, notes: 'On-prem SQL Server (e.g. 10.10.x) — reached from the CMF VPC over the VPN.' },
  { key: 'instance', label: 'Named instance', required: false, secret: false, notes: 'For named instances (SQL Browser / UDP 1434). If set, port is ignored.' },
  { key: 'port', label: 'Port', required: false, secret: false, notes: 'Defaults to 1433 when not a named instance.' },
  { key: 'database', label: 'Database name', required: true, secret: false },
  { key: 'user', label: 'Username', required: true, secret: true, notes: 'Use a READ-ONLY SQL login.' },
  { key: 'password', label: 'Password', required: true, secret: true },
];

// The ONLY supported data source type is an on-premises Microsoft SQL Server
// database. PostgreSQL is intentionally NOT surfaced to admins. The `engine`
// arg is ignored and kept only for call-site compatibility.
export function getRequirements(_engine?: string) {
  return {
    engine: 'sqlserver',
    supported: true,
    // Shown to the admin BEFORE they upload any credentials so they understand
    // the data-exposure implications and can confirm they're authorized to share.
    disclaimer:
      `**Data Access & Security Notice**\n\nBefore connecting this server, please review the following security and compliance requirements:\n\n- **Authorization:** Confirm you have explicit authority to connect to this data source and grant access to assigned users.\n- **Data Scope:** Ensure the data source does not expose unauthorized sensitive information (e.g., PII, financial records, or regulated data).\n- **Access Level:** You must provide only read-only credentials to prevent unauthorized data modification.\n\n**Security Disclaimer**\n\nConnecting external data sources introduces inherent security and privacy risks. Credentials are routed to an encrypted vault and are not exposed in chat or directly to the AI, but administrators remain fully responsible for managing data exposure, user permissions, and potential vulnerabilities associated with external server integrations.\n\n- [ ] I have read, understood, and accept the terms and security risks outlined above`,
    note: 'Data sources are on-premises Microsoft SQL Server databases (e.g. 10.10.x) reachable only from inside the corporate network. The platform auto-discovers the tables from your credentials securely from inside the network — no manual schema entry needed — then makes read-only look-up tools your assigned users can query in chat.',
    fields: SQLSERVER_REQUIREMENTS,
    alsoProvide: [
      { key: 'name', label: 'Data source display name', required: true },
    ],
    guardrails: [
      'Credentials are stored in AWS Secrets Manager and never sent to the chat/LLM.',
      'Only read-only SELECT tools are generated; writes/DDL are rejected.',
      'Row, output-size, statement-timeout, and concurrency caps are enforced.',
    ],
  };
}
