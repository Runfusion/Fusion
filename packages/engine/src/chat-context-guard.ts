/**
 * Deterministic pre-overflow compaction gate for the chat/CLI pi-session path.
 *
 * FNXC:ChatContextGuard 2026-08-18-18:06:
 * RUFU-118 phase 1: pi's built-in threshold auto-compaction is blind when no assistant
 * message carries non-zero provider usage (its estimateContextTokens reports
 * lastUsageIndex: null and _checkCompaction returns "No usage data at all"). Providers
 * that omit usage in the stream (observed: dsai1/deepseek-v4 openai-completions) keep
 * every assistant message at all-zero usage, so long chats silently grow past 96% of the
 * window and degrade to 1-token replies with no compaction. This gate re-measures the
 * loaded context at every chat send seam and forces compaction before the prompt when
 * the estimate crosses the threshold. It is a backstop on the chat/CLI lane only — the
 * executor lane keeps its existing TokenCapDetector (undefined = disabled) semantics.
 *
 * FNXC:ChatContextGuard 2026-08-18-18:06:
 * Threshold semantics: threshold = min(tokenCap ?? round(0.8 * contextWindow),
 * contextWindow - max(16384, maxTokens)). On the chat lane tokenCap is an UPPER BOUND on
 * the effective threshold, not an exact target: unset falls back to 80% of the per-model
 * context window, and values above the hard limit (contextWindow - reserve) are clamped.
 * The 0.8 default belongs here (engine pure function), not in the settings schema, so
 * the schema default stays undefined.
 *
 * FNXC:ChatContextGuard 2026-08-18-18:06:
 * Fail-loud contract: the gate never sends a call it cannot prove fits. When the loaded
 * context is at or above the threshold it compacts via the existing compactSessionContext
 * (session.compact()), re-measures, and throws ChatContextOverflowError when compaction
 * is unavailable/returns no result, when it throws, or when the post-compaction estimate
 * is still at or above the hard limit. Non-pi session shapes (plugin CLI runtimes without
 * getContextUsage), unknown context windows, and unknown token counts skip the gate with a
 * diagnostic warn instead of throwing — provider overflow errors from those sends still
 * surface through the existing chat failure paths.
 */

import { estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";
import { piLog } from "./logger.js";
import { compactSessionContext } from "./pi.js";
import { PermanentError } from "./errors/engine-errors.js";

/**
 * Non-retryable: a context that overflows its model window (or cannot be compacted into
 * it) will not fit on retry. Callers must surface it to the operator instead of
 * re-sending a doomed prompt.
 */
export class ChatContextOverflowError extends PermanentError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, "CHAT_CONTEXT_OVERFLOW", details, cause);
  }
}

/**
 * Floor for the output reserve. Matches pi's DEFAULT_COMPACTION_SETTINGS.reserveTokens
 * so the gate never plans a prompt with less output room than pi itself guarantees.
 */
const MIN_RESERVE_TOKENS = 16_384;

/**
 * Engine default compact fraction applied when tokenCap is unset on the chat lane:
 * compact at 80% of the per-model context window (more conservative than pi's own
 * threshold of contextWindow - reserveTokens).
 */
const DEFAULT_COMPACT_FRACTION = 0.8;

/**
 * Structural session shape the gate needs.
 *
 * A pi `AgentSession` satisfies this. Plugin CLI runtimes (grok/droid/cursor) expose a
 * top-level `messages` array without a pi-shaped `state`/`getContextUsage`, so the gate
 * skips them (diagnostic warn, no throw) — they cannot be compacted from the dashboard
 * side and their overflow errors keep flowing through the existing failure paths.
 */
export interface CompactionGateSession {
  /** pi's ContextUsage reader; absence marks a non-pi session shape. */
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  /** The active model (contextWindow/maxTokens). */
  model?: { contextWindow?: number | undefined; maxTokens?: number | undefined } | undefined;
  /** The loaded message list (post-compaction view). */
  state?: { messages?: unknown[] | undefined } | undefined;
  /** pi's compaction entry point (driven through compactSessionContext). */
  compact?: (customInstructions?: string) => Promise<unknown> | unknown;
}

