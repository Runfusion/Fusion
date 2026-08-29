/**
 * FNXC:CodeOrganization 2026-08-09-22:10:
 * Plan Review CLOSE_NO_OP terminalization peels (FN-8841 / U4).
 *
 * FNXC:PlanReviewNoOp 2026-08-09-01:55:
 * Invalid, unroutable, or failed Plan Review closes are explicit waits, not graph failures.
 * Keep one held continuation at plan-review so scheduler resume preserves the audited close
 * evidence without changing the task's column or manufacturing a task error.
 */
import type { Task, TaskDetail, TaskRecommendation, TaskStore, WorkflowWorkItem } from "@fusion/core";
import { resolveWipTargetForTask } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveReboundColumnFor, resolveTerminalColumnsFor } from "./lifecycle-columns.js";
import { dispatchAcceptedCompletionRecommendationNotice } from "./completion-recommendation-notice.js";

export type FinalizeAcceptedNoOpCompletionDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  scheduleCompletedTaskWatchdog: (taskId: string, source: string) => void;
};

export type FinalizeAcceptedNoOpCompletionParams = {
  task: TaskDetail;
  marker: { kind: string; reason: string; canonicalId?: string };
  summary: string;
  recommendations?: TaskRecommendation[];
  onDone?: () => void;
  rejectIfPaused?: boolean;
};

/**
 * FNXC:PlanReviewNoOp 2026-08-09-02:28:
 * A reviewer close must lose to a concurrent user pause, deletion, or terminal handoff.
 * Re-read immediately before each lifecycle boundary and never clear pause fields on this
 * path when rejectIfPaused is set, so accepting a close cannot resurrect operator-withdrawn work.
 */
