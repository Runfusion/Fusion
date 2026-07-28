/*
FNXC:WorkflowColumnBoundary 2026-07-27-16:40 (E2E validation seam — PR #2475 review, P2):

THE production wiring that binds the graph's column-boundary controller to the store, lifted out
of `Executor.buildColumnBoundaryHooks` so there is exactly ONE copy of it.

WHY IT MOVED. The E2E suite needs to drive the REAL boundary wiring, and `buildColumnBoundaryHooks`
was a private method reachable only by constructing a whole Executor. The test therefore rebuilt
the hooks by hand — and the hand copy DIVERGED in three ways within a single PR cycle (a broader
active-continuation filter, a missing graph-owned-move marker, and a different audit run id). A
test that rebuilds the wiring proves the copy works, which is the same failure shape as a spy that
passes on an event the bus refused. Extracting the factory is the smallest seam that lets the test
exercise the real thing; the Executor now delegates and owns only what is genuinely Executor state
(the in-flight move set and its logger), passed in as callbacks.

Behavior is byte-identical to the method it replaces — this is a move, not a rewrite.
*/
import type { Task, TaskStore, WorkflowWorkItemState } from "@fusion/core";
import { ACTIVE_WORKFLOW_WORK_ITEM_STATES } from "@fusion/core";

import { createStoreIrPinPersistence, type WorkflowIrPinStoreSurface } from "./workflow-column-boundary.js";
import type { WorkflowColumnBoundaryHooks } from "./workflow-graph-task-runner.js";
import { generateSyntheticRunId } from "./run-audit.js";

export interface ExecutorColumnBoundaryHooksDeps {
  store: TaskStore;
  task: Pick<Task, "id">;
  /** The graph run id. Absent → the stable `${taskId}:workflow` fallback, as before. */
  workflowRunId?: string;
  /**
   * Executor-owned side channel: a graph-owned lifecycle move is marked in-flight for its
   * duration so the executor's own requeue path can tell "the graph moved this card" from "someone
   * else moved this card" (executor.ts, `workflowLifecycleMovesInFlight` + `graphRouting`).
   * Optional so a caller with no such state (the E2E harness) wires the rest of the real hooks
   * without inventing an Executor.
   */
  markMoveInFlight?: (taskId: string) => void;
  clearMoveInFlight?: (taskId: string) => void;
  /** Diagnostics sink for the boundary controller's warnings. */
  onWarn?: (message: string, detail: Record<string, unknown>) => void;
}

/**
 * Build the production column-boundary hooks: durable IR pin, capacity-suspension continuation,
 * the graph-owned `moveTask`, and the ids-only run-audit emission.
 */
export function createExecutorColumnBoundaryHooks(
  deps: ExecutorColumnBoundaryHooksDeps,
): WorkflowColumnBoundaryHooks {
  const { store, task, workflowRunId } = deps;
  // KTD-3 (U9b): store-backed durable IR pin. The cast is the same posture as
  // buildBranchPersistence — structural probe of the row surface so a store
  // lacking the pin fields degrades to the inert no-pin seam.
  const pinPersistence = createStoreIrPinPersistence(
    store as unknown as WorkflowIrPinStoreSurface,
    task.id,
  );
  return {
    pinNodeEntry: pinPersistence.pinNodeEntry,
    loadPriorPin: pinPersistence.loadPriorPin,
    // KTD-3 drift-park loop fix (PR #2342): detectDrift clears the stale pin
    // row fields so an ordinary requeue re-resolves the CURRENT IR fresh.
    clearPin: pinPersistence.clearPin,
    onSuspend: async (suspension) => {
      const items = await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] });
      /* Only an ACTIVE row suppresses a fresh continuation. A cancelled/exhausted/manual-required
         row is finished work, not a live wait — treating it as live would strand the card with no
         continuation to resume from. */
      const live = items.filter((item) =>
        ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state as WorkflowWorkItemState),
      );
      if (live.some((item) => item.nodeId === suspension.nodeId)) return;
      await store.replaceActiveTaskWorkflowContinuation({
        runId: `${workflowRunId ?? `${task.id}:workflow`}:continuation:${suspension.nodeId}:${items.length}`,
        taskId: task.id,
        nodeId: suspension.nodeId,
        kind: "task",
        state: "held",
        stableWorkflowRunId: workflowRunId ?? `${task.id}:workflow`,
        continuationSequence: items.length,
        waitReason: "capacity",
        sourceColumn: suspension.fromColumn,
        targetColumn: suspension.toColumn,
        irHash: suspension.irHash,
      });
    },
    moveTask: async (toColumn, ctx) => {
      deps.markMoveInFlight?.(task.id);
      try {
        await store.moveTask(task.id, toColumn, {
          moveSource: "engine",
          workflowMoveSource: "workflow-graph",
          bypassGuards: true,
          preserveProgress: true,
          workflowMoveMetadata: { fromColumn: ctx.fromColumn, nodeId: ctx.nodeId },
        });
      } finally {
        deps.clearMoveInFlight?.(task.id);
      }
    },
    emitAudit: async (event) => {
      await store.recordRunAuditEvent?.({
        taskId: event.taskId,
        agentId: "executor",
        runId: generateSyntheticRunId("workflow-column-boundary", event.taskId),
        domain: "database",
        mutationType: event.type,
        target: event.taskId,
        metadata:
          event.type === "task:column-transition"
            ? { taskId: event.taskId, workflowId: event.workflowId, fromColumn: event.fromColumn, toColumn: event.toColumn, nodeId: event.nodeId, irHash: event.irHash }
            : { taskId: event.taskId, workflowId: event.workflowId, pinnedNodeId: event.pinnedNodeId, reason: event.reason },
      });
    },
    onWarn: (message, detail) => {
      deps.onWarn?.(message, detail);
    },
  };
}
