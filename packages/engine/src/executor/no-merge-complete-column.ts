/**
 * FNXC:CodeOrganization 2026-08-03-20:25:
 * advanceNoMergeWorkflowToCompleteColumn peeled from TaskExecutor (U4).
 * After a no-merge workflow finishes, advance the card into the workflow complete column.
 *
 * FNXC:WorkflowLifecycle 2026-07-18-14:20 (U5c / U1 KTD-1/2/3/12):
 * Production column-boundary hooks make the graph the single source of truth for lifecycle MOVES:
 * as the interpreter enters each node, createWorkflowColumnBoundary moves the card to the node's
 * trait column. Move-safety lives in the controller (same-column no-op, KTD-2 hold→wip parked for
 * the scheduler, rejected-move leaves the card in place); the executor only supplies raw seams
 * (moveTask engine-sourced with bypassGuards for KTD-9, ids-only audit KTD-12, warn log sink).
 *
 * FNXC:WorkflowIrPin 2026-07-19-18:30 (KTD-3 / U9b):
 * The KTD-3 durable IR pin is WIRED via task-row fields (workflowIrPin/workflowIrPinNodeId/
 * workflowIrPinColumnId, migration 0026). pinNodeEntry/loadPriorPin bind through
 * createStoreIrPinPersistence; drift parks with task:reconcile-workflow-drift. Stores without the
 * fields degrade to the previous inert no-pin posture.
 *
 * FNXC:WorkflowNoMergeCompletion 2026-07-19-12:40:
 * A workflow with NO merge region had no way to reach its `complete` column. `end` is a graph
 * terminal, never a column destination (KTD-1), so a card only lands in complete when a REAL node
 * lives there. Merge-bearing built-ins get that from post-merge-verification; no-merge workflows
 * do not. Without this mover a lead-generation card finished its graph and sat in outreach forever.
 *
 * Narrow deliberately: fires ONLY when the IR declares no merge-orchestration column (merge-bearing
 * workflows stay byte-identical); does NOT reintroduce a move on `end`; no complete-trait column
 * no-ops; no worktree is not an error.
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
