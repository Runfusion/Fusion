import { rm } from "node:fs/promises";
import {
  computeWorkflowIrPin,
  disposeTaskBeforeReset,
  planTaskColumnRestart,
  RESTART_STAGE_FENCE_REASON,
  resolveTaskSymbolsForTask,
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
} from "@fusion/core";
import { isMergeActiveStatus, isStaleMergeActiveStatus, optionalStepRevisionResetOutcome, resolveColumnResumeNode } from "@fusion/engine";
import { badRequest, conflict, notFound } from "../api-error.js";

interface RestartTaskStageEngine {
  clearTaskPauseAbortState?: (taskId: string) => void | Promise<void>;
}

type RestartTaskStageStore = TaskStore & {
  clearWorkflowRunStepInstancesAsync?: (taskId: string) => Promise<void>;
};

export interface RestartTaskStageDeps {
  store: RestartTaskStageStore;
  engine?: RestartTaskStageEngine;
  taskId: string;
  confirm?: boolean;
  onRefusal?: "throw" | "signal";
  activeMergeTaskId?: string | null;
  getActiveMergeTaskId?: () => string | null;
  staleMergingStatusMinAgeMs?: number;
}

export type RestartTaskStageResult = Task | Extract<ReturnType<typeof planTaskColumnRestart>, { kind: "refused" }>;

function refusalError(plan: Extract<ReturnType<typeof planTaskColumnRestart>, { kind: "refused" }>) {
  if (plan.reason === "no-entry-node-in-column") {
    const later = plan.detail?.resolvedEntryNodeColumn;
    return badRequest(later
      ? `The ${later} workflow node is later than the task's ${plan.detail?.resolvedEntryNodeColumn === later ? "current" : ""} column; this stage cannot be retried in place`
      : "This column has no workflow entry node and cannot be retried in place");
  }
  return badRequest(`Retry is unavailable: ${plan.reason}`);
}

/*
FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
Retry is the operator name for this in-place stage restart. The module name and
`RESTART_STAGE_FENCE_REASON` remain stable internal/durable identifiers so already parked cards
with `restart-stage-publishing` are recognized and can safely resume publication.

FNXC:ColumnRestart 2026-08-27-23:23:
Restart publishes task state and a workflow continuation through separate durable writes, so write
ordering alone cannot prevent a dispatcher from observing stale artifacts with a new continuation,
or a discarded row through an old continuation. A durable pause is the publication fence every
existing dispatcher and merge gate already honours: W1 raises it before cancellation and W6 lowers
it only after the successor is armed. Re-read the task after W1 before disposing its runtime owner;
production reads materialize a new row, so the pre-fence validation snapshot cannot prove that the
disposer operates behind the durable fence.

A crash between those writes intentionally leaves `restart-stage-publishing` parked and visible.
No automatic sweep owns this reason; rerunning the operator action reuses the same filter and
replace primitive. PROMPT.md deletion is W4, after the durable plan patch and before arm/unfence,
so neither an unmarked plan nor a freshly replanned prompt can be removed. This route adds no new
run-audit mutation: reset/retry use task log entries and pause lifecycle records already provide
the operator audit trail.

FNXC:MergeReliability 2026-08-28-15:15:
The restart fence uses `isMergeActiveStatus` from
`packages/engine/src/merge/merge-active-status.ts` so every merge phase, including the long-running
AI review phase, shares one definition and cannot drift open. The stale-stamp bypass is unchanged:
an orphaned stamp in any phase remains retryable after the shared liveness and age proof passes.

FNXC:MergeReliability 2026-08-28-15:51:
The initial merge check is only an early refusal; a merger can claim the task before Retry raises
its durable pause. Claim the publication fence with `updateTaskAtomic` and classify the exact
lock-held snapshot with the same active/stale predicate and a fresh in-process lease read before
disposing any runtime or publishing restart artifacts. If that snapshot or lease is merge-active,
restore the prior pause fields and return the same conflict so Retry never interrupts a merger that
won the race. The ordinary `pauseTask` write still follows for admitted retries so pause lifecycle
logging and WIP/review presentation remain unchanged.
*/
function isLiveMergeRestart(task: Task, deps: RestartTaskStageDeps): boolean {
  const activeMergeTaskId = deps.getActiveMergeTaskId?.() ?? deps.activeMergeTaskId ?? null;
  if (activeMergeTaskId === task.id) return true;
  return isMergeActiveStatus(task.status) && !isStaleMergeActiveStatus(task, {
    activeMergeTaskId,
    minAgeMs: deps.staleMergingStatusMinAgeMs,
  });
}

