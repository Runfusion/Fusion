/**
 * Provider reasoning-effort rejection detection and degradation ladder.
 *
 * FNXC:ThinkingEffortFallback 2026-08-25-00:00:
 * A lane can pin a thinking effort (e.g. `max`/`xhigh`) that a specific model or
 * provider surface does not support. The zen/openai-compatible free surfaces we
 * route to reject unsupported effort values as a 400 whose message names the
 * `reasoning_effort` parameter (or the codex `[1210] Invalid API parameter`
 * envelope), while the model itself stays valid. Today that error matches none
 * of the retryable-model-selection patterns, so `promptWithFallback` re-throws
 * into triage's generic catch-all, which retries the SAME model+level forever
 * (observed: `x-preview-f-free` at `xhigh` retried "Planning using model ...
 * (thinking effort: xhigh)" every ~2-4 min without progressing).
 *
 * This maps such rejections to a bounded ONE-STEP-DOWN degradation ladder with
 * no provider hop: on a rejection, drop to the next lower effort, swap to a
 * fresh session of the same model, re-apply, and retry once. Because each rung
 * is strictly lower, the ladder is bounded by construction; when it is
 * exhausted a lane either disables explicit thinking (the existing
 * thinking/reasoning-conflict path) or falls through to the normal
 * model-fallback flow.
 *
 * INVARIANT: this module is import-free (pure predicates), mirroring
 * `transient-error-patterns.ts`, so it stays safe to import anywhere in the
 * engine without pulling a logger.
 */

/**
 * Ordered ladder, strictly HIGHER → LOWER. Degradation walks right along it.
 * FNXC:ThinkingEffortFallback 2026-08-26-21:30 (Devin BUG-0001): the rungs
 * follow the canonical `THINKING_LEVELS` vocabulary in
 * packages/core/src/types/board/board.ts, where `max` is the TOP effort and
 * `xhigh` sits one below it — an earlier revision swapped the two and
 * "degraded" xhigh UP to max, re-rejecting forever.
 */
export const THINKING_LEVEL_LADDER: readonly string[] = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "off",
];

/**
 * Returns the next LOWER effort than `level`, or `null` when:
 * - `level` is not a known ladder rung (custom/opaque label), or
 * - `level` is already the lowest rung and there is nothing left to drop to.
 */
export function degradeThinkingLevel(level: string | undefined | null): string | null {
  if (!level) {
    return null;
  }
  const index = THINKING_LEVEL_LADDER.indexOf(level);
  if (index === -1) {
    return null;
  }
  if (index === THINKING_LEVEL_LADDER.length - 1) {
    return null;
  }
  return THINKING_LEVEL_LADDER[index + 1];
}

/**
 * True when the provider rejected the request because the requested
 * `reasoning_effort` value is unsupported for that model.
 *
 * Accepted shapes:
 * - Effort-specific rejections that name the `reasoning_effort` parameter
 *   directly (OpenAI-style `reasoning_effort must be one of`, an
 *   `invalid_request_error` envelope naming `reasoning_effort`, or an
 *   "unsupported value" envelope naming `reasoning_effort`).
 * - The codex `[1210] Invalid API parameter` envelope — the OBSERVED
 *   production envelope for an out-of-range effort on the zen free surface
 *   is BARE ("...[1210] Invalid API parameter, please check the
 *   documentation."), so requiring an effort-specific token would disable
 *   the ladder for the exact loop this PR fixes. Every 1210 envelope is
 *   treated as effort-family recoverable (Devin ANALYSIS-0001): a false
 *   positive on some other invalid parameter costs at most one bounded
 *   degradation + one fallback swap (the usingFallback / terminal caps
 *   prevent a loop), while a false negative re-admits the infinite
 *   same-model+effort retry this PR exists to kill.
 *   FNXC:ThinkingEffortFallback 2026-08-29-06:54.
 *
 * Deliberately NOT matched: "Model is unavailable" (a model-availability
 * problem handled by the model-fallback path) and "Internal server error"
 * (ambiguous — handled by the generic retry path).
 */
export function isReasoningEffortRejectionError(errorMessage: string): boolean {
  if (!errorMessage || typeof errorMessage !== "string") {
    return false;
  }
  // Explicit enumeration of accepted effort values — unambiguous.
  if (/reasoning_effort\s+must be one of/i.test(errorMessage)) {
    return true;
  }
  // OpenAI-style invalid_request_error that names the effort parameter.
  if (/invalid_request_error/i.test(errorMessage) && /reasoning_effort/i.test(errorMessage)) {
    return true;
  }
  // Unsupported-value envelope naming the effort parameter.
  if (/unsupported[\s\S]{0,60}(?:value|effort)/i.test(errorMessage) && /reasoning_effort/i.test(errorMessage)) {
    return true;
  }
  // Codex `[1210] Invalid API parameter` — the OBSERVED production envelope
  // for out-of-range effort is bare ("...[1210] Invalid API parameter, please
  // check the documentation." — see PR description), so requiring an
  // effort-specific token would disable the ladder for the exact loop this PR
  // fixes. Treat every 1210 as effort-family recoverable: a false positive on
  // some OTHER invalid parameter costs at most one bounded degradation +
  // fallback swap (usingFallback/terminal caps it), while a false negative
  // re-admits the infinite same-model+effort retry.
  // FNXC:ThinkingEffortFallback 2026-08-26-22:05 (Devin ANALYSIS-0001).
  if (/\b1210\b/i.test(errorMessage) && /invalid api parameter/i.test(errorMessage)) {
    return true;
  }
  return false;
}
