import type { Task } from "@fusion/core";
/*
FNXC:MergeQueue 2026-07-15-10:40:
Vite aliases `@fusion/core` to types.ts only in the dashboard app build; import the active-merge predicate from its source module (same pattern as resolveEffectiveAutoMerge).
*/
import { isActiveMergeStatus } from "../../../core/src/active-merge-status";
import type { BoardWorkflowColumn, BoardWorkflowsPayload } from "../api";
import { ALL_WORKFLOWS_BOARD_VIEW_ID } from "../utils/boardWorkflowSelection";

export interface WorkflowStatusCounts {
  todo: number;
  inProgress: number;
  done: number;
  merging: number;
}

const EMPTY_COUNTS = (): WorkflowStatusCounts => ({
  todo: 0,
  inProgress: 0,
  done: 0,
  merging: 0,
});

type WorkflowStatusBucket = keyof WorkflowStatusCounts | "excluded";

/*
FNXC:MergeQueue 2026-07-15-10:40:
AI merge uses reviewing/landing for most of the live merge window; count them with merging* so the workflow switcher flash indicator is not blank while the pump is busy.
*/

/**
 * FNXC:WorkflowSwitcher 2026-06-20-00:09:
 * The board/list workflow dropdown must show compact Todo, In Progress, and Done task counts for every selectable workflow without duplicating logic across render surfaces.
 * Use workflow column flags as the source of truth: archived or board-hidden columns are excluded, complete columns count as Done, active non-intake WIP columns count as In Progress, and all remaining visible work counts as Todo/not-yet-started.
 *
 * FNXC:WorkflowSwitcher 2026-06-21-00:00:
 * Built-in linear workflows synthesize canonical lifecycle columns with empty traits, so their resolved flags cannot identify Done, In Progress, or Archived buckets.
 * Fall back to canonical lifecycle column ids only after flag-based classification fails, keeping trait-bearing workflows authoritative while preventing Done tasks in Quick fix-style lanes from being miscounted.
 */
function classifyWorkflowStatusColumn(
  column: BoardWorkflowColumn
): WorkflowStatusBucket {
  if (column.flags.archived || column.flags.hiddenFromBoard) return "excluded";
  if (column.flags.complete) return "done";
  if (column.flags.countsTowardWip && !column.flags.intake) return "inProgress";

  switch (column.id) {
    case "archived":
      return "excluded";
    case "done":
      return "done";
    case "in-progress":
      return "inProgress";
    default:
      return "todo";
  }
}

export function computeWorkflowStatusCounts(
  tasks: readonly Task[] | null | undefined,
  boardWorkflows: BoardWorkflowsPayload | null | undefined
): Map<string, WorkflowStatusCounts> {
  const countsByWorkflow = new Map<string, WorkflowStatusCounts>();
  if (!boardWorkflows) return countsByWorkflow;

  const workflowsById = new Map(
    boardWorkflows.workflows.map((workflow) => [workflow.id, workflow])
  );
  const knownWorkflowIds = new Set(workflowsById.keys());
  const columnsByWorkflowId = new Map<
    string,
    Map<string, BoardWorkflowColumn>
  >();

  for (const workflow of boardWorkflows.workflows) {
    countsByWorkflow.set(workflow.id, EMPTY_COUNTS());
    columnsByWorkflowId.set(
      workflow.id,
      new Map(workflow.columns.map((column) => [column.id, column]))
    );
  }

  const aggregateCounts = EMPTY_COUNTS();
  countsByWorkflow.set(ALL_WORKFLOWS_BOARD_VIEW_ID, aggregateCounts);
  if (!tasks?.length) return countsByWorkflow;

  for (const task of tasks) {
    const assignedWorkflowId = boardWorkflows.taskWorkflowIds[task.id];
    /*
    FNXC:WorkflowSwitcher 2026-06-29-18:37:
    Workflow counts must follow the same stale-assignment repair semantics as Board rendering: missing or unknown task-workflow ids fall back to the default workflow so cards and selector counts do not diverge while taskWorkflowIds is stale.
    */
    const workflowId = assignedWorkflowId && knownWorkflowIds.has(assignedWorkflowId)
      ? assignedWorkflowId
      : boardWorkflows.defaultWorkflowId;
    const workflow = workflowsById.get(workflowId);
    if (!workflow) continue;

    const column = columnsByWorkflowId.get(workflow.id)?.get(task.column);
    if (!column) continue;

    const bucket = classifyWorkflowStatusColumn(column);
    if (bucket === "excluded") continue;

    const counts = countsByWorkflow.get(workflow.id) ?? EMPTY_COUNTS();
    counts[bucket] += 1;
    aggregateCounts[bucket] += 1;
    if (isActiveMergeStatus(task.status)) {
      /*
      FNXC:WorkflowSwitcher 2026-06-22-20:30:
      Workflow boards need a visible flashing indicator in the workflow dropdown when any task assigned to that workflow is actively merging, independent of whether the workflow's review/merge column buckets as Todo or In Progress.

      FNXC:MergeQueue 2026-07-15-10:40:
      Include AI-merge reviewing/landing so the indicator matches the single-flight merge owner the engine already tracks.
      */
      counts.merging += 1;
      aggregateCounts.merging += 1;
    }
    countsByWorkflow.set(workflow.id, counts);
  }

  return countsByWorkflow;
}
