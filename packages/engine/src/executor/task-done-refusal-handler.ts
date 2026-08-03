/**
 * FNXC:CodeOrganization 2026-08-03-18:15:
 * handleImplicitTaskDoneRefusal peeled from TaskExecutor (U4).
 * Requeues or fails after an implicit fn_task_done bulk-completion refusal.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { evaluateTaskDoneRefusal } from "./task-done-refusal.js";
import { skipBypassTaintUpdateForRefusal } from "./completion-predicates.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";

/** Maximum todo requeues after exhausting in-session fn_task_done retries. */
export const MAX_TASK_DONE_REQUEUE_RETRIES = 3;

export type TaskDoneRefusalHandlerDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  markGraphExecuteSelfRequeued: (taskId: string) => void;
  persistTokenUsage: (taskId: string) => Promise<void>;
  deleteActiveSession: (taskId: string) => void;
  clearTokenUsageBaseline: (taskId: string) => void;
};

export async function handleImplicitTaskDoneRefusal(
  deps: TaskDoneRefusalHandlerDeps,
  task: Task,
  refusal: Extract<ReturnType<typeof evaluateTaskDoneRefusal>, { ok: false }>,
): Promise<void> {
  await deps.store.logEntry(task.id, refusal.message, undefined, deps.getRunContextFor(task.id));
  executorLog.error(`${task.id}: fn_task_done refused (${refusal.refusalClass}) — ${refusal.reason} (implicit completion)`);

  const taintUpdate = skipBypassTaintUpdateForRefusal(refusal);
  const priorRequeues = task.taskDoneRetryCount ?? 0;
  const nextRequeueCount = priorRequeues + 1;
  if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
    await deps.store.updateTask(task.id, {
      status: "queued",
      error: null,
      taskDoneRetryCount: nextRequeueCount,
      ...taintUpdate,
      paused: false,
      pausedByAgentId: null,
      worktree: null,
      branch: null,
      sessionFile: null,
    });
    await deps.store.logEntry(
      task.id,
      `${refusal.message} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
      undefined,
      deps.getRunContextFor(task.id),
    );
    deps.markGraphExecuteSelfRequeued(task.id);
    await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveProgress: true });
  } else {
    await deps.store.updateTask(task.id, {
      status: "failed",
      error: refusal.message,
      ...taintUpdate,
      paused: false,
      pausedByAgentId: null,
      worktree: null,
      branch: null,
      sessionFile: null,
    });
    await deps.store.logEntry(task.id, `${refusal.message} — execution failed because implicit fn_task_done was refused`, undefined, deps.getRunContextFor(task.id));
    await deps.persistTokenUsage(task.id);
  }

  deps.deleteActiveSession(task.id);
  deps.clearTokenUsageBaseline(task.id);
}
