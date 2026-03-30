/**
 * Transient Error Detector — classifies network/infrastructure errors as transient
 * (temporary and retryable) versus permanent failures.
 *
 * Transient errors indicate temporary conditions like network blips, proxy hiccups,
 * connection resets, or temporary service unavailability. These errors typically
 * resolve on their own after a short delay and should NOT mark tasks as failed.
 *
 * When a transient error is detected, the task should be moved back to "todo"
 * for later retry rather than being marked as "failed". This prevents tasks from
 * being incorrectly marked as failed due to temporary infrastructure issues.
 *
 * Contrast with:
 * - Usage limit errors: Systemic conditions (rate limits, quota) → trigger global pause
 * - Permanent errors: Code issues, test failures, logic errors → mark task as failed
 */

import { isUsageLimitError } from "./usage-limit-detector.js";

/**
 * Patterns that indicate transient network/infrastructure errors.
 * These are checked case-insensitively against error messages.
 *
 * These patterns cover:
 * - Proxy/gateway connection errors (upstream connect, disconnect/reset)
 * - Connection refusal/reset (ECONNREFUSED, connection reset)
 * - Timeouts (ETIMEDOUT, timeout in connection context)
 * - Socket errors (socket hang up)
 * - Transport layer failures
 */
export const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  // Proxy/gateway errors - indicate temporary routing issues
  /upstream connect error/i,
  /disconnect\/reset before headers/i,
  /retried and the latest reset reason/i,
  /remote connection failure/i,
  /transport failure reason/i,
  /delayed connect error/i,

  // Connection establishment failures - usually temporary
  /Connection refused/i,
  /connection reset/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /socket hang up/i,

  // Timeout patterns (only when related to connections, not general timeouts)
  /timeout.*connection/i,
  /connection.*timeout/i,
];

/**
 * Check if an error message indicates a transient network/infrastructure error.
 *
 * Transient errors are temporary conditions that typically resolve after a delay:
 * - Network blips and temporary routing issues
 * - Proxy/gateway hiccups (upstream connect errors)
 * - Connection resets during establishment
 * - Temporary service unavailability (connection refused)
 * - Socket timeouts during connection
 *
 * Returns `true` for transient errors — these should trigger a retry by moving
 * the task back to "todo" rather than marking as "failed".
 *
 * Returns `false` for permanent failures (code errors, test failures) or
 * usage limit errors (rate limits that need global pause).
 *
 * @param errorMessage - The error message to classify
 * @returns true if the error appears transient and retryable
 */
export function isTransientError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Comprehensive error classification that distinguishes between:
 * - 'usage-limit': Rate limits, quota exceeded, billing issues → triggers global pause
 * - 'transient': Network blips, connection errors → move task to "todo" for retry
 * - 'permanent': Code errors, test failures, logic errors → mark task as failed
 *
 * This function delegates to existing usage limit detection first (to preserve
 * existing behavior), then checks for transient patterns, defaulting to
 * 'permanent' for all other errors.
 *
 * @param errorMessage - The error message to classify
 * @returns The error classification category
 */
export function classifyError(errorMessage: string): "transient" | "usage-limit" | "permanent" {
  if (!errorMessage || typeof errorMessage !== "string") {
    return "permanent";
  }

  // Check usage limits first (highest priority - triggers global pause)
  if (isUsageLimitError(errorMessage)) {
    return "usage-limit";
  }

  // Check transient patterns next (move to todo for retry)
  if (isTransientError(errorMessage)) {
    return "transient";
  }

  // Default to permanent (mark as failed)
  return "permanent";
}
