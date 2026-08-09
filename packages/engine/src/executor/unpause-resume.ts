/**
 * FNXC:CodeOrganization 2026-08-03-21:55:
 * dispatchUnpauseResume peeled from TaskExecutor (U4).
 *
 * FNXC:ExecutorResume 2026-07-14-15:31:
 * A terminal failed in-progress task must not be resurrected by an unrelated task:updated event.
 *
 * FNXC:ExecutorResume 2026-07-21-22:56:
 * Claim resumingUnpaused BEFORE any await so concurrent task:updated handlers cannot both pass the gate.
 *
 * FNXC:ExecutorResume 2026-07-21-23:06:
 * recoverCompletedTask refuses when resumingUnpaused still holds the id; transfer ownership before recovery.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { isTaskWorkComplete } from "./task-predicates.js";

export type UnpauseResumeDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  executing: Set<string>;
  resumingUnpaused: Set<string>;
  recoveringCompleted: Set<string>;
  /** Claim maps — only `.has()` is required; values stay opaque to this module. */
  activeSessions: { has(taskId: string): boolean };
  activeStepExecutors: { has(taskId: string): boolean };
  activeWorkflowStepSessions: { has(taskId: string): boolean };
  graphRouting: Set<string>;
  approvalSuspended: Set<string>;
  getExecutionPauseLabel: () => Promise<string | null>;
  clearResumeFailureState: (task: Task) => Promise<void>;
  recoverApprovedStepsOnResume: (taskId: string) => Promise<void>;
  recoverCompletedTask: (task: Task) => Promise<boolean>;
  execute: (task: Task) => Promise<void>;
};

export async function dispatchUnpauseResume(
  deps: UnpauseResumeDeps,
  task: Task,
): Promise<boolean> {
  if (task.status === "failed") {
    return false;
  }

  if (
    deps.executing.has(task.id)
    || deps.resumingUnpaused.has(task.id)
    || deps.recoveringCompleted.has(task.id)
    || deps.activeSessions.has(task.id)
    || deps.activeStepExecutors.has(task.id)
    || deps.activeWorkflowStepSessions.has(task.id)
    || deps.graphRouting.has(task.id)
  ) {
    return false;
  }

  // Synchronous single-flight claim before any await (TOCTOU fix).
  deps.resumingUnpaused.add(task.id);
  let handoffOwnsClaim = false;
  try {
    const pauseLabel = await deps.getExecutionPauseLabel();
    if (pauseLabel) {
      executorLog.debug(`Skipping unpause resume for ${task.id} — ${pauseLabel} active`);
      return false;
    }

    // Re-check after await: a concurrent graph claim may have won meanwhile.
    if (
      deps.executing.has(task.id)
      || deps.recoveringCompleted.has(task.id)
      || deps.activeSessions.has(task.id)
      || deps.activeStepExecutors.has(task.id)
      || deps.activeWorkflowStepSessions.has(task.id)
      || deps.graphRouting.has(task.id)
    ) {
      return false;
    }

    deps.approvalSuspended.delete(task.id);
    if (isTaskWorkComplete(task) && !task.mergeDetails) {
      deps.resumingUnpaused.delete(task.id);
      deps.recoveringCompleted.add(task.id);
      handoffOwnsClaim = true; // prevent finally from double-deleting a already-cleared claim
      executorLog.log(`${task.id} unpaused with completed work and no session — recovering directly to in-review`);
      void deps.recoverCompletedTask(task)
        .catch((err) => executorLog.error(`Failed to recover completed unpaused task ${task.id}:`, err))
        .finally(() => deps.recoveringCompleted.delete(task.id));
      return true;
    }

    executorLog.log(`Unpaused ${task.id} in-progress with no session — resuming execution`);
    try {
      await deps.clearResumeFailureState(task);
      await deps.store.updateTask(task.id, {
        resumeLimboCount: 0,
        resumeLimboTipSha: null,
        resumeLimboStepSignature: null,
      });
      await deps.store.logEntry(task.id, "Resuming execution after unpause", undefined, deps.getRunContextFor(task.id));
      await deps.recoverApprovedStepsOnResume(task.id);
    } catch (clearErr) {
      executorLog.warn(`${task.id} clearResumeFailureState failed during unpause: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`);
    }
    handoffOwnsClaim = true;
    deps.execute(task)
      .catch((err) => executorLog.error(`Failed to resume unpaused ${task.id}:`, err))
      .finally(() => deps.resumingUnpaused.delete(task.id));
    // execute().finally owns resumingUnpaused release from here.
    return true;
  } finally {
    if (!handoffOwnsClaim) {
      deps.resumingUnpaused.delete(task.id);
    }
  }
}
