import type { Task } from "@fusion/core";
/*
FNXC:MergeQueue 2026-07-15-10:40:
Vite aliases `@fusion/core` to types.ts only in the dashboard app build; import the active-merge predicate from its source module (same pattern as resolveEffectiveAutoMerge).
*/
import { isActiveMergeStatus } from "../../../core/src/merge/active-merge-status";
/*
FNXC:ColumnCapacity 2026-10-10-20:08 (RUFU-362):
The failed-park rule is read from its one home in core (`isFailedWipPark`), the same predicate
`isRunningAgentTask` (FN-8704) and the column-capacity counters consume, so the switcher's occupancy
can never answer differently from the lane's real admission decision. Imported from source for the
same reason as `isActiveMergeStatus` above: the app build aliases `@fusion/core` to `types.ts` only.
*/
import { isFailedWipPark } from "../../../core/src/agents/live-agent-count";
import type { BoardWorkflowColumn, BoardWorkflowsPayload } from "../api";
import { ALL_WORKFLOWS_BOARD_VIEW_ID } from "../utils/boardWorkflowSelection";

export interface WorkflowStatusCounts {
  plan: number;
  progress: number;
  review: number;
  merging: number;
}

const EMPTY_COUNTS = (): WorkflowStatusCounts => ({
  plan: 0,
  progress: 0,
  review: 0,
  merging: 0,
});

type WorkflowStatusBucket = "plan" | "progress" | "review" | "excluded";

/*
FNXC:MergeQueue 2026-07-15-10:40:
AI merge uses reviewing/landing for most of the live merge window; count them with merging* so the workflow switcher flash indicator is not blank while the pump is busy.
*/

/**
 * FNXC:WorkflowSwitcher 2026-09-07-12:17:
 * The board/list workflow dropdown reports active work as Plan, Progress, and Review. Complete and board-hidden columns contribute to no phase; every merge-orchestration, merge-blocking, or human-review column contributes to Review before WIP is considered, so a multi-trait review lane is counted exactly once.
 * Canonical column ids are presentation fallbacks only when the whole workflow has no resolved lifecycle traits. Once any trait is resolved, flags are authoritative for every column so a modern workflow can reuse historical ids without being misclassified.
 */
function classifyWorkflowStatusColumn(
  column: BoardWorkflowColumn,
  useCanonicalFallback: boolean,
): WorkflowStatusBucket {
  if (column.flags.hiddenFromBoard || column.flags.complete) return "excluded";
  if (
    column.flags.mergeOrchestration ||
    column.flags.mergeBlocker ||
    column.flags.humanReview
  ) return "review";
  if (column.flags.countsTowardWip && !column.flags.intake) return "progress";

  if (useCanonicalFallback) {
    switch (column.id) {
      case "done":
        return "excluded";
      case "in-review":
        return "review";
      case "in-progress":
        return "progress";
    }
  }

  return "plan";
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
  const canonicalFallbackByWorkflowId = new Map<string, boolean>();

  for (const workflow of boardWorkflows.workflows) {
    countsByWorkflow.set(workflow.id, EMPTY_COUNTS());
    columnsByWorkflowId.set(
      workflow.id,
      new Map(workflow.columns.map((column) => [column.id, column]))
    );
    canonicalFallbackByWorkflowId.set(
      workflow.id,
      workflow.columns.every((column) =>
        Object.values(column.flags).every((flag) => !flag),
      ),
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

    const bucket = classifyWorkflowStatusColumn(
      column,
      canonicalFallbackByWorkflowId.get(workflow.id) === true,
    );
    if (bucket === "excluded") continue;

    const counts = countsByWorkflow.get(workflow.id) ?? EMPTY_COUNTS();
    /*
    FNXC:ColumnCapacity 2026-10-10-20:08 (RUFU-362):
    A `status:"failed"` WIP park is operator-visible debris, not live work: it stays rendered in its
    lane until someone retries or re-homes it, but FN-8704 already decided it holds no agent slot and
    RUFU-362 extends that to the column slot (a lane of limit N holding N failed parks is 0% busy, and
    reporting it as N in progress told operators the board was working while the engine spun on
    `capacity-exhausted` suspensions). Only the two occupancy buckets drop it — `plan` counts queue
    depth, and the merge flash below keys on the task's own merge status — so neither loses meaning.
    The card itself is untouched: this suppresses a count, never a render.
    */
    const countsOccupancy =
      !isFailedWipPark(task) || (bucket !== "progress" && bucket !== "review");
    if (countsOccupancy) {
      counts[bucket] += 1;
      aggregateCounts[bucket] += 1;
    }
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
