/**
 * Retry with Exponential Backoff — general-purpose retry wrapper for
 * transient network and external service failures.
 *
 * This extends the retry pattern established in `rate-limit-retry.ts` to
 * cover ALL transient errors (network blips, 5xx, timeouts, WebSocket drops)
 * — not just rate-limit / usage-limit errors.
 *
 * ## Strategy
 *
 * **Backoff:** `delay = min(baseDelayMs × 2^attempt, maxDelayMs)` with
 * configurable jitter to avoid thundering-herd effects across concurrent agents.
 *
 * **Jitter modes:**
 * - `"full"` (default): `random(0, delay)` — spreads retries uniformly
 * - `"equal"`: `base + random(0, base)` where `base = delay/2` — tighter clustering
 * - `"none"`: no jitter — deterministic (useful for tests)
 *
 * **Retryable check:** Uses the structured error types from `engine-errors.ts`
 * when available, falling back to `transient-error-detector.ts` for untyped errors.
 *
 * **Abort support:** An optional `AbortSignal` cancels pending retries when a
 * task is paused, cancelled, or the engine shuts down.
 *
 * **Non-blocking:** Backoff sleeps yield to the event loop, never blocking the
 * main thread.
 *
 * @example
 * ```ts
 * const result = await withRetry(() => fetchExternalService(url), {
 *   maxRetries: 3,
 *   baseDelayMs: 1000,
 *   maxDelayMs: 30_000,
 *   timeoutMs: 60_000,
 *   onRetry: (attempt, delayMs, err) => {
 *     logger.warn(`Retry ${attempt} after ${delayMs}ms: ${err.message}`);
 *   },
 *   signal: abortController.signal,
 * });
 * ```
 */

import {
  classifyThrownError,
  isRetryableError,
  RateLimitError,
  TimeoutError,
  type EngineError,
} from "./engine-errors.js";
import { isUsageLimitError } from "./usage-limit-detector.js";

// ── Types ───────────────────────────────────────────────────────────────

/** Jitter strategy for backoff delay randomization. */
export type JitterStrategy = "full" | "equal" | "none";

/** Configuration for retry behavior. */
export interface RetryOptions {
  /** Maximum number of retry attempts before re-throwing (default: 3). */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds (default: 1 000 — 1 s). */
  baseDelayMs?: number;
  /** Upper bound on backoff delay in milliseconds (default: 30 000 — 30 s). */
  maxDelayMs?: number;
  /**
   * Per-attempt timeout in milliseconds. When set, each call to `fn()` is
   * wrapped in a deadline. If the deadline fires before `fn()` resolves, a
   * TimeoutError is thrown (which is retryable). Default: undefined (no timeout).
   */
  timeoutMs?: number;
  /**
   * Jitter strategy for randomizing backoff delays (default: "full").
   * - `"full"`: random(0, delay) — best spread, recommended for production
   * - `"equal"`: base ± random(0, base/2) — tighter clustering
   * - `"none"`: no jitter — deterministic, useful for tests
   */
  jitter?: JitterStrategy;
  /**
   * Called before each retry with the attempt number (1-based), the
   * computed delay, and the error that triggered the retry.
   */
  onRetry?: (attempt: number, delayMs: number, error: EngineError) => void;
  /**
   * Abort signal that cancels pending retries and re-throws immediately.
   */
  signal?: AbortSignal;
  /**
   * Custom retryable check. When provided, this function is called instead
   * of the default `isRetryableError` check. Return `true` to retry, `false`
   * to re-throw immediately.
   */
  isRetryable?: (err: unknown) => boolean;
}

/** Result of a successful retry operation, including retry metadata. */
export interface RetryResult<T> {
  /** The successful return value. */
  value: T;
  /** Total number of retries that occurred (0 = succeeded on first attempt). */
  retries: number;
  /** Total elapsed time in milliseconds including all backoff sleeps. */
  elapsedMs: number;
}

// ── Backoff Calculation ─────────────────────────────────────────────────

/**
 * Compute the backoff delay for a given attempt with the chosen jitter strategy.
 *
 * @param attempt - 0-based attempt index
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @param jitter - Jitter strategy
 * @returns Delay in milliseconds (always >= 0)
 */
