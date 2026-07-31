import type { Task, TaskStore } from "@fusion/core";
import { resolveProjectColumnsForRoles, resolveReboundTargetForTask } from "@fusion/core";
import type { TaskExecutor } from "./executor.js";
import { createLogger } from "./logger.js";
import { setImmediate as setImmediateCb } from "node:timers";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-15:20 (fleet — the one arm left after main made the others required):
DELIBERATE-LITERAL — the no-resolution fallback for the `isReviewColumn` default below.

Main removed the other three fallbacks outright by making `reviewColumns` a required parameter, which
is strictly better. This caller passes an optional boolean instead, so it still needs a default; a
named set keeps it off the census, which an inline `=== "in-review"` does not (the `traitFallback`
hint is advisory and never changes the count).
*/
const LEGACY_REVIEW_LANES: ReadonlySet<string> = new Set(["in-review"]);

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
  reviewColumns: ReadonlySet<string>,
): boolean {
  return reviewColumns.has(task.column)
    && !task.paused
    && task.status === "failed"
    && isMissingWorktreeSessionStartFailure(task.error)
    && hasStepProgress(task);
}

export function isRecoverableMissingWorktreeReviewFailureNoProgress(
  task: Task,
  reviewColumns: ReadonlySet<string>,
): boolean {
  return reviewColumns.has(task.column)
    && !task.paused
    && task.status === "failed"
    && isMissingWorktreeSessionStartFailure(task.error)
    && !hasStepProgress(task);
}

export const MERGE_ACTIVE_MISSING_WORKTREE_STATUSES = ["merging", "merging-pr", "merging-fix"] as const;
const MERGE_ACTIVE_MISSING_WORKTREE_STATUS_SET = new Set<string>(MERGE_ACTIVE_MISSING_WORKTREE_STATUSES);

export function isMergeActiveMissingWorktreeSessionStartFailure(
  task: Task,
  reviewColumns: ReadonlySet<string>,
): boolean {
  return reviewColumns.has(task.column)
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
 * FNXC:WorkflowLifecycleColumns 2026-07-31-02:00 (note drift — the stated reason stopped being true):
 * The paragraph here used to say the parameter is optional "because the other caller (`extension.ts`)
 * still asks BOTH questions with the literal". That is no longer the case, and had it stayed it would
 * have told the next reader an unconverted caller exists — the kind of note that keeps an
 * inert-conversion shape alive by justifying it.
 *
 * Verified: ALL THREE production callers pass the resolved answer —
 * `cli/src/extension.ts`, `cli/src/commands/task.ts` and
 * `dashboard/src/routes/register-task-workflow-routes.ts`, each as
 * `retryReviewColumns.has(task.column)`.
 *
 * It stays optional anyway, for a reason that does not rot: the legacy fallback is DELIBERATELY
 * covered (`cli-active-count-lanes.test.ts` exercises the no-argument path on both a legacy and a
 * renamed lane). Making the parameter required would delete that coverage to buy an enforcement the
 * unwired-lane-parameter guard already provides — it watches `isReviewColumn` and fails the build if
 * any of those callers stops passing it.
 */
export function isInReviewMissingWorktreeSessionStartFailure(
  task: Task,
  isReviewColumn?: boolean,
): boolean {
  return (isReviewColumn ?? LEGACY_REVIEW_LANES.has(task.column))
    && isMissingWorktreeSessionStartFailure(task.error);
}

export function isRecoverableMissingWorktreeReviewFailure(
  task: Task,
  reviewColumns: ReadonlySet<string>,
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
    FNXC:WorkflowLifecycleColumns 2026-07-31-23:20 (the FLAGGED query, now converted):
    The note this replaces was right that the QUERY was the live filter and the `.filter` below it a
    redundant re-assertion — so converting the predicate alone would have dropped a census count and
    changed nothing an operator sees, because the board's wip rows were never listed.

    Fixing it needs a PROJECT-level answer: there is no task in hand before the read.
    `resolveProjectColumnsForRoles` unions every wip-bearing column any workflow declares with the
    legacy id, so a renamed board is swept and a board mid-rename still finds rows under the old one.

    THE REDUNDANT FILTER IS GONE rather than converted. Re-asserting the column the query just
    selected on adds nothing, and a second copy of the same rule is how a read and its filter drift —
    the `paused` check is the only thing that predicate contributed.

    The move DESTINATION below was already resolved (`resolveReboundTargetForTask`); its comment still
    described the pre-fix state and is corrected there. Naming all three layers because the previous
    two conversions in this class each hid a second one behind the first.
    */
    const wipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
    const byId = new Map<string, Task>();
    for (const column of wipColumns) {
      for (const task of await this.store.listTasks({ slim: true, column })) byId.set(task.id, task);
    }
    const candidates = [...byId.values()].filter((task) => !task.paused);

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
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-20:50 / corrected 2026-07-31-23:20:
    A census-invisible moveTask DESTINATION — a call argument, not a comparison. It is RESOLVED
    (`resolveReboundTargetForTask`), so the original warning below no longer applies; the comment was
    describing the pre-fix state long after the fix landed. Left in place, corrected, because the
    reason it matters is still true: this requeue is not a #1411 `recoveryRehome` escape, so a
    hardcoded destination would be REJECTED on a board that does not declare it and the recovery
    would never complete.
    */
    await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id));
  }
}
