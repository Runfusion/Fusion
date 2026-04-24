/**
 * Rate Limit Retry — wraps async agent work with exponential backoff
 * specifically for rate-limit / usage-limit errors.
 *
 * When an AI model returns a rate limit error (429, overloaded, quota, etc.),
 * this utility retries the operation with exponential backoff before letting
 * the error propagate to the caller's catch block, which triggers a global
 * pause via `UsageLimitPauser`.
 *
 * **Backoff strategy:** `delay = min(baseDelayMs × 2^attempt, maxDelayMs)` with
 * ±10 % jitter to avoid thundering-herd effects across concurrent agents.
 *
 * **Abort support:** An optional `AbortSignal` allows the engine to cancel
 * pending retries when a task is paused, cancelled, or the engine is shutting
 * down — so agents don't sit in a 2-minute sleep unnecessarily.
 *
 * **Scope:** Only rate-limit errors (as classified by `isUsageLimitError`) are
 * retried. All other error types are re-thrown immediately so existing error
 * handling (transient-error retry, failure marking, etc.) is unaffected.
 */

import { isUsageLimitError } from "./usage-limit-detector.js";

export interface RateLimitRetryOptions {
  /** Maximum number of retry attempts before re-throwing (default: 3). */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds (default: 30 000 — 30 s). */
  baseDelayMs?: number;
  /** Upper bound on backoff delay in milliseconds (default: 120 000 — 2 min). */
  maxDelayMs?: number;
  /**
   * Called before each retry with the attempt number (1-based) and the
   * computed delay. Use this to log retry activity to the task and agent logs.
   */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  /**
   * Abort signal that, when triggered, cancels any pending backoff sleep and
   * re-throws the last error immediately. Essential for paused / cancelled tasks.
   */
  signal?: AbortSignal;
}

/**
 * Wrap an async function with rate-limit-aware exponential backoff.
 *
 * The wrapper calls `fn()`. If it throws a rate-limit error (detected via
 * `isUsageLimitError`), it sleeps with exponential backoff and retries up to
 * `maxRetries` times. Non-rate-limit errors are re-thrown immediately.
 *
 * After all retries are exhausted, the **original** error is thrown so the
 * caller's existing catch block can trigger the global pause via
 * `UsageLimitPauser`.
 *
 * @example
 * ```ts
 * await withRateLimitRetry(() => agentWork(), {
 *   onRetry: (attempt, delayMs) =>
 *     store.logEntry(taskId, `Rate limited — retry ${attempt} in ${delayMs}ms`),
 *   signal: abortController.signal,
 * });
 * ```
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: RateLimitRetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 30_000,
    maxDelayMs = 120_000,
    onRetry,
    signal,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Non-rate-limit errors: re-throw immediately — no retry
      if (!isUsageLimitError(error.message)) {
        throw error;
      }

      lastError = error;

      // All retries exhausted — throw so caller can trigger global pause
      if (attempt >= maxRetries) {
        throw lastError;
      }

      // Check abort before sleeping
      if (signal?.aborted) {
        throw lastError;
      }

      // Exponential backoff with ±10 % jitter
      const rawDelay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = rawDelay * 0.1 * (2 * Math.random() - 1); // ±10 %
      const delay = Math.max(0, Math.round(rawDelay + jitter));

      onRetry?.(attempt + 1, delay, error);

      await sleep(delay, signal);
    }
  }

  // Unreachable, but satisfies TypeScript
  throw lastError ?? new Error("withRateLimitRetry: unexpected state");
}

/**
 * Sleep for `ms` milliseconds, cancellable via an `AbortSignal`.
 * @internal exported for testing only
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    const timer = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Clean up listener when timer fires normally
      const origResolve = resolve;
      resolve = () => {
        signal.removeEventListener("abort", onAbort);
        origResolve();
      };
    }
  });
}