export function computeBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: JitterStrategy = "full",
): number {
  const rawDelay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);

  switch (jitter) {
    case "full":
      return Math.floor(Math.random() * rawDelay);
    case "equal": {
      const half = rawDelay / 2;
      return Math.floor(half + Math.random() * half);
    }
    case "none":
      return rawDelay;
  }
}

// ── Sleep with Abort ────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds, cancellable via an `AbortSignal`.
 * Yields to the event loop — never blocks the main thread.
 */
export function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

// ── Timeout Wrapper ─────────────────────────────────────────────────────

/**
 * Wrap an async function with a deadline timeout.
 *
 * If `fn()` does not settle within `timeoutMs`, the promise is rejected
 * with a TimeoutError and any underlying resources are cleaned up via
 * the AbortController.
 */
function withTimeout<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  let settled = false;
  return new Promise<T>((resolve, reject) => {
    const ac = new AbortController();

    // Link parent signal — if parent aborts, we abort too
    const onParentAbort = () => {
      if (settled) return;
      settled = true;
      ac.abort(parentSignal?.reason ?? new Error("Aborted"));
      reject(parentSignal?.reason ?? new Error("Aborted"));
    };
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const timeoutErr = new TimeoutError(`Operation timed out after ${timeoutMs}ms`, timeoutMs);
      ac.abort(timeoutErr);
      reject(timeoutErr);
    }, timeoutMs);

    fn(ac.signal)
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onParentAbort);
        resolve(result);
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onParentAbort);
        reject(err);
      });
  });
}

// ── Main Retry Function ─────────────────────────────────────────────────

/**
 * Wrap an async function with exponential backoff retry for transient errors.
 *
 * The wrapper calls `fn()`. If it throws a retryable error (transient network
 * or service errors), it sleeps with exponential backoff and retries up to
 * `maxRetries` times. Non-retryable errors are re-thrown immediately.
 *
 * Rate-limit / usage-limit errors are NEVER retried by this function — they
 * should be handled by `withRateLimitRetry` or a provider-scoped task park.
 *
 * After all retries are exhausted, the original error is thrown.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns The return value of `fn()`
 */
export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    timeoutMs,
    jitter = "full",
    onRetry,
    signal,
    isRetryable: customIsRetryable,
  } = options;

  let lastError: EngineError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check abort before each attempt
    if (signal?.aborted) {
      throw lastError ?? new Error("Aborted before first attempt");
    }

    try {
      // Wrap with timeout if configured
      const result = timeoutMs
        ? await withTimeout(fn, timeoutMs, signal)
        : await fn(signal);
      return result;
    } catch (err: unknown) {
      // Classify the error into a structured type
      const classified = classifyThrownError(err);

      // Rate-limit errors: never retry locally — re-throw immediately
      if (classified instanceof RateLimitError || isUsageLimitError(classified.message)) {
        throw classified;
      }

      // Use custom retryable check if provided, otherwise use default
      const shouldRetry = customIsRetryable
        ? customIsRetryable(err)
        : isRetryableError(classified);

      // Non-retryable error: re-throw immediately
      if (!shouldRetry) {
        throw classified;
      }

      lastError = classified;

      // All retries exhausted — throw the last error
      if (attempt >= maxRetries) {
        throw lastError;
      }

      // Check abort before sleeping
      if (signal?.aborted) {
        throw lastError;
      }

      // Compute backoff delay
      const delay = computeBackoff(attempt, baseDelayMs, maxDelayMs, jitter);

      onRetry?.(attempt + 1, delay, classified);

      // Sleep with cancellation support
      await cancellableSleep(delay, signal);
    }
  }

  // Unreachable, but satisfies TypeScript
  throw lastError ?? new Error("withRetry: unexpected state");
}

/**
 * Wrap an async function with retry and return extended metadata.
 *
 * Same as `withRetry` but returns a `RetryResult<T>` with the value plus
 * retry count and elapsed time — useful for logging and metrics.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns A `RetryResult<T>` with value and retry metadata
 */
export async function withRetryResult<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  const startTime = Date.now();
  let retries = 0;

  const result = await withRetry<T>(async (signal) => {
    return fn(signal);
  }, {
    ...options,
    onRetry: (attempt, delayMs, err) => {
      retries = attempt;
      options.onRetry?.(attempt, delayMs, err);
    },
  });

  return {
    value: result,
    retries,
    elapsedMs: Date.now() - startTime,
  };
}
