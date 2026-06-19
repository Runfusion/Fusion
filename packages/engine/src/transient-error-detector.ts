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
 * - AI provider abort errors (request was aborted — temporary streaming/API cancellations)
 * - OpenAI/Codex infrastructure errors surfaced as structured `server_error` payloads
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

  // AI provider abort errors — temporary request cancellations (e.g., Anthropic streaming aborts)
  // These occur when the provider's infrastructure drops an in-flight request.
  /request was aborted/i,
  // DOMException-style AbortError ("This operation was aborted"), emitted by fetch/
  // AbortController when a provider drops an in-flight operation. Excludes user-
  // initiated cancellations like "operation was aborted by user" — those are not transient.
  /operation was aborted(?!\s+by\b)/i,

  // OpenAI/Codex structured infrastructure failures. These arrive as JSON-ish payloads
  // like {"type":"error","error":{"type":"server_error","code":"server_error",...}}
  // and are temporary service-side failures rather than task-specific defects.
  /"type":"server_error"/i,
  /"code":"server_error"/i,
  /An error occurred while processing your request\./i,

  // pi-ai openai-codex-responses WebSocket transport errors. The provider holds
  // a long-lived WebSocket to the Codex backend; transient drops surface as
  // bare "WebSocket error" / "WebSocket closed <code> <reason>" / a half-open
  // stream that ended before `response.completed`. All three are network-layer
  // hiccups, not task defects — retry them.
  /WebSocket error\b/i,
  /WebSocket closed\b/i,
  /WebSocket stream closed before response\.completed/i,
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
 * Patterns for transient errors that should be silently retried without
 * logging to task log entries. These errors are extremely noisy (high frequency)
 * but harmless — the retry succeeds on the next attempt.
 *
 * Silent transient errors:
 * - "request was aborted" — AI provider streaming cancellations (very noisy,
 *   occurs frequently when providers drop in-flight requests)
 */
const SILENT_TRANSIENT_PATTERNS: RegExp[] = [
  /request was aborted/i,
  /operation was aborted(?!\s+by\b)/i,
];

/**
 * Check if an error message indicates a "silent" transient error that should
 * NOT be logged to task log entries.
 *
 * Silent transient errors are a subset of transient errors (identified by
 * {@link isTransientError}) that are extremely noisy in practice. While they
 * still trigger the normal retry mechanism (task moves back to "todo"), they
 * are suppressed from the task log to reduce noise in dashboard views.
 *
 * All silent transient errors are also transient errors — this function
 * returns `true` only for errors that {@link isTransientError} would also
 * match. The distinction is purely about logging behavior, not retry behavior.
 *
 * @param errorMessage - The error message to check
 * @returns true if the error should be silently retried without logging
 */
export function isSilentTransientError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  return SILENT_TRANSIENT_PATTERNS.some((pattern) => pattern.test(errorMessage));
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

const STALE_WORKTREE_MODULE_RESOLUTION_PATTERN = /Cannot find module\s+['"][^'"]*node_modules[^'"]*['"][\s\S]*imported from\s+/i;
const STALE_WORKTREE_MODULE_PATH_PATTERN = /Cannot find module\s+['"]([^'"]*node_modules[^'"]*)['"]/i;

export function isStaleWorktreeModuleResolutionError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  return STALE_WORKTREE_MODULE_RESOLUTION_PATTERN.test(errorMessage);
}

export function extractMissingModulePath(errorMessage: string): string | null {
  if (!errorMessage || typeof errorMessage !== "string") {
    return null;
  }
  const match = errorMessage.match(STALE_WORKTREE_MODULE_PATH_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  return match[1];
}

const UNSUPPORTED_MESSAGE_ROLE_PATTERN = /\bmessages\.\[\d+\]\.role\b[\s\S]*\bis not one of\b|\bis not one of\b[\s\S]*\bmessages\.\[\d+\]\.role\b/i;
const NON_CONTINUABLE_SESSION_PATTERN = /cannot continue from message role\s*[:=-]?\s*(?:['"`]?)(assistant|tool|function|system|user)(?:['"`]?)\b/i;
/*
FNXC:Reliability-ErrorClassification 2026-06-17-14:48:
FN-6594 treats Codex transcript-desync on post-done session re-entry as non-continuable when a `function_call_output` is replayed without its `function_call`, or the symmetric function-call/output pair is missing. Anchor on the original `No tool call found for function call output with call_id ...` symptom so executor fresh-session retry and self-healing post-done wedge recovery engage without swallowing generic 400/auth/quota errors.
*/
const CODEX_TRANSCRIPT_DESYNC_NON_CONTINUABLE_PATTERN = /\bno\s+(?:tool\s+call|function\s+call)\s+found\s+for\s+function\s+call\s+output\b/i;
const MODEL_AUTH_TIER_INCOMPATIBILITY_PATTERNS: RegExp[] = [
  // Codex ChatGPT-account auth-tier incompatibility: the model is valid, but
  // unavailable for the current auth tier.
  /\bmodel\b[\s\S]{0,160}\bnot\s+supported\s+when\s+using\s+Codex\s+with\s+a\s+ChatGPT\s+account\b/i,
  // General provider model-compatibility shapes. Keep these model-scoped so
  // generic 400/invalid_request_error failures are not treated as model swaps.
  /\bmodel\b[\s\S]{0,160}\b(?:is|was)\s+not\s+(?:supported|available)\b/i,
  /(?:['"`][^'"`]+['"`]\s+)?\bmodel\b\s+(?:is|was)\s+not\s+(?:supported|available)\b/i,
];

export function isUnsupportedMessageRoleError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  return UNSUPPORTED_MESSAGE_ROLE_PATTERN.test(errorMessage);
}

export function isModelAuthTierIncompatibilityError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }

  const hasModelContext = /\bmodel\b/i.test(errorMessage);
  const hasCompatibilitySignal = /\bnot\s+(?:supported|available|found)\b/i.test(errorMessage);
  if (/\binvalid_request_error\b/i.test(errorMessage) && hasModelContext && hasCompatibilitySignal) {
    return true;
  }

  return MODEL_AUTH_TIER_INCOMPATIBILITY_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

export function isNonContinuableSessionError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  return NON_CONTINUABLE_SESSION_PATTERN.test(errorMessage) || CODEX_TRANSCRIPT_DESYNC_NON_CONTINUABLE_PATTERN.test(errorMessage);
}

const OPERATOR_ACTIONABLE_AGENT_ERROR_PATTERNS: RegExp[] = [
  /invalid api key/i,
  /authentication failed/i,
  /unauthorized/i,
  /forbidden/i,
  /insufficient permissions?/i,
  /model .* not found/i,
  /unknown model/i,
  /no such model/i,
  /credential/i,
  /missing .*key/i,
  /billing/i,
  /quota exceeded/i,
];

export function isOperatorActionableAgentError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  return (
    isUnsupportedMessageRoleError(errorMessage) ||
    isModelAuthTierIncompatibilityError(errorMessage) ||
    OPERATOR_ACTIONABLE_AGENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
  );
}
