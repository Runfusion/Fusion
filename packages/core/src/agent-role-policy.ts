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

/**
 * True when the agent fills the Executor slot for BACKLOG auto-pickup.
 *
 * NOTE (U2): the deprecated `engineer` role is intentionally NOT folded in here.
 * The pre-existing contract is finer-grained than a blanket alias: `engineer`
 * may take an *explicitly routed* implementation task (see
 * {@link canAgentTakeImplementationTaskForExplicitRouting}) but must NOT
 * auto-claim unassigned implementation work — only `executor` does. Treating
 * `engineer` as a full executor alias here would regress that guard.
 */
export function isExecutorRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "executor";
}

/** @deprecated `engineer` is superseded by `executor` (U2); retained for the
 *  explicit-routing alias path so legacy engineer-role agents keep working. */
export function isEngineerRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "engineer";
}

/** True for the Lead role (company-model U2): the Todo-column agent that
 *  structures incoming work (absorbing the deprecated `triage` role's job). */
export function isLeadRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "lead" || agent.role === "triage";
}

/** True for the Reviewer role (company-model U2): the In-Review-column agent. */
export function isReviewerRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "reviewer";
}

/** True for the project-level CEO role (company-model U2). */
export function isCeoRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "ceo";
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
