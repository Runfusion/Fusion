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
 * **Scope:** Rate-limit errors (as classified by `isUsageLimitError`) are
 * retried with the backoff curve above. Transient authentication errors (as
 * classified by `isTransientAuthError` — e.g. an OAuth access token rotating
 * mid-run) get their own small retry budget with a short flat delay. All other
 * error types are re-thrown immediately so existing error handling
 * (transient-error retry, failure marking, etc.) is unaffected.
 */

import { isUsageLimitError } from "./usage-limit-detector.js";
import { isTransientAuthCredentialError } from "./transient-error-detector.js";

/*
FNXC:EngineAuthRetry 2026-07-05-06:07:
A long-running agent session holds its OAuth access token in memory. Claude Max access tokens rotate mid-run (~8 h lifetime); the in-flight call fails with a 401 authentication_error even though the credentials file has already been refreshed, and the very next call succeeds. Retry these a few times so a token-boundary rotation does not surface as a spurious task-failure alert. This budget is separate from the rate-limit retry budget and must not consume rate-limit attempts.

FNXC:EngineAuthRetry 2026-07-12-20:10:
The transient-auth classifier moved to transient-error-detector.ts (isTransientAuthCredentialError) so the same rotation-vs-operator-actionable decision drives this in-run retry AND durable-agent heartbeat error recovery / self-healing (FN-7835/FN-7844/FN-7859). Scope-grant failures and invalid/missing API keys are excluded there — the operator must act, so they surface immediately instead of retrying.
*/

function isTransientAuthError(message: string | undefined): boolean {
  return isTransientAuthCredentialError(message ?? "");
}

/** Transient-auth retry budget — separate from the rate-limit `maxRetries`. */
const AUTH_MAX_RETRIES = 2;
/**
 * Flat delay before a transient-auth retry. A credential refresh completes
 * within seconds, so the rate-limit backoff curve (30 s → 2 min) would just
 * prolong the outage.
 */
const AUTH_RETRY_DELAY_MS = 5_000;

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
 * `maxRetries` times. If it throws a transient authentication error (detected
 * via `isTransientAuthError`), it retries up to `AUTH_MAX_RETRIES` times after
 * a short flat delay — this budget is separate and does not consume rate-limit
 * attempts. All other errors are re-thrown immediately.
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
  let authRetries = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const authError = isTransientAuthError(error.message);

      // Non-retryable errors: re-throw immediately — no retry
      if (!isUsageLimitError(error.message) && !authError) {
        throw error;
      }

      lastError = error;

      /*
      FNXC:EngineAuthRetry 2026-07-05-06:07:
      Transient-auth retries use a separate, smaller budget (AUTH_MAX_RETRIES) at a flat ~5s delay, and decrement `attempt` so they never burn a rate-limit attempt. Credential rotation completes in seconds, so the rate-limit backoff curve (30s -> 2min) would only prolong the outage. An already-aborted signal short-circuits to throw the original auth error without sleeping, matching the rate-limit path.
      */
      if (authError) {
        if (authRetries >= AUTH_MAX_RETRIES || signal?.aborted) {
          throw lastError;
        }
        authRetries++;
        // Don't consume a rate-limit attempt for an auth retry
        attempt--;

        const jitter = AUTH_RETRY_DELAY_MS * 0.1 * (2 * Math.random() - 1); // ±10 %
        const delay = Math.max(0, Math.round(AUTH_RETRY_DELAY_MS + jitter));

        onRetry?.(authRetries, delay, error);

        await sleep(delay, signal);
        continue;
      }

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
