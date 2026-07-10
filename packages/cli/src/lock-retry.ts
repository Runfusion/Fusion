/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * `fn task show`/`fn task move` (FN-7731, upstream #1976) open a `TaskStore`
 * and call `getTask`/`moveTask` exactly once. If the engine or another agent
 * holds a SQLite writer lock on `.fusion/fusion.db` at that instant, the
 * call surfaces a raw `database is locked` error (or appears to hang until
 * the DB layer's own bounded `busy_timeout`/lock-recovery window in
 * packages/core/src/db.ts — DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5s plus a short
 * lock-recovery retry — finally gives up). That DB-level bound already
 * prevents an unbounded hang at the SQLite layer, but it does not retry
 * across separate `better-sqlite3`/node:sqlite statement calls, so a single
 * unlucky read/write at the CLI surface still fails outright even though
 * the lock typically clears within a second or two of normal engine
 * activity.
 *
 * This module adds a CLI-level retry ABOVE that bound: it retries a thunk
 * only when the error is classified as a SQLite lock error (reusing
 * `@fusion/core`'s `isSqliteLockError`, the same classifier the DB layer's
 * own `runWithLockRecovery` uses, so CLI and DB lock detection never drift),
 * with exponential backoff capped by a total wall-clock deadline. Non-lock
 * errors (not-found, invalid column, etc.) propagate immediately — they are
 * never retried. On deadline exhaustion the command fails fast with a
 * clear, actionable, non-zero-exit error naming the task id and operation
 * instead of hanging indefinitely. The default deadline is intentionally
 * generous (long enough to ride out a typical engine write) while still
 * bounded, and is operator-overridable via `FUSION_CLI_LOCK_RETRY_MS` for
 * constrained/CI environments.
 *
 * Do NOT widen `@fusion/core`'s DB-level busy_timeout/lock-recovery window
 * to "fix" this — that bound is intentionally tight so a single genuinely
 * stuck writer does not block the whole process; this retry belongs at the
 * CLI surface, above the DB-level bound, not inside it.
 */
import { isSqliteLockError } from "@fusion/core";

/** Default total wall-clock deadline (ms) for the lock-retry loop. */
export const DEFAULT_CLI_LOCK_RETRY_MS = 15_000;

const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 2_000;

/** Raised when a retried operation exhausts the bounded lock-retry deadline. */
export class LockRetryExhaustedError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "LockRetryExhaustedError";
    this.cause = cause;
  }
}

/**
 * Read the operator-overridable total retry deadline from
 * `FUSION_CLI_LOCK_RETRY_MS`, falling back to `DEFAULT_CLI_LOCK_RETRY_MS`
 * for an unset/invalid value.
 */
export function getCliLockRetryDeadlineMs(): number {
  const raw = process.env.FUSION_CLI_LOCK_RETRY_MS;
  if (!raw) return DEFAULT_CLI_LOCK_RETRY_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CLI_LOCK_RETRY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface RetryOnLockContext {
  /** Task id the operation targets, used only for the error message. */
  id: string;
  /** Human-readable action name (e.g. "read task", "move task"), used only for the error message. */
  action: string;
}

/**
 * Run `operation`, retrying with bounded exponential backoff ONLY when the
 * thrown error is a SQLite lock error (`isSqliteLockError`). Any other
 * error (not-found, invalid column, etc.) propagates on the first attempt
 * without retrying. On deadline exhaustion, throws `LockRetryExhaustedError`
 * naming `context.id`/`context.action` with actionable guidance.
 */
export async function retryOnLock<T>(
  operation: () => Promise<T>,
  context: RetryOnLockContext,
  totalMs: number = getCliLockRetryDeadlineMs(),
): Promise<T> {
  const deadline = Date.now() + totalMs;
  let backoff = INITIAL_BACKOFF_MS;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteLockError(error)) {
        throw error;
      }

      const now = Date.now();
      if (now >= deadline) {
        throw new LockRetryExhaustedError(
          `Timed out after ${totalMs}ms waiting to ${context.action} for ${context.id}: ` +
            `the board database stayed locked (the engine or another agent is writing). ` +
            `Retry the command, or raise the bound via FUSION_CLI_LOCK_RETRY_MS.`,
          error,
        );
      }

      const remaining = deadline - now;
      const wait = Math.min(backoff, remaining, MAX_BACKOFF_MS);
      await sleep(wait);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}
