import type { Task, TaskStore } from "@fusion/core";
import type { TaskExecutor } from "../executor.js";
import { createLogger } from "../logger.js";
import { setImmediate as setImmediateCb } from "node:timers";

const log = createLogger("restart-recovery");
const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediateCb(resolve));

export function hasStepProgress(task: Task): boolean {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  return steps.some((step) => step.status === "done" || step.status === "in-progress" || step.status === "skipped");
}

function isNoTaskDoneFailure(task: Task): boolean {
  return task.status === "failed"
    && typeof task.error === "string"
    && task.error.toLowerCase().includes("without calling fn_task_done");
}

/**
 * Keep this list in sync with assertValidWorktreeSession() error strings in pi.ts:
 * - Refusing to start coding agent in missing worktree:
 * - Refusing to start coding agent in incomplete worktree:
 * - Refusing to start coding agent in unregistered git worktree:
 */
export const MISSING_WORKTREE_SESSION_PREFIXES = [
  "Refusing to start coding agent in missing worktree:",
  "Refusing to start coding agent in incomplete worktree:",
  "Refusing to start coding agent in unregistered git worktree:",
] as const;

function findMissingWorktreeSessionPrefix(error: string): string | null {
  for (const prefix of MISSING_WORKTREE_SESSION_PREFIXES) {
    if (error.includes(prefix)) {
      return prefix;
    }
  }
  return null;
}

export function isMissingWorktreeSessionStartFailure(error: unknown): boolean {
  if (typeof error !== "string") {
    return false;
  }
  return findMissingWorktreeSessionPrefix(error) !== null;
}

export function classifyMissingWorktreeSessionStartFailure(error: unknown): "missing" | "incomplete" | "unregistered" | "unknown" {
  const text = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "";
  if (text.startsWith(MISSING_WORKTREE_SESSION_PREFIXES[0])) return "missing";
  if (text.startsWith(MISSING_WORKTREE_SESSION_PREFIXES[1])) return "incomplete";
  if (text.startsWith(MISSING_WORKTREE_SESSION_PREFIXES[2])) return "unregistered";
  return "unknown";
}

export function extractMissingWorktreePathFromSessionStartFailure(error: unknown): string | null {
  if (typeof error !== "string") return null;
  const prefix = findMissingWorktreeSessionPrefix(error);
  if (!prefix) return null;
  const idx = error.indexOf(prefix);
  const pathPart = error.slice(idx + prefix.length).trim();
  return pathPart.length > 0 ? pathPart : null;
}

export function isRecoverableMissingWorktreeReviewFailureWithProgress(task: Task): boolean {
  return task.column === "in-review"
    && !task.paused
    && task.status === "failed"
    && isMissingWorktreeSessionStartFailure(task.error)
    && hasStepProgress(task);
}

export function isRecoverableMissingWorktreeReviewFailureNoProgress(task: Task): boolean {
  return task.column === "in-review"
    && !task.paused
    && task.status === "failed"
    && isMissingWorktreeSessionStartFailure(task.error)
    && !hasStepProgress(task);
}

export const MERGE_ACTIVE_MISSING_WORKTREE_STATUSES = ["merging", "merging-pr", "merging-fix"] as const;
const MERGE_ACTIVE_MISSING_WORKTREE_STATUS_SET = new Set<string>(MERGE_ACTIVE_MISSING_WORKTREE_STATUSES);

export function isMergeActiveMissingWorktreeSessionStartFailure(task: Task): boolean {
  return task.column === "in-review"
    && !task.paused
    && typeof task.status === "string"
    && MERGE_ACTIVE_MISSING_WORKTREE_STATUS_SET.has(task.status)
    && isMissingWorktreeSessionStartFailure(task.error);
}

export function isInReviewMissingWorktreeSessionStartFailure(task: Task): boolean {
  return task.column === "in-review"
    && isMissingWorktreeSessionStartFailure(task.error);
}

export function isRecoverableMissingWorktreeReviewFailure(task: Task): boolean {
  return isRecoverableMissingWorktreeReviewFailureWithProgress(task)
    || isRecoverableMissingWorktreeReviewFailureNoProgress(task)
    || isMergeActiveMissingWorktreeSessionStartFailure(task);
}

export class RestartRecoveryCoordinator {
  constructor(
    private readonly store: TaskStore,
    private readonly executor: TaskExecutor,
  ) {}

  async recoverInterruptedRuns(): Promise<void> {
    const allInProgress = await this.store.listTasks({ slim: true, column: "in-progress" });
    const candidates = allInProgress.filter((task) => task.column === "in-progress" && !task.paused);

    if (candidates.length === 0) return;

    let requeued = 0;
    for (const task of candidates) {
      if (!this.mustSafeRetry(task)) continue;
      await this.safeRequeue(task);
      requeued++;
      await yieldEventLoop();
    }

    if (requeued > 0) {
      log.log(`Restart recovery requeued ${requeued} interrupted task(s) for safe retry`);
    }

    await this.executor.resumeOrphaned();
  }

  private mustSafeRetry(task: Task): boolean {
    return isNoTaskDoneFailure(task) && !hasStepProgress(task);
  }

  private async safeRequeue(task: Task): Promise<void> {
    await this.store.updateTask(task.id, {
      status: "stuck-killed",
      worktree: null,
      branch: null,
      sessionFile: null,
      error: null,
    });
    await this.store.logEntry(
      task.id,
      "Restart recovery: interrupted run had no step progress and no fn_task_done — requeued to todo for safe retry",
    );
    await this.store.moveTask(task.id, "todo");
  }
}
