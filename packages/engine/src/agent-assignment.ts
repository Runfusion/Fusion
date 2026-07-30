import type { Agent, AgentStore, Task, TaskStore } from "@fusion/core";
import { isAgentAutoAssignable, isEphemeralAgent } from "@fusion/core";

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-05:40 (batch-engine feed):
The lanes an assigned card still counts as LOAD against its agent.

CENSUS-INVISIBLE: this is a `Set` literal, i.e. a definition rather than a comparison, so nothing in
the lifecycle backlog ever pointed at this file. Found by grepping for lane-shaped list literals
after the same shape turned up in `duplicate-intake` and `blocker-fanout`.

The failure is a silent DEGRADATION, not an error. This set gates the per-agent assignment-load
tally used to pick the least-loaded agent. On a renamed board no task's column matched, so
`assignmentLoad` stayed empty, every candidate compared as load 0, and the sort fell straight through
to its `createdAt` tiebreak — which is stable. The result is that the SAME agent wins every
assignment while the others sit idle. Nothing logs, nothing fails; the board just distributes badly.

DELIBERATE-LITERAL — the fallback for a caller that cannot resolve lanes, reviewed 2026-07-31-05:40.
*/
const LEGACY_ACTIVE_COLUMNS: ReadonlySet<string> = new Set(["todo", "in-progress", "in-review"]);

type SelectPermanentAgentForTaskOptions = {
  task: Task;
  agentStore: Pick<AgentStore, "listAgents" | "getChainOfCommand">;
  taskStore: Pick<TaskStore, "listTasks">;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-11:40 (#2787 review — greptile P1, third round):
  A PER-TASK predicate, not a flat set.

  The flat `activeColumns` I first added was resolved from the CANDIDATE task's workflow and then
  applied to every row `listTasks` returned. On a project running several workflows, assignments in
  another workflow's load-bearing lanes were omitted from the tally — the same
  already-loaded-agent-wins bug this parameter exists to fix, now reachable through a different door.

  A column id is meaningful only RELATIVE TO ITS OWN WORKFLOW. `blocker-fanout.ts` documents exactly
  this and offers `classify` for it; this mirrors that shape rather than inventing a third one.

  Omitted → the legacy trio, i.e. today's behaviour.
  */
  countsAsAssignmentLoad?: (task: Task) => boolean;
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

export async function selectPermanentAgentForTask({ task, agentStore, taskStore, countsAsAssignmentLoad }: SelectPermanentAgentForTaskOptions): Promise<Agent | null> {
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
    const bearsLoad = countsAsAssignmentLoad
      ? countsAsAssignmentLoad(taskItem)
      /* DELIBERATE-LITERAL — the unconverted-caller default, reviewed 2026-07-31-05:40. */
      : LEGACY_ACTIVE_COLUMNS.has(taskItem.column);
    if (!taskItem.assignedAgentId || !bearsLoad) continue;
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
