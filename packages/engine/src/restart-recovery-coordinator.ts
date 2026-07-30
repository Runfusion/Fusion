import type { Task, TaskStore } from "@fusion/core";
import { resolveReboundTargetForTask } from "@fusion/core";
import type { TaskExecutor } from "./executor.js";
import { createLogger } from "./logger.js";
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

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-18:20 (fleet: the missing-worktree recovery classifiers):
THE REVIEW LANE ARRIVES FROM THE CALLER, matching the contract added to
`isInReviewMissingWorktreeSessionStartFailure` in #2728 — this module is pure and synchronous by design
(the classifiers are combined in chains) and every caller either holds a store or already resolved the lane.

These three decide whether a review row stranded by an unusable-worktree session start is RECOVERABLE. As
literals they answered NO on every renamed board, so the recovery never ran and the row stayed parked failed
for a human — the exact operator-action park these paths were written to avoid.

Optional, defaulting to the legacy id, so no existing caller or test changes behaviour.
*/
export function isRecoverableMissingWorktreeReviewFailureWithProgress(
  task: Task,
  reviewColumns?: ReadonlySet<string>,
): boolean {
  return (reviewColumns ? reviewColumns.has(task.column) : task.column === "in-review")
    && !task.paused
    && task.status === "failed"
    && isMissingWorktreeSessionStartFailure(task.error)
    && hasStepProgress(task);
}

export function isRecoverableMissingWorktreeReviewFailureNoProgress(
  task: Task,
  reviewColumns?: ReadonlySet<string>,
): boolean {
  return (reviewColumns ? reviewColumns.has(task.column) : task.column === "in-review")
    && !task.paused
    && task.status === "failed"
    && isMissingWorktreeSessionStartFailure(task.error)
    && !hasStepProgress(task);
}

export const MERGE_ACTIVE_MISSING_WORKTREE_STATUSES = ["merging", "merging-pr", "merging-fix"] as const;
const MERGE_ACTIVE_MISSING_WORKTREE_STATUS_SET = new Set<string>(MERGE_ACTIVE_MISSING_WORKTREE_STATUSES);

export function isMergeActiveMissingWorktreeSessionStartFailure(
  task: Task,
  reviewColumns?: ReadonlySet<string>,
): boolean {
  return (reviewColumns ? reviewColumns.has(task.column) : task.column === "in-review")
    && !task.paused
    && typeof task.status === "string"
    && MERGE_ACTIVE_MISSING_WORKTREE_STATUS_SET.has(task.status)
    && isMissingWorktreeSessionStartFailure(task.error);
}

/**
 * FNXC:WorkflowLifecycleColumns 2026-07-31-01:15 (PR #2736 review — greptile P1):
 * `isReviewColumn` is an optional RESOLVED answer; omitted, it is exactly today's behaviour.
 *
 * This predicate selects the SPECIALIZED retry that clears `worktree`/`branch`/`sessionFile`. Its
 * caller in `commands/task.ts` resolves the review lane from the task's workflow, so on a renamed
 * board the two classifiers disagreed: the generic in-review retry fired while this one did not, and
 * the generic branch leaves the stale session metadata in place — so the next execution hit the very
 * same missing-worktree failure. A retry that reports success and changes nothing.
 *
 * Optional rather than required because the other caller (`extension.ts`) still asks BOTH questions
 * with the literal. It is internally consistent that way, so a default preserves its meaning exactly
 * while the converted caller passes the resolved answer.
 */
export function isInReviewMissingWorktreeSessionStartFailure(
  task: Task,
  isReviewColumn?: boolean,
): boolean {
  return (isReviewColumn ?? task.column === "in-review")
    && isMissingWorktreeSessionStartFailure(task.error);
}

export function isRecoverableMissingWorktreeReviewFailure(
  task: Task,
  reviewColumns?: ReadonlySet<string>,
): boolean {
  /* The combiner threads the set to all three, so a caller cannot convert the outer question and leave one
     of the three inner ones on the legacy id — the half-conversion shape this program keeps finding. */
  return isRecoverableMissingWorktreeReviewFailureWithProgress(task, reviewColumns)
    || isRecoverableMissingWorktreeReviewFailureNoProgress(task, reviewColumns)
    || isMergeActiveMissingWorktreeSessionStartFailure(task, reviewColumns);
}

export class RestartRecoveryCoordinator {
  constructor(
    private readonly store: TaskStore,
    private readonly executor: TaskExecutor,
  ) {}

  async recoverInterruptedRuns(): Promise<void> {
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-02-18:30 (fleet — FLAGGED as the QUERY class, not converted):
    The live filter here is the `listTasks({ column: "in-progress" })` QUERY, not the `.filter` below it: the
    query has already restricted the rows, so the predicate is a redundant re-assertion of the same literal.
    Converting the filter alone would drop the census count by one and change nothing an operator sees — the
    board's wip-lane rows still would not be listed, because the QUERY never asked for them.

    Query filters are the class the census tracks separately, and fixing them needs a project-level lane
    resolution before the read (there is no task to resolve from yet). Same shape as `executor.ts`'s
    in-progress sweep and `server.ts`'s reliability counts, both flagged in earlier fleet PRs.
    */
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
    /* FNXC:WorkflowResolvedColumns 2026-07-30-20:50: census-invisible moveTask DESTINATION — a call argument, not a comparison. This requeue is not a #1411 `recoveryRehome` escape, so on a board that does not declare `todo` the move is REJECTED and the recovery it belongs to never completes. */
    await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id));
  }
}
