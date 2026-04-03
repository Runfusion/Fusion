/**
 * Recovery Policy — bounded exponential-backoff retry for recoverable executor/triage failures.
 *
 * This module provides a **pure decision function** that computes whether a transient
 * failure should be retried, and if so, what the updated recovery state should be.
 *
 * **Design boundary:**
 * - `recovery-policy.ts` handles **inter-poll** recoverable retries — tasks moved back
 *   to todo/triage with backoff, gated by `nextRecoveryAt` in the scheduler/triage poller.
 * - `withRateLimitRetry()` in `rate-limit-retry.ts` handles **intra-session** rate-limit
 *   retries — immediate retry within the same agent session with exponential backoff.
 * - `transient-error-detector.ts` provides the low-level error classifier (`isTransientError`,
 *   `classifyError`). This module consumes those classifiers but does not replace them.
 *
 * **Retry semantics:**
 * - Up to `MAX_RECOVERY_RETRIES` attempts with exponential backoff.
 * - Base delay: 60 seconds, multiplied by 2^attempt, capped at 300 seconds.
 * - ±10% jitter to avoid thundering-herd effects.
 * - Recovery metadata (`recoveryRetryCount`, `nextRecoveryAt`) is persisted on the task
 *   so retries survive engine restarts.
 * - Exhausted retry budgets escalate to a real failure (task marked failed or error set).
 *
 * **Not retried via this policy:**
 * - Usage-limit errors (handled by `UsageLimitPauser` with global pause)
 * - User pauses (handled by pause flow)
 * - Stuck-task-detector kills (handled by stuck flow)
 * - Dependency-abort cleanups (handled by dep-abort flow)
 * - Merge-conflict retries (handled by `mergeRetries` separately)
 */

// ── Constants ────────────────────────────────────────────────────────

/** Maximum number of recovery retry attempts before escalating to failure. */
export const MAX_RECOVERY_RETRIES = 3;

/** Base delay in milliseconds for the first retry (60 seconds). */
export const BASE_DELAY_MS = 60_000;

/** Maximum delay cap in milliseconds (300 seconds = 5 minutes). */
export const MAX_DELAY_MS = 300_000;

/** Backoff multiplier (2x exponential). */
export const BACKOFF_MULTIPLIER = 2;

// ── Types ────────────────────────────────────────────────────────────

export interface RecoveryState {
  recoveryRetryCount?: number;
  nextRecoveryAt?: string;
}

export interface RecoveryDecision {
  /** Whether the task should be retried (moved back to todo/triage). */
  shouldRetry: boolean;
  /** Whether the retry budget is exhausted (terminal failure). */
  exhausted: boolean;
  /** Updated recovery state to persist on the task. */
  nextState: RecoveryState;
  /** Computed delay in milliseconds (for logging). Zero when exhausted. */
  delayMs: number;
}

// ── Decision function ────────────────────────────────────────────────

/**
 * Compute whether a recoverable failure should be retried and what the
 * updated recovery state should be.
 *
 * This is a **pure function** — it does not call TaskStore or perform I/O.
 * The caller is responsible for persisting `nextState` via `store.updateTask()`.
 *
 * @param currentState - Current recovery metadata from the task
 * @returns A decision describing whether to retry or escalate
 */
export function computeRecoveryDecision(
  currentState: RecoveryState,
): RecoveryDecision {
  const currentCount = currentState.recoveryRetryCount ?? 0;
  const nextCount = currentCount + 1;

  if (nextCount > MAX_RECOVERY_RETRIES) {
    // Budget exhausted — escalate to real failure
    return {
      shouldRetry: false,
      exhausted: true,
      nextState: { recoveryRetryCount: undefined, nextRecoveryAt: undefined },
      delayMs: 0,
    };
  }

  // Exponential backoff: base × 2^(attempt-1), capped at max
  const rawDelay = Math.min(
    BASE_DELAY_MS * BACKOFF_MULTIPLIER ** (nextCount - 1),
    MAX_DELAY_MS,
  );

  // ±10% jitter to avoid thundering herd
  const jitter = rawDelay * 0.1 * (2 * Math.random() - 1);
  const delayMs = Math.max(0, Math.round(rawDelay + jitter));

  const nextRecoveryAt = new Date(Date.now() + delayMs).toISOString();

  return {
    shouldRetry: true,
    exhausted: false,
    nextState: {
      recoveryRetryCount: nextCount,
      nextRecoveryAt,
    },
    delayMs,
  };
}

/**
 * Format a retry delay for human-readable logging.
 *
 * @param delayMs - Delay in milliseconds
 * @returns Human-readable string like "60s" or "120s"
 */
export function formatDelay(delayMs: number): string {
  const seconds = Math.round(delayMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${seconds}s`;
}