interface CompactionBounds {
  hardLimit: number;
}

/**
 * Resolve the hard limit (contextWindow - reserve) or null when it is unknown/non-positive.
 * Shared by the threshold computation and the post-compaction check so the two cannot drift.
 */
function resolveCompactionBounds(
  contextWindow: number | null | undefined,
  maxTokens: number | null | undefined,
): CompactionBounds | null {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  const reserve = Math.max(
    MIN_RESERVE_TOKENS,
    typeof maxTokens === "number" && Number.isFinite(maxTokens) ? maxTokens : 0,
  );
  const hardLimit = contextWindow - reserve;
  if (hardLimit <= 0) {
    return null;
  }
  return { hardLimit };
}

/**
 * Normalize the operator's tokenCap. Non-finite, zero, and negative values are treated as
 * "unset" so a degenerate stored value cannot collapse the threshold to 0 (which would
 * compact on every send).
 */
function resolveTokenCap(tokenCap: number | null | undefined): number | null {
  if (typeof tokenCap !== "number" || !Number.isFinite(tokenCap) || tokenCap <= 0) {
    return null;
  }
  return tokenCap;
}

/**
 * Compute the effective pre-overflow compaction threshold.
 *
 * `min(tokenCap ?? round(0.8 * contextWindow), contextWindow - max(16384, maxTokens))`.
 *
 * - `tokenCap` (Settings.tokenCap) is an upper bound on the chat-lane threshold: unset
 *   falls back to 80% of the model's context window; a value above the hard limit is
 *   clamped to the hard limit.
 * - Returns `null` when the context window is unknown/non-positive or the hard limit is
 *   non-positive (reserve >= window) — callers must skip the gate in that case.
 *
 * For a 128K-window / 16K-maxTokens model with no tokenCap this yields exactly 102,400.
 */
export function computeCompactionThreshold(params: {
  contextWindow?: number | null;
  maxTokens?: number | null;
  tokenCap?: number | null;
}): number | null {
  const bounds = resolveCompactionBounds(params.contextWindow, params.maxTokens);
  if (!bounds) {
    return null;
  }
  const cap = resolveTokenCap(params.tokenCap) ?? Math.round(DEFAULT_COMPACT_FRACTION * params.contextWindow!);
  return Math.min(cap, bounds.hardLimit);
}

type EstimateTokensArg = Parameters<typeof estimateTokens>[0];

/**
 * Estimate the loaded context tokens of a session.
 *
 * Prefers `session.getContextUsage()` when it reports a concrete (non-null, > 0) token
 * count — that is pi's own measurement (last provider usage + trailing chars/4 estimate).
 * Otherwise sums pi's per-message `estimateTokens` (chars/4) over the loaded messages.
 * Returns `null` when neither source yields a measurement.
 */
export function estimateLoadedContextTokens(session: CompactionGateSession): number | null {
  if (typeof session.getContextUsage === "function") {
    try {
      const usage = session.getContextUsage();
      if (usage && typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens > 0) {
        return usage.tokens;
      }
    } catch {
      // A throwing usage reader must not break the send; fall through to the estimate.
    }
  }

  const messages = session.state?.messages;
  if (!Array.isArray(messages)) {
    return null;
  }
  let total = 0;
  for (const message of messages) {
    try {
      total += estimateTokens(message as EstimateTokensArg);
    } catch {
      // Malformed message shape (e.g. an assistant message without content) would throw
      // inside pi's estimator; count it as 0 so the gate degrades to a best-effort
      // measurement instead of breaking the send.
    }
  }
  return total;
}

/** Options for {@link ensureContextWithinCompactionThreshold}. */
export interface CompactionGateOptions {
  /**
   * Upper bound on the effective threshold (Settings.tokenCap). `undefined` means the
   * engine default of 80% of the per-model context window.
   */
  tokenCap?: number | null;
}

/** Result of a gate evaluation. */
export interface CompactionGateResult {
  /** Whether this gate call compacted the session. */
  compacted: boolean;
  /** Estimated loaded context tokens measured at gate time (null when unknown). */
  contextTokens: number | null;
  /** Effective threshold used for the decision (null when unknown/unavailable). */
  threshold: number | null;
}

