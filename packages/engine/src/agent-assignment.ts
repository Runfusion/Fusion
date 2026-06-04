import type { Agent, AgentStore, Task, TaskStore } from "@fusion/core";
import { isEphemeralAgent } from "@fusion/core";

const ACTIVE_COLUMNS = new Set(["todo", "in-progress", "in-review"]);

type SelectPermanentAgentForTaskOptions = {
  task: Task;
  agentStore: Pick<AgentStore, "listAgents" | "getChainOfCommand">;
  taskStore: Pick<TaskStore, "listTasks">;
};

function isAgentEnabled(agent: Agent): boolean {
  return (agent.runtimeConfig?.enabled as boolean | undefined) !== false;
}

/**
 * Permanent, enabled, non-errored executor agents — the pool the scheduler can
 * auto-assign mission/queue tasks to when ephemeral agents are disabled.
 *
 * Catalog-imported "company" agents land with role "custom" (see
 * mapRoleToCapability) and are therefore NOT in this pool, which is why a
 * mission can silently stall when ephemeral agents are off and the only agents
 * present came from an import. Callers use this to preflight that situation.
 */
export async function listEligibleExecutorAgents(
  agentStore: Pick<AgentStore, "listAgents">,
): Promise<Agent[]> {
  const agents = await agentStore.listAgents({ role: "executor", includeEphemeral: true });
  return agents.filter(
    (agent) => agent.role === "executor"
      && !isEphemeralAgent(agent)
      && agent.state !== "error"
      && isAgentEnabled(agent),
  );
}

function taskLinksToScope(task: Pick<Task, "id" | "missionId" | "sliceId">, scopeTask: Pick<Task, "id" | "missionId" | "sliceId">): boolean {
  if (task.id === scopeTask.id) return false;
  if (scopeTask.sliceId && task.sliceId === scopeTask.sliceId) return true;
  if (scopeTask.missionId && task.missionId === scopeTask.missionId) return true;
  return false;
}

export async function selectPermanentAgentForTask({ task, agentStore, taskStore }: SelectPermanentAgentForTaskOptions): Promise<Agent | null> {
  const eligibleAgents = await listEligibleExecutorAgents(agentStore);

  if (eligibleAgents.length === 0) {
    return null;
  }

  const allTasks = await taskStore.listTasks({ slim: true });

  const linkedAssignedAgentIds = new Set<string>();
  if (task.missionId || task.sliceId) {
    for (const candidateTask of allTasks) {
      if (!candidateTask.assignedAgentId) continue;
      if (taskLinksToScope(candidateTask, task)) {
        linkedAssignedAgentIds.add(candidateTask.assignedAgentId);
      }
    }
  }

  const preferredAgentIds = new Set<string>();
  for (const linkedAgentId of linkedAssignedAgentIds) {
    preferredAgentIds.add(linkedAgentId);
    const chain = await agentStore.getChainOfCommand(linkedAgentId).catch(() => []);
    for (const chainAgent of chain) {
      preferredAgentIds.add(chainAgent.id);
    }
  }

  const preferredEligible = eligibleAgents.filter((agent) => preferredAgentIds.has(agent.id));
  const candidatePool = preferredEligible.length > 0 ? preferredEligible : eligibleAgents;

  const assignmentLoad = new Map<string, number>();
  for (const taskItem of allTasks) {
    if (!taskItem.assignedAgentId || !ACTIVE_COLUMNS.has(taskItem.column)) continue;
    assignmentLoad.set(taskItem.assignedAgentId, (assignmentLoad.get(taskItem.assignedAgentId) ?? 0) + 1);
  }

  const sorted = [...candidatePool].sort((a, b) => {
    const loadA = assignmentLoad.get(a.id) ?? 0;
    const loadB = assignmentLoad.get(b.id) ?? 0;
    if (loadA !== loadB) return loadA - loadB;

    const createdAtCompare = a.createdAt.localeCompare(b.createdAt);
    if (createdAtCompare !== 0) return createdAtCompare;

    return a.id.localeCompare(b.id);
  });

  return sorted[0] ?? null;
}
