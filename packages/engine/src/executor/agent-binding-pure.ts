/**
 * FNXC:CodeOrganization 2026-08-03-13:35:
 * Pure agent/task binding helpers peeled from TaskExecutor (U4).
 */
import type { Agent, EffectiveAgentInput, Task } from "@fusion/core";

/**
 * Extract the task's own agent/model fields for effective-agent resolution.
 * Centralizes the previously-duplicated extraction so call sites share one normalized idiom.
 */
export function extractOwnSettings(
  task: Pick<Task, "assignedAgentId" | "modelProvider" | "modelId">,
): Pick<EffectiveAgentInput, "ownAgentId" | "ownModelProvider" | "ownModelId"> {
  const ownAgentId = typeof task.assignedAgentId === "string" && task.assignedAgentId.trim()
    ? task.assignedAgentId.trim()
    : undefined;
  const ownModelComplete = Boolean(task.modelProvider && task.modelId);
  return {
    ownAgentId,
    ownModelProvider: ownModelComplete ? task.modelProvider : undefined,
    ownModelId: ownModelComplete ? task.modelId : undefined,
  };
}

export function buildAgentPersona(agent: Agent): string | undefined {
  const parts = [agent.soul, agent.instructionsText]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
