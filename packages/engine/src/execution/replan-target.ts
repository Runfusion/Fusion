import type { Task, TaskStore } from "@fusion/core";
import { resolveWorkflowIrForTask, workflowHasColumn } from "@fusion/core";

/*
FNXC:WorkflowReplan 2026-07-12-23:15:
Engine rebounds that send a task back for (re)planning — Plan Review REVISE, stale-spec
enforcement, filesystem-validation failures — used to hardcode moveTask(id, "triage").
Workflows without a "triage" column (Coding (Ideas) merges the planner into "todo") ended up
with a column-orphaned card: the board rendered it back in the intake lane ("Ideas") and the
aggregate All-workflows view dropped it entirely. The replan target must be resolved against
the task's OWN workflow: "triage" when declared, otherwise the plan-in-place planner column
("todo"). Triage's todo-discovery picks up `needs-replan` todo cards so plan-in-place replans
still run.

FNXC:WorkflowReplan 2026-07-13-11:30:
The final fallback is "triage", NEVER the workflow's entry column. Workflows that declare
neither "triage" nor "todo" (builtin marketing, arbitrary customs) have no column the triage
service scans, so parking a needs-replan card in their custom entry column strands it forever
— and the legacy move path throws on custom targets, aborting the replan before the status
write. "triage" preserves the pre-workflow-aware behavior for these workflows: the move is
legal from every legacy column and eligibleTriageTasks re-specifies unconditionally.
*/
/*
 * FNXC:WorkflowReplan 2026-07-15-13:15:
 * FN-7977: a planning/provider recovery may finish after another engine lane has
 * started execution. Recovery callers must prove the live row is still planning
 * before writing planning state; worktrees and execution or terminal columns are
 * durable evidence that the task has advanced.
 *
 * FNXC:WorkflowReplan 2026-07-16-05:35:
 * Materialized steps are NOT advancement evidence for a card still parked in a planner
 * lane. Triage materializes steps when it finalizes a spec, so every replan (Plan Review
 * REVISE -> needs-replan) legitimately carries the steps of its previous planning pass.
 * Counting steps>0 as "advanced" made the primary triage claim in specifyTask() skip its
 * status:"planning" write on every poll: the card was re-claimed forever, never planned,
 * and — because wedged cards keep occupying maxTriageConcurrent slots — starved every
 * healthy card queued behind them. Both planner surfaces must stay plannable: the "triage"
 * column, and plan-in-place workflows (Coding (Ideas)) that park needs-replan cards in
 * "todo" carrying a real spec. A planned-and-queued "todo" card with no planning status is
 * still genuinely advanced, so steps remain the deciding signal there.
 */

/** Statuses that explicitly park a card for (re)planning, whichever column holds it. */
const PLANNING_STAGE_STATUSES = new Set(["planning", "needs-replan", "plan-review-unavailable"]);

export function hasAdvancedPastPlanning(
  task: Pick<Task, "column" | "worktree" | "steps" | "status">,
): boolean {
  if (
    task.column === "in-progress"
    || task.column === "in-review"
    || task.column === "done"
    || task.column === "archived"
  ) {
    return true;
  }
  // A worktree proves an executor claimed the card, even while it still sits in a planner lane.
  if (task.worktree != null) {
    return true;
  }
  // The planner column itself is never "advanced" — nothing executes out of triage.
  if (task.column === "triage") {
    return false;
  }
  // Plan-in-place planner lane ("todo"): a card explicitly parked for planning has not advanced.
  if (task.status != null && PLANNING_STAGE_STATUSES.has(task.status)) {
    return false;
  }
  return (task.steps?.length ?? 0) > 0;
}

export function isTaskStillInPlanningStage(
  task: Pick<Task, "column" | "worktree" | "steps" | "status">,
): boolean {
  return !hasAdvancedPastPlanning(task);
}

export async function resolveReplanTargetColumn(store: TaskStore, taskId: string): Promise<string> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    if (workflowHasColumn(ir, "triage")) return "triage";
    if (workflowHasColumn(ir, "todo")) return "todo";
    return "triage";
  } catch {
    return "triage";
  }
}

/**
 * Move `task` to its workflow-aware replan column unless it is already there.
 * Pass `target` when the caller already resolved it (e.g. to log the target
 * first) so the resolve/compare/move contract still lives in one place.
 */
export async function moveTaskToReplanColumn(
  store: TaskStore,
  task: Pick<Task, "id" | "column">,
  target?: string,
): Promise<string> {
  const replanColumn = target ?? await resolveReplanTargetColumn(store, task.id);
  if (task.column !== replanColumn) {
    await store.moveTask(task.id, replanColumn);
  }
  return replanColumn;
}
