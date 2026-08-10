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
import { resolveWipTargetForTask } from "@fusion/core";
import { executorLog } from "../logger.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";

export type WorkflowRerunBounceDeps = {
  store: TaskStore;
  workflowRerunPending: Set<string>;
  getExecutionPauseLabel: () => Promise<string | null>;
  resolveResumeLanes: (taskId: string) => Promise<{ wip: string; review: string }>;
  clearTerminalStepFailuresForRetry: (taskId: string) => Promise<void>;
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
): Promise<"bounced" | "skipped-pending" | "deferred-paused"> {
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
    if (latestTask.column === bounceLanes.wip || latestTask.column === bounceLanes.review) {
      const originalExecutionStartedAt = latestTask.executionStartedAt;
      // Preserve step progress across the in-progress/in-review → todo hop:
      // moveTask's default reopen-to-todo path resets every step to
      // pending and rewrites PROMPT.md checkboxes, which would discard
      // the partial progress this bounce is supposed to retry on top of.
      // `preserveWorktree` keeps the same checkout assigned across the
      // hop so listeners never observe an interim `worktree=null` state
      // — this bounce immediately re-promotes the task on the same
      // directory, so releasing it would publish a misleading snapshot
      // and could let self-healing reclaim the worktree as idle.
      if (preserveResumeState) {
        await deps.store.moveTask(taskId, await resolveReboundColumnFor(deps.store, taskId), {
          preserveResumeState: true,
          preserveWorktree: true,
        });
      } else {
        await deps.store.moveTask(taskId, await resolveReboundColumnFor(deps.store, taskId), { preserveWorktree: true });
      }
      // Restore worktree + executionStartedAt unconditionally to match
      // the original bounce contract: even with preserveWorktree the
      // worktree pointer could have been cleared by an in-flight
      // updateTask, and executionStartedAt is reset by moveTask when
      // preserveResumeState is false. Keep the writes so callers and
      // tests can observe the restoration deterministically.
      await deps.store.updateTask(taskId, {
        ...(persistWorktreePath ? { worktree: worktreePath } : {}),
        executionStartedAt: originalExecutionStartedAt ?? null,
      });
      const pauseLabelAfterTodo = await deps.getExecutionPauseLabel();
      if (pauseLabelAfterTodo) {
        executorLog.log(`${taskId}: workflow rerun parked in todo — ${pauseLabelAfterTodo} became active during bounce`);
        return "deferred-paused";
      }
      // Now in `todo` (non-mergeable) — safe to clear prior gate failures.
      await deps.clearTerminalStepFailuresForRetry(taskId);
      /* FNXC:WorkflowResolvedColumns 2026-07-30-21:40: census-invisible moveTask DESTINATION — a call argument, not a comparison. The SOURCE guard four lines up already resolves via resolveReboundColumnFor; leaving the destination literal is a split brain inside one function. */
      await deps.store.moveTask(taskId, await resolveWipTargetForTask(deps.store, taskId));
      return "bounced";
    }

    if (latestTask.column === await resolveReboundColumnFor(deps.store, taskId)) {
      if (persistWorktreePath) await deps.store.updateTask(taskId, { worktree: worktreePath });
      const pauseLabelBeforeResume = await deps.getExecutionPauseLabel();
      if (pauseLabelBeforeResume) {
        executorLog.log(`${taskId}: workflow rerun parked in todo — ${pauseLabelBeforeResume} became active before resume`);
        return "deferred-paused";
      }
      // Already in `todo` (non-mergeable) — safe to clear prior gate failures.
      await deps.clearTerminalStepFailuresForRetry(taskId);
      /* FNXC:WorkflowResolvedColumns 2026-07-30-21:40: census-invisible moveTask DESTINATION — a call argument, not a comparison. The SOURCE guard four lines up already resolves via resolveReboundColumnFor; leaving the destination literal is a split brain inside one function. */
      await deps.store.moveTask(taskId, await resolveWipTargetForTask(deps.store, taskId));
      return "bounced";
    }

    throw new Error(`task is in '${latestTask.column}', cannot bounce to in-progress`);
  } finally {
    deps.workflowRerunPending.delete(taskId);
  }
}
