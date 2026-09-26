/**
 * WHO MAY USE THE BACK-END AGENT.
 *
 * OPEN TO EVERY SIGNED-IN USER BY DEFAULT, and that is a deliberate difference
 * from the Modeling Agent beside it, which is default-deny on `modeling_agent`.
 * The decision is the product's, not this file's: while the agent is being
 * evaluated, every user is meant to have it.
 *
 * RESTRICTING IT LATER IS A CONFIG CHANGE, NOT A CODE CHANGE.
 *   Set `BACKEND_AGENT_REQUIRE_PERMISSION=1` and the gate becomes the same
 *   default-deny check the Modeling Agent uses: administrators bypass, everyone
 *   else needs `backend_agent` granted to their role in Admin Console → Roles.
 *
 *   Done this way round on purpose. The alternative — granting `backend_agent`
 *   to every existing role today — writes a permission onto live roles that
 *   someone would later have to remember to remove from each of them, and the
 *   roles are shared with an application the client is testing against. A flag
 *   that flips is reversible; edits spread across five roles are not.
 *
 * ONE PLACE, TWO CALLERS. The client gate (`/api/backend-agent/access`) exists
 * so the engineer is TOLD why rather than watching a chat fail; the chat route
 * enforces it independently, because a client-side gate is a courtesy and never
 * a control. Both ask this function, so they cannot drift apart.
 */

export interface AccessSubject {
  isAdmin: boolean;
  /** the permissions on the user's role, as stored */
  permissions: readonly string[];
}

/** The permission that gates this agent once enforcement is switched on. */
const BACKEND_AGENT_PERMISSION = "backend_agent";

/** Whether the permission is being enforced at all. */
export function requiresPermission(): boolean {
  const v = process.env["BACKEND_AGENT_REQUIRE_PERMISSION"];
  return v === "1" || v?.toLowerCase() === "true";
}

export function canUseBackendAgent(subject: AccessSubject): boolean {
  if (!requiresPermission()) return true;
  if (subject.isAdmin) return true;
  return subject.permissions.includes(BACKEND_AGENT_PERMISSION);
}

/** What to tell someone who is refused, in their terms rather than ours. */
export const DENIED_MESSAGE =
  "The Coding Agent is not enabled for your role. Ask an administrator to " +
  "enable it in Admin Console → Roles.";
