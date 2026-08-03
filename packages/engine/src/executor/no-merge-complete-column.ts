/**
 * FNXC:CodeOrganization 2026-08-03-20:25:
 * advanceNoMergeWorkflowToCompleteColumn peeled from TaskExecutor (U4).
 * After a no-merge workflow finishes, advance the card into the workflow complete column.
 */
import type { TaskDetail, TaskStore, WorkflowIr } from "@fusion/core";
import {
  resolveCompleteColumn,
  resolveMergeOrchestrationColumn,
  resolveWorkflowIrForTask,
} from "@fusion/core";
import { executorLog } from "../logger.js";
import { generateSyntheticRunId } from "../util/run-audit.js";

export async function advanceNoMergeWorkflowToCompleteColumn(
  store: TaskStore,
  task: TaskDetail,
): Promise<void> {
  let ir: WorkflowIr;
  try {
    ir = await resolveWorkflowIrForTask(store, task.id);
  } catch {
    // IR resolution is best-effort here: a card that already finished its graph
    // must never be failed by a bookkeeping lookup.
    return;
  }
  // Merge-bearing workflow → the merge path owns the complete column. Return
  // before reading anything else so this branch is provably inert for them.
  if (resolveMergeOrchestrationColumn(ir) !== undefined) return;

  const completeColumn = resolveCompleteColumn(ir);
  if (!completeColumn || completeColumn === task.column) return;

  try {
    /*
     * The normal move path first. A no-merge workflow's last real node sits in
     * the column immediately before the complete column, but the graph's own
     * column adjacency is derived from node placement — and NOTHING is placed
     * in the complete column (that is the whole gap), so `resolveAllowedColumns`
     * cannot see the edge and the shared validator rejects it. `bypassGuards`
     * is therefore required for adjacency alone; every other guard the flag
     * relaxes (merge-blocker in particular) is vacuous here because this branch
     * only runs for a workflow with no merge region at all.
     */
    await store.moveTask(task.id, completeColumn, {
      moveSource: "engine",
      workflowMoveSource: "workflow-graph",
      bypassGuards: true,
      preserveProgress: true,
      workflowMoveMetadata: { fromColumn: task.column, reason: "no-merge-workflow-completed" },
    });
  } catch (err) {
    executorLog.warn(
      `[workflow-graph] ${task.id} completed a no-merge workflow but could not advance to '${completeColumn}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // ids/outcomes-only metadata — no prose, no node/run internals.
  await store.recordRunAuditEvent?.({
    taskId: task.id,
    agentId: "executor",
    runId: generateSyntheticRunId("workflow-no-merge-completion", task.id),
    domain: "database",
    mutationType: "task:workflow-complete-column-advanced",
    target: task.id,
    metadata: { taskId: task.id, fromColumn: task.column, toColumn: completeColumn, reason: "no-merge-workflow-completed" },
  });
}
