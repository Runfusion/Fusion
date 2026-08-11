/**
 * FNXC:CodeOrganization 2026-08-03-16:05:
 * recoverMissingWorktreeSessionStartFailure peeled from TaskExecutor (U4 Slice B).
 *
 * FNXC:MissingWorktreeRecovery 2026-07-16-18:35:
 * Returns the recovery outcome (not a bare boolean) so the FN-7996 graph-failure router can
 * distinguish "requeued for clean retry" (handled — stop failure processing) from
 * "escalate-exhausted" (fall through to the visible terminal park for human inspection).
 * Existing session-start callers treat any truthy outcome as handled, unchanged.
 */
import { resolve as resolvePath } from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import {
  classifyMissingWorktreeSessionStartFailure,
  extractMissingWorktreePathFromSessionStartFailure,
  isMissingWorktreeSessionStartFailure,
} from "../healing/restart-recovery-coordinator.js";
import {
  isInsideWorktreesDir,
  removeWorktree,
  RemovalReason,
} from "../worktree/worktree-pool.js";
import {
  autoRecoverWorktreeSessionStartFailure,
  MAX_WORKTREE_SESSION_RETRIES,
} from "../self-healing.js";
import { executorLog, formatError } from "../logger.js";
import type { EngineRunContext, RunAuditor } from "../util/run-audit.js";
import {
  isTransientMissingTaskJsonError,
  TRANSIENT_WORKTREE_TASK_JSON_ENOENT_PATTERN,
} from "./requeue-loop.js";

export type MissingSessionRecoveryDeps = {
  rootDir: string;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  hasActiveWorktreeBinding: (taskId: string, worktreePath: string) => boolean;
  markGraphExecuteSelfRequeued: (taskId: string) => void;
};

export async function recoverMissingWorktreeSessionStartFailure(
  deps: MissingSessionRecoveryDeps,
  task: Task,
  worktreePath: string,
  error: unknown,
  audit: RunAuditor,
): Promise<false | "requeue-todo" | "escalate-exhausted"> {
  const errorText = error instanceof Error ? error.message : String(error);
  const missingWorktreeFailure = isMissingWorktreeSessionStartFailure(errorText);
  const missingTaskJsonFailure = isTransientMissingTaskJsonError(error, task);
  if (!missingWorktreeFailure && !missingTaskJsonFailure) return false;

  const classification = classifyMissingWorktreeSessionStartFailure(errorText);
  const missingTaskJsonPath = errorText.match(TRANSIENT_WORKTREE_TASK_JSON_ENOENT_PATTERN)?.[1] ?? null;
  const staleWorktreePath = extractMissingWorktreePathFromSessionStartFailure(errorText)
    ?? (missingTaskJsonPath ? resolvePath(missingTaskJsonPath, "..", "..", "..") : null)
    ?? worktreePath;

  if (missingTaskJsonFailure) {
    executorLog.log(`[transient-task-json-suppressed] taskId=${task.id} elapsedMs=0 reason=missing-task-json-under-worktree path=${missingTaskJsonPath ?? "unknown"}`);
  }

  await audit.git({
    type: "worktree:incomplete-detected",
    target: staleWorktreePath,
    metadata: { classification, reason: errorText, source: "session-start", taskId: task.id },
  });

  if (isInsideWorktreesDir(deps.rootDir, staleWorktreePath)) {
    try {
      await removeWorktree({
        rootDir: deps.rootDir,
        worktreePath: staleWorktreePath,
        settings: await deps.store.getSettings(),
        reason: RemovalReason.PoolPrune,
        taskId: task.id,
        audit,
        expectedOwnerTaskId: task.id,
        liveOwnerProbe: (path, ownerTaskId) => deps.hasActiveWorktreeBinding(ownerTaskId, path),
      });
    } catch (removeErr) {
      executorLog.warn(`${task.id}: failed to remove unusable session-start worktree ${staleWorktreePath}: ${formatError(removeErr)}`);
    }
  }

  const recovery = await autoRecoverWorktreeSessionStartFailure(deps.store, task, {
    failure: error,
    source: "executor-session-start",
    auditor: audit,
    rootDir: deps.rootDir,
  });
  if (recovery.outcome !== "escalate-exhausted") {
    deps.markGraphExecuteSelfRequeued(task.id);
  }

  await audit.git({
    type: "worktree:auto-recovered",
    target: staleWorktreePath,
    metadata: {
      classification: recovery.classification,
      action: recovery.outcome === "escalate-exhausted" ? "escalate-exhausted" : "requeue-todo",
      retries: recovery.retries,
      maxRetries: MAX_WORKTREE_SESSION_RETRIES,
      staleWorktree: staleWorktreePath,
      taskId: task.id,
    },
  });

  if (recovery.outcome === "escalate-exhausted") {
    await deps.store.logEntry(
      task.id,
      `Worktree session-start auto-recovery exhausted (${recovery.retries}/${MAX_WORKTREE_SESSION_RETRIES}); task left for human inspection`,
      undefined,
      deps.getRunContextFor(task.id),
    );
  } else {
    await deps.store.logEntry(
      task.id,
      `Worktree was ${classification} at session start; requeued to todo for clean retry (attempt ${recovery.retries}/${MAX_WORKTREE_SESSION_RETRIES})`,
      undefined,
      deps.getRunContextFor(task.id),
    );
  }
  return recovery.outcome === "escalate-exhausted" ? "escalate-exhausted" : "requeue-todo";
}
