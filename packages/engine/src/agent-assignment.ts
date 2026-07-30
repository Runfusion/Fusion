import type { Agent, AgentStore, Task, TaskStore } from "@fusion/core";
import { isAgentAutoAssignable, isEphemeralAgent, resolveWorkflowIrForTask, columnsWithFlag } from "@fusion/core";

type SelectPermanentAgentForTaskOptions = {
  task: Task;
  agentStore: Pick<AgentStore, "listAgents" | "getChainOfCommand">;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-08:30 (batch-engine): widened from Pick<TaskStore, "listTasks">
  to include the workflow readers  needs. Its only production caller
  (scheduler.ts) passes a full TaskStore, so this narrows nothing in practice; the Pick was simply
  documenting the subset used at the time.
  */
  taskStore: Pick<TaskStore, "listTasks" | "getTaskWorkflowSelection" | "getTaskWorkflowSelectionAsync" | "getWorkflowDefinition">;
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
  /*
  FNXC:AgentRouting 2026-07-12-12:15:
  Issue #2015 (NEXT-871): the scheduler auto-assign pool admitted EVERY enabled executor-role agent, so a
  liaison-type agent whose role field is "executor" was round-robin-assigned product-code tasks. Agents with
  runtimeConfig.assignmentPolicy "explicit-only"/"none" are excluded from all automatic assignment.
  */
  return agents.filter(
    (agent) => agent.role === "executor"
      && !isEphemeralAgent(agent)
      && agent.state !== "error"
      && isAgentEnabled(agent)
      && isAgentAutoAssignable(agent),
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

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-08:20 (batch-engine — census-invisible membership, #2763 class):
  Assignment load counts how many ACTIVE tasks each agent already holds, and it is what balances new work
  across agents. On a renamed board no task counted, so every agent looked unloaded and the balancer piled
  work onto whichever sorted first.

  One IR cache for the pass so the loop stays cheap; the legacy trio is unioned in for the usual reason.
  */
  const loadIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
  const activeLanes = new Map<string, ReadonlySet<string>>();
  for (const taskItem of allTasks) {
    if (activeLanes.has(taskItem.id)) continue;
    const lanes = new Set<string>(["todo", "in-progress", "in-review"]);
    try {
      const ir = await resolveWorkflowIrForTask(taskStore, taskItem.id, loadIrCache);
      if (ir) {
        for (const flag of ["hold", "countsTowardWip", "mergeOrchestration", "mergeBlocker", "humanReview"] as const) {
          for (const id of columnsWithFlag(ir, flag)) lanes.add(id);
        }
      }
    } catch { /* degraded: legacy trio */ }
    activeLanes.set(taskItem.id, lanes);
  }

  const assignmentLoad = new Map<string, number>();
  for (const taskItem of allTasks) {
    if (!taskItem.assignedAgentId || activeLanes.get(taskItem.id)?.has(taskItem.column) !== true) continue;
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
