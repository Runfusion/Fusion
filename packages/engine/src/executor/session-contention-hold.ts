/**
 * FNXC:CodeOrganization 2026-08-03-19:40:
 * holdForSessionContention peeled from TaskExecutor (U4).
 * Bounded in-place retry while another task holds a shared session path.
 *
 * FNXC:WorkspaceContention 2026-08-23-06:40 (FN-179):
 * Acquisition contention can survive an engine restart because its authority is a durable lease.
 * Persist the owner-local retry budget and an operator-visible wait reason, but never park a
 * contention wait as failed; a shared budget across unrelated failed-park owners remains out of scope.
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
  runContextFor: (taskId: string) => EngineRunContext | undefined;
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
  const priorAttempts = live.sessionContentionHoldCount ?? 0;
  const attempt = priorAttempts + 1;
  const reason = (detail ?? "another task to release a shared session path").slice(0, 200);

  if (attempt > MAX_SESSION_CONTENTION_HOLD_RETRIES) {
    const message = `Still waiting on another task to release a shared session path after ${MAX_SESSION_CONTENTION_HOLD_RETRIES} attempts — leaving the task queued for normal re-dispatch (not a failure)${detail ? `: ${detail}` : ""}`;
    executorLog.warn(`${task.id}: ${message}`);
    await deps.store.logEntry(task.id, message, undefined, deps.runContextFor(task.id));
    // FNXC:WorkspaceContention 2026-08-23-07:30: Exhaustion releases the visible wait so ordinary
    // scheduling can retry after the holder settles, but it must not erase the durable budget.
    // Only explicit lifecycle reset owners (manual retry, clean completion, and done cleanup) may
    // start a new contention episode; otherwise scheduler rediscovery recreates the incident loop.
    await deps.store.updateTask(task.id, { status: null, error: null, sessionContentionWaitReason: null }, deps.runContextFor(task.id));
    return;
  }

  const message = `Waiting on another task to release a shared session path — retrying in place (${attempt}/${MAX_SESSION_CONTENTION_HOLD_RETRIES})${detail ? `: ${detail}` : ""}`;
  executorLog.warn(`${task.id}: ${message}`);
  await deps.store.logEntry(task.id, message, undefined, deps.runContextFor(task.id));
  // A contention hold is a scheduling wait, not a failure. Its token makes the owner visible.
  await deps.store.updateTask(task.id, {
    status: "contention-hold", error: null, sessionContentionHoldCount: attempt,
    sessionContentionWaitReason: reason,
  }, deps.runContextFor(task.id));

  const delayMs = SESSION_CONTENTION_HOLD_BACKOFF_MS === 0
    ? 0
    : Math.min(SESSION_CONTENTION_HOLD_MAX_BACKOFF_MS, SESSION_CONTENTION_HOLD_BACKOFF_MS * 2 ** (attempt - 1));
  const scheduleRetry = () => {
    void (async () => {
      try {
        const resume = await deps.store.getTask(task.id);
        if (!resume || resume.deletedAt || resume.paused || resume.userPaused) {
          if (resume) await deps.store.updateTask(task.id, { status: null, sessionContentionWaitReason: null }, deps.runContextFor(task.id));
          return;
        }
        /*
        FNXC:WorkspaceContention 2026-08-23-06:51 (FN-179):
        Yielding a scheduling hold clears only its visible owner token. Retain the
        durable count so a repeated live-holder refusal consumes the bounded budget
        instead of restarting at attempt one after every scheduled re-execution.
        */
        await deps.store.updateTask(task.id, { status: null, sessionContentionWaitReason: null }, deps.runContextFor(task.id));
        await deps.reexecute(resume);
      } catch (err) {
        executorLog.error(`Failed session-contention retry for ${task.id}:`, err);
      }
    })();
  };
  setTimeout(scheduleRetry, delayMs).unref?.();
}