export async function restartTaskStage(deps: RestartTaskStageDeps): Promise<RestartTaskStageResult> {
  const { store, engine, taskId, confirm } = deps;
  if (confirm !== true) {
    throw badRequest("Retry discards work produced in the current stage. Pass { \"confirm\": true } to proceed.");
  }

  return store.withPlanningLifecycleLock(taskId, async () => {
    let publicationStep = "validate";
    let fenced = false;
    try {
      const task = await store.getTask(taskId);
      if (!task) throw notFound(`Task ${taskId} not found`);
      const ir = await resolveWorkflowIrForTask(store, task.id);
      const entryNode = resolveColumnResumeNode(ir, task.column);
      const plan = planTaskColumnRestart({ task, ir, entryNode });
      if (plan.kind === "refused") {
        if (deps.onRefusal === "signal") return plan;
        throw refusalError(plan);
      }
      if (isLiveMergeRestart(task, deps)) {
        throw conflict("Retry is unavailable while a merge is active");
      }

      publicationStep = "raise publication fence";
      let mergeActiveAtFence = false;
      let priorPaused: Task["paused"];
      let priorPausedReason: Task["pausedReason"];
      await store.updateTaskAtomic(taskId, (fenceSnapshot) => {
        priorPaused = fenceSnapshot.paused;
        priorPausedReason = fenceSnapshot.pausedReason;
        mergeActiveAtFence = isLiveMergeRestart(fenceSnapshot, deps);
        return {
          paused: true,
          pausedReason: RESTART_STAGE_FENCE_REASON,
        };
      });
      fenced = true;

      if (mergeActiveAtFence) {
        publicationStep = "release publication fence after merge claim";
        await store.updateTaskAtomic(taskId, (current) => {
          if (current.pausedReason !== RESTART_STAGE_FENCE_REASON) return null;
          return {
            paused: priorPaused ?? (null as unknown as Task["paused"]),
            pausedReason: priorPausedReason ?? (null as unknown as Task["pausedReason"]),
          };
        });
        fenced = false;
        throw conflict("Retry is unavailable while a merge is active");
      }

      await store.pauseTask(taskId, true, undefined, { pausedReason: RESTART_STAGE_FENCE_REASON });
      const fencedTask = await store.getTask(taskId);
      if (!fencedTask) throw notFound(`Task ${taskId} not found after fencing`);

      publicationStep = "dispose active runtime owner";
      await Promise.resolve(engine?.clearTaskPauseAbortState?.(taskId));
      await disposeTaskBeforeReset(store, fencedTask);

      publicationStep = "confirm restart target";
      const freshTask = await store.getTask(taskId);
      if (!freshTask || freshTask.column !== task.column || resolveColumnResumeNode(ir, freshTask?.column)?.id !== plan.entryNodeId) {
        await store.pauseTask(taskId, false);
        fenced = false;
        throw conflict("Retry target changed while cancellation was settling; retry safely");
      }

      publicationStep = "clear restart boundaries";
      await store.resetTerminalFailureAutoRecoveryBudget(taskId);
      await store.clearWorkflowRunStepInstancesAsync?.(taskId);
      if (plan.releaseSymbolLocks) {
        const symbols = resolveTaskSymbolsForTask(freshTask);
        if (symbols.resolvable) await store.releaseSymbolLocks?.(symbols.symbols, taskId);
      }

      publicationStep = "retire predecessor continuations";
      await store.cancelActiveWorkflowWorkItemsForTask(taskId, {
        kinds: ["task"],
        lastError: "restart-stage-fence",
      });

      publicationStep = "publish discarded stage artifacts";
      await store.updateTask(taskId, {
        ...plan.patch,
        paused: true,
        pausedReason: RESTART_STAGE_FENCE_REASON,
      });

      publicationStep = "remove superseded prompt";
      if (plan.deletePrompt) {
        const promptPath = `${store.getRootDir()}/.fusion/tasks/${taskId}/PROMPT.md`;
        await rm(promptPath, { force: true });
      }

      publicationStep = "arm workflow continuation";
      const continuationSequence = (await store.listWorkflowWorkItemsForTask(taskId)).length;
      await store.replaceActiveTaskWorkflowContinuation({
        taskId,
        nodeId: plan.entryNodeId,
        kind: "task",
        state: "runnable",
        waitReason: null,
        blockedReason: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        retryAfter: null,
        sourceColumn: freshTask.column,
        targetColumn: freshTask.column,
        continuationSequence,
        stableWorkflowRunId: `${taskId}:${ir.name}`,
        runId: `${taskId}:restart-stage:${plan.entryNodeId}:${continuationSequence}`,
        irHash: computeWorkflowIrPin(ir, plan.entryNodeId).irHash,
      });

      publicationStep = "lower publication fence";
      await store.pauseTask(taskId, false);
      fenced = false;
      const preservedWorkspaceRepositoryRecords = Object.keys(task.workspaceWorktrees ?? {}).length;
      await store.logEntry(taskId, `Retry requested from dashboard (${plan.scope} restart in ${task.column}, discarded ${plan.discardedWorkflowStepIds.length} workflow step result(s), preserved ${preservedWorkspaceRepositoryRecords} workspace repository record(s), re-entering at ${plan.entryNodeId})`);
      /*
      FNXC:WorkflowRevisionBudget 2026-09-05-23:30:
      FN-1711: an explicit operator restart opens a NEW review episode, so the discarded gates start
      with a fresh revision budget. The budget is derived from the append-only task log, which the
      restart cannot rewrite; it appends a reset marker per discarded gate instead. Without it the
      restart re-ran the review at full model cost and the remediation was refused for a budget the
      previous episode had already spent — the card could never converge.
      */
      for (const workflowStepId of plan.discardedWorkflowStepIds) {
        await store.logEntry(
          taskId,
          `Revision budget reset for '${workflowStepId}' by operator retry`,
          optionalStepRevisionResetOutcome(workflowStepId),
        ).catch(() => undefined);
      }
      const updated = await store.getTask(taskId);
      if (!updated) throw notFound(`Task ${taskId} not found after retry`);
      return updated;
    } catch (error) {
      if (fenced) {
        await store.logEntry(taskId, `Retry publication parked at ${publicationStep}; rerun Retry safely`).catch(() => undefined);
        if (error instanceof Error && ("status" in error)) throw error;
        throw conflict(`Retry paused at ${publicationStep}; the card is parked with ${RESTART_STAGE_FENCE_REASON} and can be retried safely`);
      }
      throw error;
    }
  });
}
