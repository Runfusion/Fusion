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
/*
FNXC:Reliability-ErrorClassification 2026-07-15-18:40:
The pure predicates (TRANSIENT_ERROR_PATTERNS / isTransientError / isTransientAuthCredentialError)
now live in the import-free leaf `transient-error-patterns.ts` so the merge classifier can share
one definition of "transient" without inheriting this module's logger chain (FN-8004).
Re-exported here so every existing importer of this module keeps working unchanged.
*/
import { isTransientAuthCredentialError, isTransientError } from "./transient-error-patterns.js";
export { TRANSIENT_ERROR_PATTERNS, isTransientAuthCredentialError, isTransientError } from "./transient-error-patterns.js";


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

/*
FNXC:Reliability-ErrorClassification 2026-07-15-00:00:
FN-8004 treats only the typed TaskDeletedError message emitted when a heartbeat move races a soft-delete as a benign board miss. This must not classify broader deleted-task failures as harmless because genuine heartbeat failures still require normal recovery or parking.
*/
const CONCURRENT_SOFT_DELETE_RACE_PATTERN = /Task\s+([^\s]+)\s+is\s+soft-deleted\s+\(deletedAt=([^)]+)\)\s+and\s+cannot\s+be\s+read\s+or\s+mutated/i;
const TASK_DELETED_ERROR_TYPE_PATTERN = /(?:\bTaskDeletedError\s*:|["']name["']\s*:\s*["']TaskDeletedError["']|\bname\s*[=:]\s*TaskDeletedError\b)/i;
const SERIALIZED_TASK_ID_PATTERN = /["']taskId["']\s*:\s*["']([^"']+)["']/i;
const SERIALIZED_DELETED_AT_PATTERN = /["']deletedAt["']\s*:\s*["']([^"']+)["']/i;
const TYPED_TASK_ID_PATTERN = /\bTaskDeletedError\s*:\s*(?:task\s+)?([A-Za-z][A-Za-z0-9_-]*)\b/i;

export function isConcurrentSoftDeleteRaceError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }

  // A serialized core error can preserve only its canonical name, not Error.message.
  return CONCURRENT_SOFT_DELETE_RACE_PATTERN.test(errorMessage) || TASK_DELETED_ERROR_TYPE_PATTERN.test(errorMessage);
}

export function extractConcurrentSoftDeleteRaceDetails(errorMessage: string): { taskId?: string; deletedAt?: string } | null {
  if (!errorMessage || typeof errorMessage !== "string" || !isConcurrentSoftDeleteRaceError(errorMessage)) {
    return null;
  }

  const canonicalMatch = errorMessage.match(CONCURRENT_SOFT_DELETE_RACE_PATTERN);
  if (canonicalMatch?.[1] && canonicalMatch[2]) {
    return { taskId: canonicalMatch[1], deletedAt: canonicalMatch[2] };
  }

  const taskId = errorMessage.match(SERIALIZED_TASK_ID_PATTERN)?.[1]
    ?? errorMessage.match(TYPED_TASK_ID_PATTERN)?.[1];
  const deletedAt = errorMessage.match(SERIALIZED_DELETED_AT_PATTERN)?.[1];
  return taskId || deletedAt ? { taskId, deletedAt } : null;
}

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
