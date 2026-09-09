import type { Agent, AgentAccessState, AgentCapability, AgentPermission } from "../types.js";
import { AGENT_PERMISSIONS } from "../types.js";

const VALID_PERMISSION_SET = new Set<AgentPermission>(AGENT_PERMISSIONS);

/** Default permission grants by agent role/capability. */
export const ROLE_DEFAULT_PERMISSIONS: Record<AgentCapability, AgentPermission[]> = {
  triage: ["tasks:create", "agents:view", "messages:read"],
  executor: ["tasks:execute", "agents:view", "messages:read", "messages:send"],
  reviewer: ["tasks:review", "agents:view", "messages:read", "messages:send"],
  merger: ["tasks:merge", "agents:view", "messages:read"],
  scheduler: ["tasks:assign", "tasks:create", "agents:view", "automations:manage", "missions:manage", "messages:read"],
  engineer: ["tasks:execute", "tasks:review", "agents:view", "messages:read", "messages:send"],
  custom: [],
};

/** Type guard for canonical agent permissions. */
export function isValidPermission(key: string): key is AgentPermission {
  return VALID_PERMISSION_SET.has(key as AgentPermission);
}

/**
 * Normalize a raw permission grant map into a set of explicit canonical grants.
 * Invalid keys and false values are ignored.
 */
export function normalizePermissions(raw: Record<string, boolean>): Set<AgentPermission> {
  const permissions = new Set<AgentPermission>();

  for (const [key, granted] of Object.entries(raw)) {
    if (!granted) {
      continue;
    }
    if (!isValidPermission(key)) {
      continue;
    }
    permissions.add(key);
  }

  return permissions;
}

/*
FNXC:WorkflowAgentRouting 2026-08-07-07:56:
FN-8764 grants a permanent agent the union of defaults for every canonical
role tag. The singular role remains migration compatibility only and cannot
silently strip reviewer, merger, or executor authority from multi-role agents.
*/
/** Compute resolved access state from all role defaults plus explicit grants. */
export function computeAccessState(agent: Agent): AgentAccessState {
  const roles = agent.roles?.length ? agent.roles : [agent.role];
  const roleDefaultPermissions = new Set<AgentPermission>(roles.flatMap((role) => ROLE_DEFAULT_PERMISSIONS[role] ?? []));
  const explicitPermissions = normalizePermissions(agent.permissions ?? {});
  const resolvedPermissions = new Set<AgentPermission>(roleDefaultPermissions);

  for (const permission of explicitPermissions) {
    resolvedPermissions.add(permission);
  }

  const taskAssignSource = explicitPermissions.has("tasks:assign")
    ? "explicit_grant"
    : roleDefaultPermissions.has("tasks:assign")
      ? "role_default"
      : "denied";

  return {
    agentId: agent.id,
    canAssignTasks: resolvedPermissions.has("tasks:assign"),
    taskAssignSource,
    canCreateAgents: resolvedPermissions.has("agents:create"),
    canExecuteTasks: resolvedPermissions.has("tasks:execute"),
    canReviewTasks: resolvedPermissions.has("tasks:review"),
    canMergeTasks: resolvedPermissions.has("tasks:merge"),
    canDeleteAgents: resolvedPermissions.has("agents:delete"),
    canManageMissions: resolvedPermissions.has("missions:manage"),
    canSendMessages: resolvedPermissions.has("messages:send"),
    resolvedPermissions,
    explicitPermissions,
    roleDefaultPermissions,
  };
}
