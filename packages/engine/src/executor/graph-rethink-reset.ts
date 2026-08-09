/**
 * FNXC:CodeOrganization 2026-08-03-20:35:
 * applyGraphRethinkReset peeled from TaskExecutor (U4).
 * RETHINK reset-on-rework (KTD-4): reset foreach instance step to baseline before rework re-entry.
 */
import type { TaskStore } from "@fusion/core";
import { resetStepToBaseline, makeAncestryBlastRadiusGuard } from "../execution/step-runner.js";
import {
  buildReviewRollbackFailureMessage,
  buildReviewVerdictMessage,
  emitProactiveStatus,
  sanitizeFailureReason,
} from "../project/proactive-status.js";
import { graphActiveContextKey } from "./task-predicates.js";

export type ForeachActiveContextLike = {
  instanceId: string;
  stepIndex: number;
  baselineSha?: string | null;
  checkpointId?: string | null;
  worktreePath?: string | null;
};

export type GraphRethinkResetDeps = {
  rootDir: string;
  store: TaskStore;
  graphStepRunOnce: Map<string, Promise<unknown>>;
  graphRethinkNarrations: Map<string, string | undefined>;
};

export async function applyGraphRethinkReset(
  deps: GraphRethinkResetDeps,
  taskId: string,
  active: ForeachActiveContextLike,
): Promise<void> {
  // Clear the memoized implementation pass so the next `runGraphTaskStep`
  // re-executes (T9): the per-run pass is memoized in `graphStepRunOnce` keyed
  // by task id and is normally only cleared on REJECTION. A RETHINK fires AFTER
  // a SUCCESSFUL pass (a review verdict resets git/step state via this reset),
  // so without clearing the memo the rework re-awaits the already-resolved
  // promise and implementation never re-runs — leaving the instance permanently
  // pending or falsely successful under `deferDoneToReview`. Mirrors the
  // rejection-clear guard: only delete the memo when the stored promise is the
  // SETTLED pass (a fresh in-flight attempt another caller installed is left
  // untouched). At rethink time the pass under review has already resolved, so
  // checking settled-ness avoids clobbering a concurrent re-dispatch.
  const memo = deps.graphStepRunOnce.get(taskId);
  if (memo) {
    let settled = false;
    await Promise.race([memo.then(
      () => { settled = true; },
      () => { settled = true; },
    ), Promise.resolve()]);
    if (settled && deps.graphStepRunOnce.get(taskId) === memo) {
      deps.graphStepRunOnce.delete(taskId);
    }
  }
  // Worktree isolation (KTD-11): reset the instance's OWN branch/worktree only —
  // sibling instances and the integration base are untouched, so the blast-radius
  // guard is STRUCTURAL (skipped) in this mode. Shared isolation resets the task's
  // main worktree and keeps the KTD-2 ancestry guard as written.
  const branchScoped = typeof active.worktreePath === "string" && active.worktreePath.length > 0;
  let worktreePath = active.worktreePath ?? deps.rootDir;
  if (!branchScoped) {
    try {
      worktreePath = (await deps.store.getTask(taskId)).worktree || deps.rootDir;
    } catch {
      // Best-effort worktree resolution; fall back to rootDir.
    }
  }
  const liveSteps = await deps.store.getTask(taskId).then((t) => t.steps).catch(() => []);
  const narrationKey = graphActiveContextKey(taskId, active.instanceId);
  const reviewSummary = deps.graphRethinkNarrations.get(narrationKey);
  try {
    await resetStepToBaseline(
      {
        store: deps.store,
        worktreePath,
        // No single session ref for graph-owned step-sessions — rewind is skipped
        // when checkpointId resolves but no session is current (KTD-2 partial path).
        sessionRef: { current: null },
        reviewType: "code",
        // Branch-scoped RETHINK under worktree isolation makes the guard structural
        // (the reset can only touch the instance's own branch); shared isolation
        // keeps the defensive ancestry guard (KTD-2/KTD-11).
        blastRadiusGuard: branchScoped
          ? undefined
          : makeAncestryBlastRadiusGuard({
              worktreePath,
              task: { id: taskId, steps: liveSteps },
              stepIndex: active.stepIndex,
            }),
      },
      { id: taskId, steps: liveSteps },
      active.stepIndex,
      active.baselineSha ?? undefined,
      active.checkpointId ?? undefined,
    );
    if (reviewSummary !== undefined) {
      const narration = buildReviewVerdictMessage("RETHINK", reviewSummary);
      void emitProactiveStatus(deps.store, taskId, narration, "reviewer", sanitizeFailureReason(reviewSummary));
    }
  } catch (error) {
    const safeReason = sanitizeFailureReason(error);
    void emitProactiveStatus(
      deps.store,
      taskId,
      buildReviewRollbackFailureMessage(safeReason),
      "reviewer",
      safeReason,
    );
    throw error;
  } finally {
    deps.graphRethinkNarrations.delete(narrationKey);
  }
}
