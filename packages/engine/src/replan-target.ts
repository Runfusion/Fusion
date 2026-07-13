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
