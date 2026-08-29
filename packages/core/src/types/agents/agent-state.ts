/**
 * FNXC:CodeOrganization 2026-07-16-12:00:
 * Agent lifecycle state machine and identity helpers peeled from types.ts.
 */

/** Agent lifecycle states */
export const AGENT_STATES = ["idle", "active", "running", "paused", "error"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Valid state transitions for agents */
export const AGENT_VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["active"],
  active: ["idle", "running", "paused", "error"],
  running: ["idle", "active", "paused", "error"],
  paused: ["idle", "active"],
  error: ["idle", "active", "paused"],
};

/**
 * Detect if an agent is a runtime-created ephemeral/internal agent.
 * These agents are created by the engine for task execution/system workflows and should
 * typically be hidden from the default agents page listing.
 *
 * Detection heuristics (returns true if ANY match):
 * - `agent.metadata?.agentKind === "task-worker"` — task-worker agents from InProcessRuntime
 * - `agent.metadata?.taskWorker === true` — legacy task-worker marker
 * - `agent.metadata?.managedBy === "task-executor"` — executor-managed agents
 * - `agent.metadata?.type === "spawned"` — spawned child agents from TaskExecutor
 * - `agent.metadata?.internal === true` — explicitly internal/system agent marker
 * - Legacy fallback: executor role with name starting with "executor-" and no reportsTo
 * - Legacy fallback: executor role named "verification-agent" with no reportsTo
 *
 * @param agent - Agent object (partial shape accepted)
 * @returns true if the agent is an ephemeral/runtime-created/internal system agent
 */
export function isEphemeralAgent(
  agent: { metadata?: Record<string, unknown> | null; name?: string; role?: string; reportsTo?: string | null },
): boolean {
  const metadata = agent.metadata ?? {};

  // Check explicit metadata markers first
  if (metadata.agentKind === "task-worker") return true;
  if (metadata.taskWorker === true) return true;
  if (metadata.managedBy === "task-executor") return true;
  if (metadata.type === "spawned") return true;
  if (metadata.internal === true) return true;

  // Legacy fallback: executor agents with "executor-" prefix and no manager
  // These are task workers that were created before metadata was standardized
  if (
    agent.role === "executor" &&
    typeof agent.name === "string" &&
    agent.name.startsWith("executor-") &&
    agent.reportsTo == null
  ) {
    return true;
  }

  // Legacy internal system agent used by older verification flows.
  if (
    agent.role === "executor" &&
    agent.name === "verification-agent" &&
    agent.reportsTo == null
  ) {
    return true;
  }

  return false;
}

/**
 * Check if an agent has meaningful identity content (soul, instructions, or memory).
 * Agents with identity should run heartbeat sessions even without a task assignment,
 * so they can load their prompts and do useful ambient work.
 *
 * @param agent - Agent object (partial shape accepted, null/undefined returns false)
 * @returns true if the agent has any of: soul, instructionsText, instructionsPath, or memory with non-empty trimmed content
 */
export function hasAgentIdentity(
  agent: { soul?: string | null; instructionsText?: string | null; instructionsPath?: string | null; memory?: string | null } | null | undefined,
): boolean {
  if (!agent) return false;
  return !!(
    agent.soul?.trim() ||
    agent.instructionsText?.trim() ||
    agent.instructionsPath?.trim() ||
    agent.memory?.trim()
  );
}
