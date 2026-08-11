/**
 * FNXC:CodeOrganization 2026-08-03-19:40:
 * holdForSessionContention peeled from TaskExecutor (U4).
 * Bounded in-place retry while another task holds a shared session path.
 *
 * FNXC:SessionContention 2026-07-25-21:30 (self-recovering wait — the task is never parked):
 * Retry the graph in place on an exponential backoff while the holder finishes. The counter is
 * IN-MEMORY on purpose: it needs no schema change, and an engine restart resetting it is the desired
 * behavior (a restart also drops the in-process registry, so the contention is gone anyway).
 * When the ladder is exhausted the task is left cleanly dispatchable — status/error cleared, progress
 * untouched — so ordinary scheduling picks it up later with a fresh budget. There is no terminal branch
 * here by design: lease contention always ends (the holder finishes, or self-healing sweeps it), so
 * parking the task would only require a human to press Retry on a condition that fixed itself.
 */
import type { Task, TaskDetail, TaskStore } from "@fusion/core";
import { isSessionContentionError } from "../errors/transient-error-detector.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { graphFailureErrorTexts } from "./graph-failure-pure.js";

export const MAX_SESSION_CONTENTION_HOLD_RETRIES = 10;
export const SESSION_CONTENTION_HOLD_BACKOFF_MS = process.env.VITEST || process.env.NODE_ENV === "test" ? 0 : 5_000;
export const SESSION_CONTENTION_HOLD_MAX_BACKOFF_MS = 60_000;

export type SessionContentionHoldDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  getHoldAttempts: (taskId: string) => number;
  setHoldAttempts: (taskId: string, attempt: number) => void;
  clearHold: (taskId: string) => void;
  reexecute: (task: Task) => Promise<void>;
};

export type WorkflowGraphTaskRunResultLike = {
  // minimal shape for graphFailureErrorTexts
  [key: string]: unknown;
};

export async function holdForSessionContention(
  deps: SessionContentionHoldDeps,
  task: Task,
  live: TaskDetail,
  result: Parameters<typeof graphFailureErrorTexts>[0],
): Promise<void> {
  const detail = graphFailureErrorTexts(result).find((text) => isSessionContentionError(text));
  const priorAttempts = deps.getHoldAttempts(task.id);
  const attempt = priorAttempts + 1;

  if (attempt > MAX_SESSION_CONTENTION_HOLD_RETRIES) {
    deps.clearHold(task.id);
    const message = `Still waiting on another task to release a shared session path after ${MAX_SESSION_CONTENTION_HOLD_RETRIES} attempts — leaving the task queued for normal re-dispatch (not a failure)${detail ? `: ${detail}` : ""}`;
    executorLog.warn(`${task.id}: ${message}`);
    await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
    if (live.status != null || live.error != null) {
      await deps.store.updateTask(task.id, { status: null, error: null }, deps.getRunContextFor(task.id));
    }
    return;
  }

  deps.setHoldAttempts(task.id, attempt);
  const message = `Waiting on another task to release a shared session path — retrying in place (${attempt}/${MAX_SESSION_CONTENTION_HOLD_RETRIES})${detail ? `: ${detail}` : ""}`;
  executorLog.warn(`${task.id}: ${message}`);
  await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
  // A contention hold is not a failure state: clear any stale park so the row never shows as failed
  // while it is simply waiting its turn.
  if (live.status != null || live.error != null) {
    await deps.store.updateTask(task.id, { status: null, error: null }, deps.getRunContextFor(task.id));
  }

  const delayMs = SESSION_CONTENTION_HOLD_BACKOFF_MS === 0
    ? 0
    : Math.min(SESSION_CONTENTION_HOLD_MAX_BACKOFF_MS, SESSION_CONTENTION_HOLD_BACKOFF_MS * 2 ** (attempt - 1));
  const scheduleRetry = () => {
    void (async () => {
      try {
        const resume = await deps.store.getTask(task.id);
        if (!resume || resume.deletedAt || resume.paused || resume.userPaused) {
          deps.clearHold(task.id);
          return;
        }
        await deps.reexecute(resume);
      } catch (err) {
        executorLog.error(`Failed session-contention retry for ${task.id}:`, err);
      }
    })();
  };
  setTimeout(scheduleRetry, delayMs).unref?.();
}
