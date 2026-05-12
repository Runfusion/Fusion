import type { Agent, Task } from "./types.js";

const IMPLEMENTATION_TASK_COLUMNS: ReadonlySet<Task["column"]> = new Set([
  "triage",
  "todo",
  "in-progress",
  "in-review",
]);

export function isImplementationTask(task: Pick<Task, "column">): boolean {
  return IMPLEMENTATION_TASK_COLUMNS.has(task.column);
}

export function isExecutorRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "executor";
}

export function isEngineerRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "engineer";
}

export function canAgentTakeImplementationTaskForExplicitRouting(
  agent: Pick<Agent, "role">,
  task: Pick<Task, "column">,
): boolean {
  return !isImplementationTask(task) || isExecutorRoleAgent(agent) || isEngineerRoleAgent(agent);
}

export function canAgentTakeImplementationTaskForBacklogPickup(
  agent: Pick<Agent, "role">,
  task: Pick<Task, "column">,
): boolean {
  return !isImplementationTask(task) || isExecutorRoleAgent(agent);
}

export function canAgentTakeImplementationTask(
  agent: Pick<Agent, "role">,
  task: Pick<Task, "column">,
): boolean {
  return canAgentTakeImplementationTaskForBacklogPickup(agent, task);
}

export function formatRoleMismatchReason(
  agent: Pick<Agent, "id" | "role">,
  task: Pick<Task, "id" | "column">,
): string {
  return `Agent ${agent.id} has role "${agent.role}"; implementation task ${task.id} requires an "executor"-role agent by default, with durable "engineer" supported only for explicit routing. Pass override=true to bypass.`;
}
