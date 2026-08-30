/**
 * FNXC:CodeOrganization 2026-08-03-21:45:
 * performWorkflowRerunBounce peeled from TaskExecutor (U4).
 * Move in-progress/in-review → rebound → wip for remediation with re-entry and pause guards.
 *
 * FNXC:WorkflowOptionalStepFix 2026-06-27-13:30:
 * A pre-merge optional step REVISE schedules this bounce via sendTaskBackForFix AFTER reopening
 * the last plan step to pending. in-review must bounce like in-progress to avoid deadlock.
 */
import type { TaskStore } from "@fusion/core";
import { hasPendingRemediationWork, resolveWipTargetForTask } from "@fusion/core";
import { executorLog } from "../logger.js";
import { moveTaskWithLifecycleReason } from "../execution/lifecycle-move.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";

export type WorkflowRerunBounceDeps = {
  store: TaskStore;
  workflowRerunPending: Set<string>;
  getExecutionPauseLabel: () => Promise<string | null>;
  resolveResumeLanes: (taskId: string) => Promise<{ wip: string; review: string }>;
  clearTerminalStepFailuresForRetry: (taskId: string, mode: "archive" | "clear") => Promise<void>;
};

export async function performWorkflowRerunBounce(
  deps: WorkflowRerunBounceDeps,
  taskId: string,
  worktreePath: string,
  preserveResumeState: boolean = true,
  /*
  FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
  When false, do not persist the remediation path as task.worktree (external checkouts).
  */
  persistWorktreePath: boolean = true,
): Promise<"bounced" | "skipped-pending" | "deferred-paused" | "deferred-capacity" | "refused-no-remediation"> {
  const pauseLabel = await deps.getExecutionPauseLabel();
  if (pauseLabel) {
    executorLog.log(`${taskId}: workflow rerun deferred — ${pauseLabel} active`);
    return "deferred-paused";
  }

  // Re-entry guard: if a previous bounce for the same task is still
  // mid-flight (e.g., the watchdog fired before the original sequence
  // completed), skip rather than racing two concurrent moveTask sequences.
  if (deps.workflowRerunPending.has(taskId)) {
    executorLog.warn(`${taskId}: workflow rerun bounce already in flight — skipping re-entry`);
    return "skipped-pending";
  }
  deps.workflowRerunPending.add(taskId);
  try {
    // moveTask(in-progress → todo) clears `task.worktree`; restore it before
    // the return trip so the dashboard never renders the task under
    // "Unassigned" and self-healing can't reclaim the worktree as idle.
    const latestTask = await deps.store.getTask(taskId);
    if (!latestTask) {
      throw new Error("task missing during workflow rerun bounce");
    }
    if (latestTask.paused) {
      executorLog.log(`${taskId}: workflow rerun deferred — task is paused`);
      return "deferred-paused";
    }
    /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): both lanes from ONE snapshot — the comment
       above says in-review must bounce EXACTLY like in-progress, so resolving them separately is how the
       bounce ends up handling one lane and throwing on the other, which is the bug that comment is about. */
    const bounceLanes = await deps.resolveResumeLanes(taskId);
    /*
    FNXC:LifecycleContainment 2026-08-28-07:48:
    A review-to-WIP bounce is a REVISE handoff and therefore must carry concrete pending remediation
    work. Without a remediation marker the executor has nothing to do, so bouncing would replay the
    same review over an unchanged tree. Refuse that empty bounce in place.
    */
    if (latestTask.column === bounceLanes.review && !hasPendingRemediationWork(latestTask)) {
      await deps.store.logEntry(
        taskId,
        "Workflow rerun refused — no pending remediation work",
        "A review revision may return to implementation only with a named pending remediation step.",
      );
      return "refused-no-remediation";
    }
    if (latestTask.column === bounceLanes.wip || latestTask.column === bounceLanes.review) {
      const originalExecutionStartedAt = latestTask.executionStartedAt;
      /*
      FNXC:LifecycleContainment 2026-08-28-02:24:
      FN-207 removes the old review → Planning → WIP rerun hop. Review remediation moves directly
      to WIP, while remediation already in WIP stays there; both preserve the checkout and progress.
      A full WIP lane defers the card in review for the watchdog retry instead of retargeting Planning.
      */
      if (latestTask.column === bounceLanes.review) {
        const moveResult = await moveTaskWithLifecycleReason(
          deps.store,
          taskId,
          bounceLanes.wip,
          "code-review-revise-remediation",
          {
            ...(preserveResumeState ? { preserveResumeState: true } : {}),
            preserveWorktree: true,
            workflowMoveSource: "workflow-remediation",
          },
        );
        if (!moveResult.moved) return "deferred-capacity";
      }
      await deps.store.updateTask(taskId, {
        ...(persistWorktreePath ? { worktree: worktreePath } : {}),
        executionStartedAt: originalExecutionStartedAt ?? null,
      });
      const pauseLabelAfterMove = await deps.getExecutionPauseLabel();
      if (pauseLabelAfterMove) {
        executorLog.log(`${taskId}: workflow rerun contained in ${bounceLanes.wip} — ${pauseLabelAfterMove} became active during bounce`);
        return "deferred-paused";
      }
      await deps.clearTerminalStepFailuresForRetry(taskId, "archive");
      return "bounced";
    }

    if (latestTask.column === await resolveReboundColumnFor(deps.store, taskId)) {
      if (persistWorktreePath) await deps.store.updateTask(taskId, { worktree: worktreePath });
      const pauseLabelBeforeResume = await deps.getExecutionPauseLabel();
      if (pauseLabelBeforeResume) {
        executorLog.log(`${taskId}: workflow rerun parked in todo — ${pauseLabelBeforeResume} became active before resume`);
        return "deferred-paused";
      }
      // Already in `todo` (non-mergeable) — archive prior gate failures for the next reviewer.
      await deps.clearTerminalStepFailuresForRetry(taskId, "archive");
      /* FNXC:WorkflowResolvedColumns 2026-07-30-21:40: census-invisible moveTask DESTINATION — a call argument, not a comparison. The SOURCE guard four lines up already resolves via resolveReboundColumnFor; leaving the destination literal is a split brain inside one function. */
      await deps.store.moveTask(taskId, await resolveWipTargetForTask(deps.store, taskId));
      return "bounced";
    }

    throw new Error(`task is in '${latestTask.column}', cannot bounce to in-progress`);
  } finally {
    deps.workflowRerunPending.delete(taskId);
  }
}
