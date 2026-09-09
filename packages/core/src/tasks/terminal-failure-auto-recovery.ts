import type { Task } from "../types/task/task-core.js";

/** The generic terminal-failure recovery budget is intentionally smaller than legacy transient recovery. */
export const MAX_TERMINAL_FAILURE_AUTO_RETRIES = 3;
/** A lost apply can be resumed once without spending a second park attempt. */
export const MAX_TERMINAL_FAILURE_AUTO_RESUMES = 1;
/** The claim window detects abandonment; it is not a cross-process lock. */
export const TERMINAL_FAILURE_CLAIM_APPLY_GRACE_MS = 60_000;
/** A budget is eligible for foreign-write staleness cleanup after one week. */
export const TERMINAL_FAILURE_BUDGET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** Avoid sub-millisecond ambiguity between a budget write and store-assigned updatedAt. */
export const BUDGET_WRITE_GUARD_MS = 1_000;

export type TerminalFailureAutoRecoveryDecision =
  | { action: "retry"; attempt: number }
  | { action: "notify"; reason: "budget-exhausted" | "auto-recovery-disabled" }
  | { action: "reset-budget"; reason: "terminal-success" | "deleted-or-historical" | "budget-stale" }
  | { action: "skip"; reason: "not-generic-terminal-failure" | "no-action" | "escalation-already-delivered" | "auto-recovery-disabled-never-withheld" | "recovery-owned" | "paused-or-progressing" };

export interface TerminalFailureAutoRecoveryOptions {
  isGenericTerminalFailure: boolean;
  hasRecoveryOwner: boolean;
  isProgressing: boolean;
  inTerminalSuccessColumn: boolean;
  isDeletedOrHistorical: boolean;
  autoRecoveryEnabled: boolean;
  maxAttempts?: number;
  maxBudgetAgeMs?: number;
  now?: () => number;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/*
FNXC:TaskWedgeNotifications 2026-08-10-20:30:
Soft deletion is the last observable boundary for a task, so every delete entry point must
share this reset shape with the public budget-reset primitive. The helper removes only the
terminal-failure budget, its cooldown, and its active episode; other wedge reasons survive.
*/
export function clearTerminalFailureAutoRecoveryBudget(
  wedge: NonNullable<Task["wedgeNotification"]>,
  now: string,
): NonNullable<Task["wedgeNotification"]> {
  const { autoRecovery: _budget, ...rest } = wedge;
  const lastNotifiedAtByReason = { ...(wedge.lastNotifiedAtByReason ?? {}) };
  delete lastNotifiedAtByReason["terminal-failed"];
  return {
    ...rest,
    budgetRevision: (wedge.budgetRevision ?? 0) + 1,
    ...(Object.keys(lastNotifiedAtByReason).length > 0 ? { lastNotifiedAtByReason } : { lastNotifiedAtByReason: undefined }),
    ...(wedge.status === "active" && wedge.reasonKey === "terminal-failed" ? { status: "resolved" as const, transitionedAt: now } : {}),
  };
}

function isBudgetStale(task: Task, now: number, maxAgeMs: number): boolean {
  const budget = task.wedgeNotification?.autoRecovery;
  if (!budget || nonNegativeInteger(budget.attempts) === 0) return false;
  const episodeAt = Date.parse(budget.escalationNotifiedAt ?? budget.lastAttemptAt ?? "");
  const taskUpdatedAt = Date.parse(task.updatedAt ?? "");
  const budgetWrittenAt = Date.parse(budget.lastBudgetWriteAt ?? "");
  return Number.isFinite(episodeAt)
    && Number.isFinite(taskUpdatedAt)
    && Number.isFinite(budgetWrittenAt)
    && now - episodeAt > maxAgeMs
    && taskUpdatedAt > budgetWrittenAt + BUDGET_WRITE_GUARD_MS;
}

/*
FNXC:TaskWedgeNotifications 2026-08-10-18:54:
The generic terminal-failed park is engine-owned until its durable budget is spent.
This pure classifier cannot duplicate engine error descriptors: callers supply the single
`describeTaskWedge` determination. Reset precedes every failure gate so success, archival,
and proven foreign-write staleness cannot leave a card permanently muted. The grace window is
only an abandonment heuristic; the store apply fence, not a clock comparison, serializes moves.
*/
export function classifyTerminalFailureAutoRecovery(
  task: Task,
  options: TerminalFailureAutoRecoveryOptions,
): TerminalFailureAutoRecoveryDecision {
  const budget = task.wedgeNotification?.autoRecovery;
  const now = options.now?.() ?? Date.now();
  const maxAttempts = options.maxAttempts ?? MAX_TERMINAL_FAILURE_AUTO_RETRIES;

  if (budget) {
    if (options.inTerminalSuccessColumn) return { action: "reset-budget", reason: "terminal-success" };
    if (options.isDeletedOrHistorical) return { action: "reset-budget", reason: "deleted-or-historical" };
    if (isBudgetStale(task, now, options.maxBudgetAgeMs ?? TERMINAL_FAILURE_BUDGET_MAX_AGE_MS)) {
      return { action: "reset-budget", reason: "budget-stale" };
    }
  }

  if (!options.isGenericTerminalFailure) return { action: "skip", reason: "not-generic-terminal-failure" };

  const attempts = nonNegativeInteger(budget?.attempts);
  const owedReason = attempts >= maxAttempts
    ? "budget-exhausted"
    : !options.autoRecoveryEnabled && budget
      ? "auto-recovery-disabled"
      : undefined;
  if (owedReason) {
    if (budget?.escalationNotifiedAt && budget.escalationReason === owedReason) {
      return { action: "skip", reason: "escalation-already-delivered" };
    }
    return { action: "notify", reason: owedReason };
  }
  if (!options.autoRecoveryEnabled) return { action: "skip", reason: "auto-recovery-disabled-never-withheld" };
  if (options.hasRecoveryOwner) return { action: "skip", reason: "recovery-owned" };
  if (task.status !== "failed" || task.paused || task.userPaused || task.autoMerge === false || options.isProgressing) {
    return { action: "skip", reason: "paused-or-progressing" };
  }
  return { action: "retry", attempt: attempts + 1 };
}
