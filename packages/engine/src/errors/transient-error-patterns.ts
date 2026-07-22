/**
 * Pure transient-error predicates — NO module imports.
 *
 * FNXC:Reliability-ErrorClassification 2026-07-15-18:40:
 * Extracted from `transient-error-detector.ts` (FN-8004) so that
 * `transient-merge-error-classifier.ts` can share ONE definition of "transient"
 * without inheriting the detector's `usage-limit-detector.js → logger.js` import
 * chain. FN-5627 originally split the merge classifier out precisely to keep that
 * chain away from consumers whose tests `vi.mock("../logger.js")` with a partial
 * surface (notification-service.test.ts) — importing the detector directly would
 * have silently reintroduced it.
 *
 * INVARIANT: this module must stay import-free. Anything needing `isUsageLimitError`
 * or a logger belongs in `transient-error-detector.ts`, not here.
 *
 * `transient-error-detector.ts` re-exports every symbol below, so existing importers
 * are unaffected and may continue importing from either module.
 */

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

  /*
  FNXC:AcpRuntime 2026-07-15-18:25:
  ACP-backed runtimes (Grok, OMP, generic ACP) surface provider-side turn failures as JSON-RPC
  errors. `provider.ts#describeAcpTurnError` renders these as `... (acp rpc code -32603, retryable)`;
  the adapters wrap that as `<Runtime> ACP turn failed: ...`. Both signatures are matched here.

  Anchoring is deliberate: the bare JSON-RPC text is "Internal error", far too generic to match
  globally (it would swallow unrelated application failures and mask real defects). We only treat
  it as transient when it carries the ACP rpc-code envelope or the adapter's turn-failure prefix.

  FN-8004: a Grok `-32603` blip during AI merge was classified permanent, parked the task `failed`,
  and — because `status:"failed"` is what suppresses recovery — stranded 8 files of finished work.
  */
  /\bacp rpc code -32(?:603|00[0-3])\b/i,
  /\bACP turn failed\b/i,
  /\bACP failed to start\b/i,
  /\bACP session has no live connection\b/i,
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
