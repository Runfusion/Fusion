/**
 * FNXC:CodeOrganization 2026-08-03-10:15:
 * resolveInstructionsForRole peeled from TaskExecutor (U4).
 * Looks up agents by role and resolves their instruction text/path for prompt assembly.
 */
import type { AgentCapability, AgentStore, Settings } from "@fusion/core";
import { resolveAgentMemoryInclusionMode } from "@fusion/core";
import { executorLog } from "../logger.js";
import { resolveAgentInstructionParts, type AgentInstructionParts } from "../agents/agent-instructions.js";

export type ResolveInstructionsForRoleDeps = {
  rootDir: string;
  agentStore?: AgentStore | null;
};

/*
FNXC:PromptByteStability 2026-09-24-02:10 (RUFU-267):
The collapsed role instructions mix config-time text (the agent's instruction file/soul, which is role
configuration) with runtime-mutable text (the agent's memory bodies and the rating-summary block), so
a caller that put the collapsed string in a system prompt invalidated the provider prefix cache every
time memory or ratings changed. The parts resolver is the same lookup with the two halves separated:
executors keep `configTime` in the cached system prompt and send `memorySection` /
`performanceFeedback` with the request. `resolveInstructionsForRole` stays byte-identical for callers
that have no system-prompt/cache concern (spawned children, custom-node steps).
*/

/** Resolve one role's agent instructions split into cached and per-request halves. */
export async function resolveInstructionPartsForRole(
  deps: ResolveInstructionsForRoleDeps,
  role: string,
  settings?: Settings,
): Promise<AgentInstructionParts> {
  const empty: AgentInstructionParts = { configTime: "", memorySection: "", performanceFeedback: "" };
  if (!deps.agentStore) return empty;
  try {
    const agents = await deps.agentStore.listAgents({ role: role as AgentCapability });
    for (const agent of agents) {
      if (agent.instructionsText || agent.instructionsPath) {
        const mode = resolveAgentMemoryInclusionMode({ agent, globalSettings: settings }).mode;
        try {
          const ratingSummary = await deps.agentStore.getRatingSummary(agent.id);
          return await resolveAgentInstructionParts(agent, deps.rootDir, ratingSummary, mode);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          executorLog.warn(`${agent.id}: failed to load rating summary for instruction resolution, falling back to default instructions: ${msg}`);
          return await resolveAgentInstructionParts(agent, deps.rootDir, undefined, mode);
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    executorLog.warn(`Failed to resolve instructions for role '${role}', continuing without custom instructions: ${msg}`);
  }
  return empty;
}

export async function resolveInstructionsForRole(
  deps: ResolveInstructionsForRoleDeps,
  role: string,
  settings?: Settings,
): Promise<string> {
  const parts = await resolveInstructionPartsForRole(deps, role, settings);
  return [parts.configTime, parts.memorySection, parts.performanceFeedback]
    .filter((part) => part.trim())
    .join("\n\n");
}