export async function finalizeAcceptedNoOpCompletion(
  deps: FinalizeAcceptedNoOpCompletionDeps,
  params: FinalizeAcceptedNoOpCompletionParams,
): Promise<{ completed: boolean; hardPauseActive: boolean }> {
  const { task, marker, summary, recommendations, onDone, rejectIfPaused = false } = params;
  const isRejectedCloseState = async (): Promise<boolean> => {
    const current = await deps.store.getTask(task.id);
    return !current
      || Boolean(current.deletedAt)
      || (await resolveTerminalColumnsFor(deps.store, task.id)).includes(current.column)
      || (rejectIfPaused && (current.paused === true || current.userPaused === true));
  };
  const live = await deps.store.getTask(task.id);
  if (!live || live.deletedAt || (await resolveTerminalColumnsFor(deps.store, task.id)).includes(live.column)) {
    return { completed: false, hardPauseActive: false };
  }
  if (rejectIfPaused && (live.paused || live.userPaused)) return { completed: false, hardPauseActive: false };

  const runContext = deps.getRunContextFor(task.id);
  const restoreNoCommitsExpected = async (): Promise<void> => {
    if (live.noCommitsExpected !== true) {
      await deps.store.updateTask(task.id, { noCommitsExpected: false }).catch(() => undefined);
    }
  };
  try {
    if (await isRejectedCloseState()) return { completed: false, hardPauseActive: false };
    await deps.store.updateTask(task.id, { noCommitsExpected: true });
    await deps.store.logEntry(
      task.id,
      `Verified ${marker.kind} completion sentinel accepted; no commits expected for terminal handoff`,
      JSON.stringify({
        kind: marker.kind,
        reason: marker.reason,
        canonicalId: marker.canonicalId,
        summary,
        runId: runContext?.runId,
        agentId: runContext?.agentId,
      }),
      runContext,
    );
    const recordActivity = (deps.store as typeof deps.store & {
      recordActivity?: (entry: {
        type: "task:updated";
        taskId: string;
        taskTitle?: string;
        details: string;
        metadata?: Record<string, unknown>;
      }) => Promise<unknown>;
    }).recordActivity;
    if (recordActivity) {
      await recordActivity.call(deps.store, {
        type: "task:updated",
        taskId: task.id,
        taskTitle: live.title,
        details: `Task marked as verified ${marker.kind}; no commits expected`,
        metadata: {
          taskId: task.id,
          kind: marker.kind,
          reason: marker.reason,
          canonicalId: marker.canonicalId,
          summary,
          runId: runContext?.runId,
          agentId: runContext?.agentId,
        },
      }).catch((error: unknown) => {
        executorLog.warn(`${task.id}: failed to record no-op completion activity: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    onDone?.();
    for (let index = 0; index < live.steps.length; index += 1) {
      if (live.steps[index]?.status !== "done" && live.steps[index]?.status !== "skipped") {
        if (await isRejectedCloseState()) {
          await restoreNoCommitsExpected();
          return { completed: false, hardPauseActive: false };
        }
        await deps.store.updateStep(task.id, index, "done");
      }
    }
    if (await isRejectedCloseState()) {
      await restoreNoCommitsExpected();
      return { completed: false, hardPauseActive: false };
    }
    const currentTask = await deps.store.getTask(task.id);
    const existingSummary = currentTask.summary?.trim();
    const hasRunWorkflowSteps = (currentTask.workflowStepResults?.length ?? 0) > 0;
    const rerunSuffix = `---\nRerun after workflow step revision:\n${summary}`;
    if (existingSummary && hasRunWorkflowSteps && !existingSummary.endsWith(rerunSuffix)) {
      await deps.store.updateTask(task.id, { summary: `${currentTask.summary}\n\n${rerunSuffix}` });
      await deps.store.logEntry(task.id, "fn_task_done summary appended to existing summary (workflow-step rerun)", undefined, runContext);
    } else if (!existingSummary || !hasRunWorkflowSteps) {
      await deps.store.updateTask(task.id, { summary });
    }
    if (recommendations !== undefined) {
      await deps.store.updateTask(task.id, { recommendations });
    }
    const settings = await deps.store.getSettings();
    const hardPauseActive = Boolean(settings.globalPause);
    if (await isRejectedCloseState()) {
      await restoreNoCommitsExpected();
      return { completed: false, hardPauseActive: false };
    }
    await deps.store.updateTask(task.id, {
      ...(rejectIfPaused ? {} : { paused: false, pausedByAgentId: null }),
      status: null,
      bulkCompletionRefusalAt: null,
    }, runContext);
    await deps.store.logEntry(task.id, "Task marked done by agent", undefined, runContext);
    const refreshed = await deps.store.getTask(task.id);
    if (
      !refreshed
      || refreshed.deletedAt
      || (await resolveTerminalColumnsFor(deps.store, task.id)).includes(refreshed.column)
      || (rejectIfPaused && (refreshed.paused || refreshed.userPaused))
    ) {
      await restoreNoCommitsExpected();
      return { completed: false, hardPauseActive: false };
    }
    let latestColumn = refreshed.column;
    if (latestColumn === await resolveReboundColumnFor(deps.store, task.id)) {
      const wipTarget = await resolveWipTargetForTask(deps.store, task.id);
      await deps.store.moveTask(task.id, wipTarget);
      latestColumn = wipTarget;
    }
    const beforeWatchdog = await deps.store.getTask(task.id);
    if (
      latestColumn === await resolveWipTargetForTask(deps.store, task.id)
      && !hardPauseActive
      && beforeWatchdog
      && !beforeWatchdog.deletedAt
      && !(rejectIfPaused && (beforeWatchdog.paused || beforeWatchdog.userPaused))
    ) {
      deps.scheduleCompletedTaskWatchdog(task.id, "fn_task_done");
    }
    // FNXC:TaskRecommendations 2026-08-13-03:56: every rollback guard is above; this accepted boundary dispatches without delaying completion.
    if (recommendations !== undefined) {
      dispatchAcceptedCompletionRecommendationNotice({
        store: deps.store,
        taskId: task.id,
        taskTitle: task.title,
        recommendations,
        settings,
        log: executorLog,
      });
    }
    return { completed: true, hardPauseActive };
  } catch (error) {
    /*
     * FNXC:PlanReviewNoOp 2026-08-09-02:24:
     * `noCommitsExpected` is a completion-only exemption. A failed handoff returns to
     * Plan Review, so restore its prior value rather than allowing a later approval to
     * execute implementation without the normal no-commit invariant.
     */
    await restoreNoCommitsExpected();
    await deps.store.logEntry(
      task.id,
      `Plan Review CLOSE_NO_OP terminalization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { completed: false, hardPauseActive: false };
  }
}

export async function completePlanReviewNoOp(
  deps: FinalizeAcceptedNoOpCompletionDeps,
  task: TaskDetail,
  marker: { kind: string; reason: string; canonicalId?: string },
): Promise<boolean> {
  const summaryPrefix = marker.kind === "premise-stale" ? "PREMISE STALE" : marker.kind.toUpperCase();
  const completion = await finalizeAcceptedNoOpCompletion(deps, {
    task,
    marker,
    summary: `${summaryPrefix}: ${marker.reason}`,
    rejectIfPaused: true,
  });
  return completion.completed;
}

export type HoldPlanReviewNoOpContinuationDeps = {
  store: TaskStore;
};

/**
 * FNXC:PlanReviewNoOp 2026-08-09-02:37:
 * A user pause wins terminal completion, but it must not discard the reviewer-close
 * continuation that makes the paused card resumable. Replace the active continuation
 * atomically even after observing a pause; holding it never clears pause fields or
 * schedules execution, while omitting it strands durable failed close evidence.
 */
export async function holdPlanReviewNoOpContinuation(
  deps: HoldPlanReviewNoOpContinuationDeps,
  task: Task,
  suspension: {
    reason: "invalid" | "terminal-route-unavailable" | "terminalization-failed";
    nodeId: string;
    fromColumn: string;
    toColumn: string;
    irHash: string;
  },
  continuation: WorkflowWorkItem | undefined,
  resolvedRunId: string | undefined,
): Promise<WorkflowWorkItem | undefined> {
  const live = await deps.store.getTask(task.id).catch(() => undefined);
  if (!live || live.deletedAt || (await resolveTerminalColumnsFor(deps.store, task.id)).includes(live.column)) {
    return continuation;
  }
  const blockedReason = `plan-review-close-${suspension.reason}`;
  if (typeof deps.store.replaceActiveTaskWorkflowContinuation === "function") {
    return await deps.store.replaceActiveTaskWorkflowContinuation({
      runId: continuation?.runId ?? `${resolvedRunId ?? `${task.id}:workflow`}:plan-review-close:${suspension.reason}`,
      taskId: task.id,
      nodeId: suspension.nodeId,
      kind: "task",
      state: "held",
      stableWorkflowRunId: continuation?.stableWorkflowRunId ?? resolvedRunId ?? `${task.id}:workflow`,
      waitReason: "planning",
      blockedReason,
      lastError: blockedReason,
      sourceColumn: suspension.fromColumn,
      targetColumn: suspension.toColumn,
      irHash: suspension.irHash,
    });
  }
  if (continuation && typeof deps.store.transitionWorkflowWorkItem === "function") {
    return await deps.store.transitionWorkflowWorkItem(continuation.id, "held", {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: blockedReason,
      blockedReason,
    }).catch(() => continuation);
  }
  return continuation;
}
