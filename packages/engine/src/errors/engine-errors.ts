/**
 * Structured Engine Error Types — domain-specific error classes for the Fusion engine.
 *
 * These error types replace generic `catch (err)` blocks with typed, classifiable
 * errors that callers can match on for domain-specific handling (retry, fail-fast,
 * alerting, etc.).
 *
 * ## Hierarchy
 *
 * ```
 * EngineError (base)
 * ├── TransientError          — temporary, retryable (network blip, 5xx, timeout)
 * │   ├── NetworkError        — connection refused/reset, DNS failure, socket hang-up
 * │   ├── ServiceUnavailableError — upstream 5xx, overloaded, maintenance mode
 * │   └── TimeoutError        — request/operation exceeded deadline
 * ├── PermanentError         — non-retryable, task-defect or config error
 * │   ├── ConfigurationError  — bad env, missing keys, invalid settings
 * │   └── ValidationError     — schema violations, invalid inputs
 * └── RateLimitError         — quota/rate-limit, needs global pause (not local retry)
 * ```
 *
 * ## Usage
 *
 * ```ts
 * catch (err) {
 *   if (err instanceof TransientError) {
 *     // Move task to todo for retry
 *   } else if (err instanceof RateLimitError) {
 *     // Trigger global usage-limit pause
 *   } else if (err instanceof PermanentError) {
 *     // Mark task as failed
 *   }
 * }
 * ```
 */

import { isUsageLimitError } from "./usage-limit-detector.js";
import { isTransientError } from "./transient-error-detector.js";

// ── Base Error ──────────────────────────────────────────────────────────

/**
 * Base class for all structured engine errors.
 *
 * Adds a `code` (machine-readable string) and optional `cause` chain to the
 * standard Error. Subclasses set `retryable` to indicate whether the operation
 * should be retried by the caller.
 */
export abstract class EngineError extends Error {
  /** Machine-readable error code for programmatic matching. */
  public readonly code: string;
  /** Whether the caller should retry the operation. */
  public readonly retryable: boolean;
  /** Optional structured metadata for logging/metrics. */
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    retryable: boolean,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

// ── Transient Errors (retryable) ────────────────────────────────────────

/**
 * A transient error — the operation failed due to a temporary condition
 * that is expected to resolve on its own (network blip, brief service
 * unavailability, timeout). Callers should retry with backoff.
 */
export class TransientError extends EngineError {
  constructor(
    message: string,
    code: string = "TRANSIENT",
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, code, true, details, cause);
  }
}

/**
 * Network-level error — connection refused, DNS resolution failure,
 * socket hang-up, TLS handshake failure, etc.
 */
export class NetworkError extends TransientError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, "NETWORK", details, cause);
  }
}

/**
 * Upstream service returned a 5xx or is temporarily unavailable
 * (overloaded, maintenance mode).
 */
export class ServiceUnavailableError extends TransientError {
  /** HTTP status code if available. */
  public readonly statusCode?: number;

  constructor(
    message: string,
    statusCode?: number,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, "SERVICE_UNAVAILABLE", { ...details, statusCode }, cause);
    this.statusCode = statusCode;
  }
}

/**
 * Operation or request exceeded its deadline / timeout.
 */
export class TimeoutError extends TransientError {
  /** Configured timeout in milliseconds. */
  public readonly timeoutMs?: number;

  constructor(
    message: string,
    timeoutMs?: number,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, "TIMEOUT", { ...details, timeoutMs }, cause);
    this.timeoutMs = timeoutMs;
  }
}

// ── Permanent Errors (non-retryable) ────────────────────────────────────

/**
 * A permanent error — the operation failed due to a defect in the task,
 * configuration, or input. Retrying will not help.
 */
export class PermanentError extends EngineError {
  constructor(
    message: string,
    code: string = "PERMANENT",
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, code, false, details, cause);
  }
}

/**
 * Configuration error — missing env vars, invalid settings, bad keys.
 */
export class ConfigurationError extends PermanentError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, "CONFIGURATION", details, cause);
  }
}

/**
 * Validation error — schema violations, invalid inputs, malformed data.
 */
export class ValidationError extends PermanentError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, "VALIDATION", details, cause);
  }
}

// ── Rate Limit Error (special — provider-scoped park, not local retry) ──

/**
 * Rate-limit / usage-limit error. Unlike transient errors, these should
 * NOT be retried indefinitely — after bounded backoff they park only the
 * affected provider-routed task via UsageLimitPauser.
 */
export class RateLimitError extends EngineError {
  /** Suggested retry-after in milliseconds (from Retry-After header or heuristic). */
  public readonly retryAfterMs?: number;

  constructor(
    message: string,
    retryAfterMs?: number,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, "RATE_LIMIT", false, { ...details, retryAfterMs }, cause);
    this.retryAfterMs = retryAfterMs;
  }
}

// ── Classification helpers ──────────────────────────────────────────────

/**
 * Classify a raw error into a structured EngineError subtype.
 *
 * This bridges the gap between legacy string-based error classification
 * (transient-error-detector, usage-limit-detector) and the new typed system.
 * New code should throw typed errors directly; this function upgrades
 * untyped errors from external libraries.
 *
 * @param err - The raw thrown value
 * @returns A structured EngineError instance
 */
export function classifyThrownError(err: unknown): EngineError {
  // Already structured — return as-is
  if (err instanceof EngineError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err ?? "");

  // Rate-limit (triggers a provider-scoped task park)
  if (isUsageLimitError(message)) {
    return new RateLimitError(message, undefined, undefined, err instanceof Error ? err : undefined);
  }

  // Network / connection errors
  if (/ECONNREFUSED|connection refused|connection reset|socket hang up|EHOSTUNREACH|ENETUNREACH/i.test(message)) {
    return new NetworkError(message, undefined, err instanceof Error ? err : undefined);
  }

  // Timeout errors
  if (/ETIMEDOUT|timeout.*connection|connection.*timeout|deadline exceeded|timed out after \d+ms/i.test(message)) {
    return new TimeoutError(message, undefined, undefined, err instanceof Error ? err : undefined);
  }

  // 5xx / service unavailable
  if (/upstream connect error|disconnect\/reset before headers|remote connection failure|transport failure/i.test(message)) {
    return new ServiceUnavailableError(message, undefined, undefined, err instanceof Error ? err : undefined);
  }

  if (/"type":"server_error"|"code":"server_error"/i.test(message)) {
    return new ServiceUnavailableError(message, 500, undefined, err instanceof Error ? err : undefined);
  }

  // Generic transient (WebSocket errors, provider aborts, etc.)
  if (isTransientError(message)) {
    return new TransientError(message, "TRANSIENT", undefined, err instanceof Error ? err : undefined);
  }

  // Default: permanent
  return new PermanentError(message, "UNKNOWN", undefined, err instanceof Error ? err : undefined);
}

/**
 * Type guard: is the error retryable (transient)?
 */
export function isRetryableError(err: unknown): err is TransientError {
  if (err instanceof TransientError) return true;
  if (err instanceof EngineError) return err.retryable;
  // Fall back to string-based detection for untyped errors
  const message = err instanceof Error ? err.message : String(err ?? "");
  return isTransientError(message);
}