/**
 * Ensure the session's loaded context fits the model window before the next prompt.
 *
 * Skips (diagnostic warn, no throw) for: non-pi session shapes, unknown context window /
 * non-positive hard limit, and unknown loaded-token measurements.
 *
 * When the measured context is at or above the threshold: compacts via the existing
 * `compactSessionContext` (session.compact()), re-measures, and throws
 * {@link ChatContextOverflowError} when compaction is unavailable/returns no result,
 * throws, or leaves the context at or above the hard limit. The prompt is never sent in
 * those cases.
 */
export async function ensureContextWithinCompactionThreshold(
  session: CompactionGateSession,
  options: CompactionGateOptions,
): Promise<CompactionGateResult> {
  if (!session || typeof session.getContextUsage !== "function") {
    piLog.warn("chat-context-guard: non-pi session shape (no getContextUsage) — skipping pre-overflow gate");
    return { compacted: false, contextTokens: null, threshold: null };
  }

  const threshold = computeCompactionThreshold({
    contextWindow: session.model?.contextWindow,
    maxTokens: session.model?.maxTokens,
    tokenCap: options.tokenCap,
  });
  if (threshold === null) {
    piLog.warn("chat-context-guard: context window unknown or hard limit non-positive — skipping pre-overflow gate");
    return { compacted: false, contextTokens: null, threshold: null };
  }

  const contextTokens = estimateLoadedContextTokens(session);
  if (contextTokens === null) {
    piLog.warn("chat-context-guard: loaded context tokens unknown — skipping pre-overflow gate");
    return { compacted: false, contextTokens: null, threshold };
  }

  if (contextTokens < threshold) {
    return { compacted: false, contextTokens, threshold };
  }

  piLog.warn(
    `chat-context-guard: loaded context ${contextTokens} tokens >= threshold ${threshold} — compacting before prompt`,
  );

  let compactResult: { summary: string; tokensBefore: number } | null;
  try {
    compactResult = await compactSessionContext(session as unknown as AgentSession);
  } catch (err) {
    throw new ChatContextOverflowError(
      `Pre-overflow compaction failed for a ${contextTokens}-token context (threshold ${threshold}, contextWindow ${session.model?.contextWindow ?? "unknown"}); the prompt was not sent`,
      { contextTokens, threshold, contextWindow: session.model?.contextWindow ?? null, stage: "compaction" },
      err instanceof Error ? err : undefined,
    );
  }
  if (!compactResult) {
    throw new ChatContextOverflowError(
      `Pre-overflow compaction returned no result for a ${contextTokens}-token context (threshold ${threshold}, contextWindow ${session.model?.contextWindow ?? "unknown"}); the prompt was not sent`,
      { contextTokens, threshold, contextWindow: session.model?.contextWindow ?? null, stage: "compaction-unavailable" },
      new Error("session.compact() produced no compaction result"),
    );
  }

  const bounds = resolveCompactionBounds(session.model?.contextWindow, session.model?.maxTokens);
  if (!bounds) {
    // The threshold check above already proved a valid bound existed at decision time;
    // a model change mid-call cannot make this reachable, but fail loud anyway.
    throw new ChatContextOverflowError(
      `Compaction completed but the hard limit is no longer computable for a ${contextTokens}-token context; the prompt was not sent`,
      { contextTokens, threshold, contextWindow: session.model?.contextWindow ?? null, stage: "post-compaction" },
    );
  }

  const afterTokens = estimateLoadedContextTokens(session);
  if (afterTokens !== null && afterTokens >= bounds.hardLimit) {
    throw new ChatContextOverflowError(
      `Context is still ${afterTokens} tokens after compaction (hard limit ${bounds.hardLimit}, contextWindow ${session.model?.contextWindow ?? "unknown"}); the prompt was not sent`,
      { contextTokens, afterTokens, threshold, hardLimit: bounds.hardLimit, contextWindow: session.model?.contextWindow ?? null, stage: "post-compaction" },
    );
  }

  if (afterTokens === null) {
    piLog.warn("chat-context-guard: post-compaction measurement unknown — proceeding after a successful compaction");
  }

  return { compacted: true, contextTokens, threshold };
}
