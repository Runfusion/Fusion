/**
 * FNXC:CodeOrganization 2026-08-03-10:15:
 * resolveInstructionsForRole peeled from TaskExecutor (U4).
 * Looks up agents by role and resolves their instruction text/path for prompt assembly.
 */
import type { AgentCapability, AgentStore, Settings } from "@fusion/core";
import { resolveAgentMemoryInclusionMode } from "@fusion/core";
import { executorLog } from "../logger.js";
import { resolveAgentInstructions } from "../agents/agent-instructions.js";

export type ResolveInstructionsForRoleDeps = {
  rootDir: string;
  agentStore?: AgentStore | null;
};

export async function resolveInstructionsForRole(
  deps: ResolveInstructionsForRoleDeps,
  role: string,
  settings?: Settings,
): Promise<string> {
  if (!deps.agentStore) return "";
  try {
    const agents = await deps.agentStore.listAgents({ role: role as AgentCapability });
    for (const agent of agents) {
      if (agent.instructionsText || agent.instructionsPath) {
        try {
          const ratingSummary = await deps.agentStore.getRatingSummary(agent.id);
          const mode = resolveAgentMemoryInclusionMode({ agent, globalSettings: settings }).mode;
          return await resolveAgentInstructions(agent, deps.rootDir, ratingSummary, mode);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          executorLog.warn(`${agent.id}: failed to load rating summary for instruction resolution, falling back to default instructions: ${msg}`);
          const mode = resolveAgentMemoryInclusionMode({ agent, globalSettings: settings }).mode;
          return await resolveAgentInstructions(agent, deps.rootDir, undefined, mode);
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    executorLog.warn(`Failed to resolve instructions for role '${role}', continuing without custom instructions: ${msg}`);
  }
  return "";
}
