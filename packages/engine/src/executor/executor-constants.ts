/**
 * FNXC:CodeOrganization 2026-08-04-02:05:
 * Module-level TaskExecutor tuning constants peeled from executor.ts preamble (U4).
 * Facades and free peels import from here so the class file is not a constants host.
 *
 * FNXC:SessionContention 2026-07-25-21:30:
 * The contention ladder is deliberately long and slow compared with the provider-failure budget (2 fast
 * retries): a lease is held for as long as the holder's own work takes — minutes, not milliseconds. Ten
 * attempts backing off 5s→60s covers ~8 minutes of waiting, after which the task is left queued for
 * ordinary re-dispatch rather than parked. (Backoff values live on the session-contention peel; this
 * file keeps the sibling watchdog/retry ceilings that share the same "slow recovery" posture.)
 */

/** Maximum retry attempts for workflow step hard failures before giving up */
export const MAX_WORKFLOW_STEP_RETRIES = 3;

/** How long to wait before recovering a completed task still stuck in in-progress. */
export const COMPLETED_TASK_WATCHDOG_MS = 60_000;

/** How long to wait before retrying a workflow rerun handoff that never reached in-progress. */
export const WORKFLOW_RERUN_WATCHDOG_MS = 15_000;

export const MAX_WORKTREE_RETRIES = 3;
export const WORKTREE_RETRY_DELAYS = [100, 500, 1000] as const; // ms
export const MAX_AUTO_RECOVERY_ATTEMPTS = 3;
export const BRANCH_CONFLICT_TRIPWIRE_THRESHOLD = 5;
