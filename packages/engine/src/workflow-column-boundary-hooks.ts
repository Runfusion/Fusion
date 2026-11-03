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
import type { AgentStore, Task, TaskStore, WorkflowWorkItemState } from "@fusion/core";
import { ACTIVE_WORKFLOW_WORK_ITEM_STATES } from "@fusion/core";

import { createStoreIrPinPersistence, type WorkflowIrPinStoreSurface } from "./workflows/workflow-column-boundary.js";
import { resolveCapacityAgentSurface } from "./workflows/capacity-gate-facts.js";
import type { WorkflowColumnBoundaryHooks } from "./workflows/workflow-graph-task-runner.js";
import { generateSyntheticRunId } from "./util/run-audit.js";
import { emitBoundedRunAudit } from "./util/emit-bounded-run-audit.js";

export interface ExecutorColumnBoundaryHooksDeps {
  store: TaskStore;
  task: Pick<Task, "id" | "assignedAgentId" | "checkedOutBy">;
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
  /*
  FNXC:CapacityGateFacts 2026-11-02-21:45 (RUFU-372 code review P1):
  The agent ledger is a separate store: `TaskStore` has no `listAgents`, so a snapshot given only the task
  store cannot evaluate the `schedulerAgentActive` gate at all and answers `capacityAgentGateError:
  "unavailable"` instead. Optional because a caller with no agent backend wired (an E2E harness, a
  store-less fixture) must keep working. When it is absent, `capacityFactsSource` falls back to the
  project-scoped AgentStore the task store already owns.
  */
  agentStore?: AgentStore | null;
}

/**
 * Build the production column-boundary hooks: durable IR pin, capacity-suspension continuation,
 * the graph-owned `moveTask`, and the ids-only run-audit emission.
 */
export function createExecutorColumnBoundaryHooks(
  deps: ExecutorColumnBoundaryHooksDeps,
): WorkflowColumnBoundaryHooks {
  const { store, task, workflowRunId, agentStore } = deps;
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
    /* FNXC:EnginePause 2026-08-01-00:20: settings re-read per node entry — event-independent. */
    isPaused: async () => {
      try {
        const settings = await store.getSettings();
        return settings.globalPause === true;
      } catch {
        return false;
      }
    },
    onSuspend: async (suspension) => {
      /*
      FNXC:CapacityGateFacts 2026-11-02-20:55 (RUFU-372 second revision) — THE waitReason STORAGE LOCK.
      The engine's deferral REASON now splits in two (`scheduler-owned-seam` for a structural hold→WIP
      seam park, `capacity` for a real pool refusal), but this storage tag stays the single literal
      `"capacity"` for BOTH classes, and the three reasons are all load-bearing:
      1. `WorkflowWorkItem["waitReason"]` is a narrow storage enum (`"planning" | "capacity" | null`,
         packages/core/src/types/merge/merge-queue.ts). A row mapper silently coerces any value outside
         that set to `null` — a new spelling would be LOSSY ON WRITE, so the seam park would lose its
         wait tag entirely rather than gain a new one.
      2. `hold-release.ts` (`evaluateUnplannedForExecutionInner`) reads `item.waitReason === "capacity"`
         together with `sourceColumn` to prove a card is READY AT A CAPACITY BOUNDARY — the precondition
         that lets a finished Plan Review release instead of re-waiting. Relabeling the seam class would
         silently break that plan-review convergence.
      3. Dispatch does not gate on `waitReason` (documented in `in-process-runtime.ts`), so a new value
         would buy nothing on read while costing the tag on write.
      The split is therefore a LABEL-layer change (marker + lifecycle event + run-audit reason metadata),
      never a storage-layer one. Do not "fix" the apparent inconsistency here.
      */
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
          lifecycleReason: "workflow-graph-node-column",
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
      await emitBoundedRunAudit(store, {
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
    /*
    FNXC:CapacityGateFacts 2026-11-02-20:55 / 21:45 (RUFU-372):
    Supplies the inputs the boundary controller cannot know — the store surface the snapshot reads, the
    project ceiling, and the card's owning agent — so a refused crossing can name WHICH gate bound and
    against what numbers. Read lazily and best-effort: a settings read that rejects simply leaves the
    ceiling unset (the snapshot then answers `unknown` beside a null limit, which is honest), and the
    boundary still attaches whatever it proved. The shared enrichment caches are per wiring instance, so
    the two canonical walks inside one compute never re-resolve the same workflow IR.

    `agents` is the second reader the snapshot needs, and the reason this provider exists: agent rows are
    not on the task store, so without it the `schedulerAgentActive` gate — the gate RunFusion's wrong
    guesses were about — was unreachable from every production deferral while the row still matched a
    `reason=capacity` monitor. Resolution prefers a wired AgentStore, falls back to the store's own
    project-scoped one, and yields nothing (reported honestly as `unavailable`) when neither exists. It
    never throws: this runs on a `catch` path where a throw becomes a terminal graph-failed park.
    */
    capacityFactsSource: async () => {
      let settings: { maxConcurrent?: number } | undefined;
      try {
        settings = await store.getSettings();
      } catch {
        settings = undefined;
      }
      return {
        store,
        agents: resolveCapacityAgentSurface(store, agentStore),
        settings,
        assignedAgentId: task.assignedAgentId ?? task.checkedOutBy,
        caches: { irCache: new Map(), selectionCache: new Map() },
      };
    },
  };
}
