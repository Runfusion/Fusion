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
  /ECONNRESET/i,
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
  if (isTransientAuthCredentialError(errorMessage)) {
    return true;
  }
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/*
 * FNXC:PlanReviewReplan 2026-07-15-12:00:
 * FN-7977 / issue #2124: a Plan Review provider, model-selection, or transport
 * failure is not evidence that the plan needs revision. This extends FN-7561's
 * advisory-failure guard to hard failures so execution state never regresses to
 * planning unless a reviewer actually returned REVISE.
 */
const MODEL_FALLBACK_EXHAUSTED_PATTERN = /unable to select a usable model after\s+\d+\s+attempt/i;

/**
 * Identifies failed Plan Review calls that must stay in place rather than trigger
 * the plan-revision handoff. The raw node failure value preserves abort/exception
 * cases when a provider produced no diagnostic message.
 */
export function isNonPlanDefectPlanReviewFailure(input: {
  verdict?: string;
  errorMessage?: string;
  failureValue?: string;
}): boolean {
  if (input.verdict === "REVISE") return false;

  const failureValue = input.failureValue?.trim().toLowerCase();
  if (failureValue === "exception" || failureValue === "aborted") return true;

  const errorMessage = input.errorMessage?.trim();
  return Boolean(
    errorMessage
    && (
      isTransientError(errorMessage)
      || isUsageLimitError(errorMessage)
      || isOperatorActionableAgentError(errorMessage)
      || MODEL_FALLBACK_EXHAUSTED_PATTERN.test(errorMessage)
    )
  );
}

/*
FNXC:Reliability-ErrorClassification 2026-07-12-20:10:
A long-running agent session holds its OAuth access token in memory. Claude Max access tokens rotate mid-run (~8 h lifetime); the in-flight call fails with a 401 {"type":"authentication_error","message":"Invalid authentication credentials"} even though the credentials file has already been refreshed, and the very next call succeeds. These must classify as TRANSIENT (retryable) and NOT operator-actionable, so in-run retry (withRateLimitRetry) and durable-agent heartbeat error recovery (FN-7835/FN-7844/FN-7859) auto-recover instead of parking agents paused with pauseReason "error-unrecoverable". Previously the message matched the operator-actionable /credential/ and /unauthorized/ patterns and defaulted to "permanent", so a routine token rotation parked every durable agent for manual operator repair.
Genuinely operator-actionable auth failures are excluded first: OAuth scope/permission-grant errors (token valid but lacks grants) and explicit API-key problems (invalid/missing x-api-key) — retrying those only repeats the failing call.
*/
const TRANSIENT_AUTH_CREDENTIAL_ROTATION_PATTERN =
  /"type":\s*"authentication_error"|invalid authentication credentials|token[_\s]?expired/i;
/*
FNXC:Reliability-ErrorClassification 2026-07-12-21:05:
PR #2027 review: the `"type":"authentication_error"` envelope is intentionally broad (providers put rotation failures behind it with varying messages), so the exclusion list must carry the operator-actionable load. Beyond scope grants and invalid/missing API keys, exclude account/credential states no retry can fix: revoked/suspended/disabled/deactivated keys or accounts and inactive subscriptions. A message matching any of these stays permanent/operator-actionable even inside an authentication_error envelope; retries are pointless and would un-park agents a human must repair. Unmatched novel auth messages still classify transient, but the bounded heartbeat error-recovery budget re-parks them as `error-retry-exhausted` after a few attempts, so the failure mode is a handful of visible retries, not an unpark loop.
*/
const OPERATOR_ACTIONABLE_AUTH_EXCLUSION_PATTERN =
  /oauth token does not meet scope|insufficient[_\s-]?scope|invalid[_\s-]?scope|invalid (?:api[_\s-]?key|x-api-key)|missing\s+(?:\S+\s+)?(?:api[_\s-]?)?key|revoked|suspend(?:ed)?|disabled|deactivated|subscription|account (?:is )?(?:locked|closed|inactive)|access denied/i;

/**
 * Detect a transient authentication failure caused by credential rotation
 * (e.g. a Claude Max OAuth access token expiring mid-run). Scope-grant and
 * API-key misconfiguration errors are excluded — those need operator action.
 */
export function isTransientAuthCredentialError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  if (OPERATOR_ACTIONABLE_AUTH_EXCLUSION_PATTERN.test(errorMessage)) {
    return false;
  }
  return TRANSIENT_AUTH_CREDENTIAL_ROTATION_PATTERN.test(errorMessage);
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

const PROVIDER_MODEL_NOT_FOUND_PATTERNS: RegExp[] = [
  /\bmodel\b[\s\S]{0,160}\bnot\s+found\b/i,
  /\bno\s+such\s+model\b/i,
  /\bunknown\s+model\b/i,
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

export function isProviderModelNotFoundError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }

  /*
   * FNXC:ModelFallback 2026-07-01-16:42:
   * Anthropic can reject newly cataloged models such as Claude Sonnet 5 with a structured 404 `not_found_error` when the current account or API surface cannot serve that model, often with only `message: "Not found"`. Treat provider error envelopes and explicit model-not-found text as model-selection failures so configured fallbacks run, while generic application 404s without a provider envelope remain terminal.
   */
  const hasStructuredProviderNotFound =
    /["']type["']\s*:\s*["']not_found_error["']/i.test(errorMessage)
    || /\bnot_found_error\b/i.test(errorMessage);
  const hasNotFoundStatus = /\b(?:404|not\s+found)\b/i.test(errorMessage);
  const hasProviderErrorEnvelope = /["']type["']\s*:\s*["']error["']/i.test(errorMessage)
    || /\bError:\s*404\b/i.test(errorMessage);
  if (hasStructuredProviderNotFound && hasNotFoundStatus && hasProviderErrorEnvelope) {
    return true;
  }

  return PROVIDER_MODEL_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(errorMessage));
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
  /(?:oauth token )?does not meet scope requirements?/i,
  /insufficient[_\s-]?scope/i,
  /model .* not found/i,
  /unknown model/i,
  /no such model/i,
  /credential/i,
  /missing .*key/i,
  /no api key/i,
  /billing/i,
  /quota exceeded/i,
];

export function isOperatorActionableAgentError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  /*
  FNXC:Reliability-ErrorClassification 2026-07-12-20:10:
  Transient OAuth token-rotation 401s must NOT be treated as operator-actionable even though the provider message contains "credentials": no operator action fixes them (the refreshed token already exists on disk) and marking them actionable parks durable agents "error-unrecoverable" instead of letting bounded heartbeat error recovery retry. Scope/API-key failures are excluded inside the classifier and still fall through to the actionable patterns below.
  */
  if (isTransientAuthCredentialError(errorMessage)) {
    return false;
  }
  return (
    isUnsupportedMessageRoleError(errorMessage) ||
    isModelAuthTierIncompatibilityError(errorMessage) ||
    isProviderModelNotFoundError(errorMessage) ||
    OPERATOR_ACTIONABLE_AGENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
  );
}
