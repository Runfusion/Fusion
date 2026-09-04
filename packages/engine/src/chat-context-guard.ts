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
import {
  classifyCompactionFailure,
  compactSessionContext,
  isRetryAfterCompactionFailureLegal,
  type CompactionOutcome,
} from "./pi.js";
import { PermanentError } from "./errors/engine-errors.js";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "./util/emit-bounded-run-audit.js";

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
 * FNXC:ChatContextGuard 2026-08-20-12:20:
 * Chars-per-token divisor for the stale-usage cross-check. pi's own estimator uses
 * chars/4; the dsai1 (qwen3) provider measured on the chat lane tokenizes at ~3.46
 * chars/token, and English-centric tokenizers sit at ~3.5-4, so chars/3.5 is a
 * conservative (never-underestimating) divisor for the providers observed here.
 */
/*
FNXC:ChatContextGuardEscalation 2026-09-04-10:57:
RUFU-182 LCM escalation tiers 1-2. The gate's refusal surface is now reason-coded: every
throw names which boundary actually refused (ChatContextOverflowReason) instead of
asserting a static floor the fresh measurement often contradicts (the saneca
chat-b6a74d40 misdiagnosis — pi's refusal was "Already compacted", not a static floor).
`measurement-unknown` exists only as an AUDIT OUTCOME value: pi's own post-compaction
measurement being unusable is a measurement condition, not an overflow reason.
*/

/**
 * Why the gate refused to send the prompt (8 honest boundaries). `static-floor` is now
 * an ENTRY TEST (static prompt + active tool schemas vs the hard limit), never a
 * post-hoc diagnosis attached to a compaction failure.
 */
export type ChatContextOverflowReason =
  | "static-floor"
  | "empty-summary"
  | "non-reducing-summary"
  | "post-compaction-over-limit"
  | "already-compacted"
  | "nothing-to-compact"
  | "compaction-error"
  | "unsupported";

/** LCM escalation tier. Tier 3 (partial branch rewrite) is RUFU-183 and is not a legal value here. */
export type CompactionEscalationTier = "normal" | "aggressive";

/** Why the aggressive (tier-2) retry was not attempted, per branch-mutation legality. */
export type CompactionRetrySkippedReason =
  | "not-needed"
  | "branch-already-mutated"
  | "pi-refuses-second-compaction"
  | "capability-missing";

/**
 * Audit outcome enum. `measurement-unknown` wins over `refused` whenever pi's own
 * post-compaction measurement was unusable — even on a throw — so operators can
 * distinguish "the engine refused" from "we could not observe what the engine did".
 */
export type CompactionAuditOutcome =
  | "compacted"
  | "proceeded-without-reduction"
  | "refused"
  | "measurement-unknown";

/** Where the gate reports its per-invocation compaction audit row. */
export interface CompactionAuditContext {
  /**
   * Host with `recordRunAuditEvent` (the TaskStore). Sink absence or a throwing sink
   * never changes the gate's outcome — the bounded emitter absorbs both.
   */
  sink?: RunAuditSinkHost;
  taskId?: string | null;
  sessionId?: string | null;
}

const FRESH_ESTIMATE_CHARS_PER_TOKEN = 3.5;

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
  /**
   * FNXC:ChatContextGuard 2026-08-20-12:20:
   * The session's current final system prompt. pi populates it during session setup
   * (setActiveToolsByName rebuilds it from the base prompt, context files such as
   * AGENTS.md, skills, and the active tools' guidelines), so at the pre-prompt gate
   * seam it describes exactly the prompt the next send would carry. Absent on
   * non-pi runtimes and on pi versions that build it lazily — the fresh estimate
   * then degrades to null and the gate keeps its fail-loud behavior.
   */
  systemPrompt?: string | undefined;
  /** pi's active tool names (subset of the configured registry). */
  getActiveToolNames?: () => string[];
  /** pi's configured tool definitions (name/description/parameters/…). */
  getAllTools?: () => Array<{ name?: string; description?: string; parameters?: unknown }>;
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
 * FNXC:ChatContextGuard 2026-08-20-12:20:
 * Fresh measurement of what the NEXT send would actually carry: the session's current
 * final system prompt + the active tools' schemas (the provider counts the `tools`
 * parameter on top of the prompt) + the loaded messages, in conservative chars/3.5
 * (system prompt + tools) plus pi's own per-message estimate.
 *
 * This exists to detect a STALE provider-reported usage: pi persists assistant
 * usage into the session file and getContextUsage() restores it into a fresh
 * session object, so the number describes the static context of the turn that
 * RECORDED it, not the current one. After a deploy that shrank the chat prompt/
 * toolset (RUFU-135), an old 124K-token usage kept failing every send with
 * ChatContextOverflowError even though the live context was ~36K (chat-02c9c9de).
 * Returns null when the session does not expose the final system prompt — the
 * caller then cannot distinguish stale from real and must keep the fail-loud path.
 */
export function freshLoadedContextEstimate(session: CompactionGateSession): number | null {
  const systemPrompt = typeof session.systemPrompt === "string" ? session.systemPrompt : "";
  if (!systemPrompt) {
    return null;
  }
  let chars = systemPrompt.length;
  try {
    const activeNames = new Set(session.getActiveToolNames?.() ?? []);
    for (const tool of session.getAllTools?.() ?? []) {
      if (typeof tool?.name !== "string" || !tool.name) continue;
      if (activeNames.size > 0 && !activeNames.has(tool.name)) continue;
      chars += Buffer.byteLength(
        JSON.stringify({
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.parameters ?? {},
        }),
        "utf8",
      );
    }
  } catch {
    // Tool introspection is best-effort; a failing reader must not break the gate.
  }
  let messageTokens = 0;
  const messages = session.state?.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      try {
        messageTokens += estimateTokens(message as EstimateTokensArg);
      } catch {
        // Malformed message shapes count as 0 (best-effort measurement).
      }
    }
  }
  return Math.round(chars / FRESH_ESTIMATE_CHARS_PER_TOKEN) + messageTokens;
}

/**
 * Estimate of the STATIC context floor: current system prompt + active tool schemas,
 * WITHOUT message history. Measured the same way as {@link freshLoadedContextEstimate}
 * (chars / 3.5) so the two measurements cannot drift. Returns null when the session
 * does not expose a usable current system prompt — the gate then skips the static-floor
 * entry test (best-effort: a null floor never throws on its own).
 */
function staticContextFloorEstimate(session: CompactionGateSession): number | null {
  let prompt = "";
  try {
    prompt = typeof session.systemPrompt === "string" ? session.systemPrompt : "";
  } catch {
    return null;
  }
  if (!prompt.trim()) return null;
  let chars = Buffer.byteLength(prompt, "utf8");
  try {
    const activeNames = typeof session.getActiveToolNames === "function" ? session.getActiveToolNames() : [];
    const allTools = typeof session.getAllTools === "function" ? session.getAllTools() : [];
    const activeSet = new Set(activeNames ?? []);
    for (const tool of allTools ?? []) {
      if (typeof tool?.name !== "string" || !tool.name) continue;
      if (activeSet.size > 0 && !activeSet.has(tool.name)) continue;
      chars += Buffer.byteLength(
        JSON.stringify({
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.parameters ?? {},
        }),
        "utf8",
      );
    }
  } catch {
    // Tool introspection is best-effort; a failing reader degrades to prompt-only, matching
    // freshLoadedContextEstimate's refusal to break the send on a broken registry reader.
  }
  return Math.ceil(chars / FRESH_ESTIMATE_CHARS_PER_TOKEN);
}

/**
 * Tier-2 escalation directive: an explicit target budget derived from the compaction
 * threshold (75% of it), so the summarizer is told to drop content rather than
 * re-summarize at the same granularity as the fallback directive. Must stay distinct
 * from pi's COMPACTION_FALLBACK_INSTRUCTIONS — asserting they differ is the
 * no-silent-no-op contract for the escalation tier.
 */
export function buildAggressiveCompactionDirective(threshold: number): string {
  const targetTokens = Math.floor(threshold * 0.75);
  return [
    "This session's loaded context still exceeds the compaction threshold after a normal compaction pass.",
    `Produce ONE consolidated compaction summary that reduces the loaded context to a target budget of at most ${targetTokens} tokens (the threshold is ${threshold} tokens).`,
    "Aggressively merge and paraphrase older history. Preserve verbatim only the most recent turns, open tasks, decisions, file paths, and commands needed to continue the work.",
    "Do NOT produce an empty or near-empty summary and do NOT restate the conversation — drop content to fit the budget.",
  ].join("\n");
}

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
   * FNXC:ChatContextGuardEscalation 2026-09-04-10:57:
   * RUFU-182: where to report the single bounded `chat:pre-overflow-compaction` audit
   * row emitted per gate invocation that attempted compaction. Absent sink = no row.
   */
  audit?: CompactionAuditContext;
  /**
   * Upper bound on the effective threshold (Settings.tokenCap). `undefined` means the
   * engine default of 80% of the per-model context window.
   */
  tokenCap?: number | null;
  /**
   * FNXC:ChatContextGuard 2026-08-19-15:05:
   * RUFU-118: operator opt-out (Settings.chatPreOverflowCompactionEnabled). `false`
   * disables the gate for this call (no measurement, no compaction, no throw);
   * `undefined` or `true` keeps it active. The gate ships ON by default (an opt-out,
   * not an opt-in) because without it a context at the model wall degrades to 1-token
   * replies — pi's own threshold compaction never fires for zero-usage providers
   * (earendil-works/pi#8328) — but it is a selectable feature, so a project that
   * prefers the raw pi-only behavior can turn it off.
   */
  enabled?: boolean;
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
 * Skips (diagnostic warn, no throw) for: an explicit `enabled: false` opt-out,
 * non-pi session shapes, unknown context window / non-positive hard limit, and unknown
 * loaded-token measurements.
 *
 * When the measured context is at or above the threshold: runs the LCM escalation
 * ladder — tier 1 normal compaction via `compactSessionContext`, plus exactly one
 * aggressive-directive retry (tier 2) ONLY where retry is legal (a tier-1 error left the
 * branch unmutated; pi's absolute "Already compacted" / "Nothing to compact" refusals
 * and a missing compaction capability are terminal, because a larger directive cannot
 * unlock them). Acceptance is strict: the summary must be non-empty AND pi must report a
 * context reduction. Every throw names its {@link ChatContextOverflowReason}. The
 * prompt is never sent on a refusal.
 */
export async function ensureContextWithinCompactionThreshold(
  session: CompactionGateSession,
  options: CompactionGateOptions = {},
): Promise<CompactionGateResult> {
  if (options.enabled === false) {
    // Routine per-turn skip (operator opted out via Settings.chatPreOverflowCompactionEnabled).
    // debug() keeps this out of the steady-state log — a warn/log here would fire on every
    // chat turn for opted-out projects.
    piLog.debug("chat-context-guard: pre-overflow gate disabled by project settings — skipping");
    return { compacted: false, contextTokens: null, threshold: null };
  }
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

  const contextWindow = session.model?.contextWindow ?? null;
  const hardLimit =
    resolveCompactionBounds(contextWindow ?? undefined, session.model?.maxTokens ?? undefined)?.hardLimit ?? null;

  /*
  FNXC:ChatContextGuardEscalation 2026-09-04-10:57:
  The static floor is an ENTRY TEST, never a post-hoc diagnosis (RUFU-182). The old code
  attached "the static context ... itself exceeds the window budget" to every compaction
  failure, and saneca chat-b6a74d40 proved that claim is often false: the fresh
  measurement was 102,862 tokens — under the 111,616 hard limit — while pi's actual
  refusal was "Already compacted". The sentence is now emitted only when the CURRENT
  static prompt + active tool schemas alone reach the hard limit, measured before any
  compaction attempt; the ladder never runs and no audit row is written for it.
  */
  if (hardLimit !== null) {
    const staticTokens = staticContextFloorEstimate(session);
    if (staticTokens !== null && staticTokens >= hardLimit) {
      throw new ChatContextOverflowError(
        `Static context floor of ${staticTokens} tokens meets or exceeds the hard limit ${hardLimit} (measured ${contextTokens}, threshold ${threshold}, contextWindow ${contextWindow ?? "unknown"}): the static context (system prompt + tools + memory) itself exceeds the window budget — reduce the agent's tools/memory or use a larger-window model; the prompt was not sent`,
        {
          reason: "static-floor",
          tiersAttempted: [] as CompactionEscalationTier[],
          contextTokens,
          staticTokens,
          threshold,
          hardLimit,
          contextWindow,
          stage: "static-floor",
        },
      );
    }
  }

  /*
  FNXC:ChatContextGuardEscalation 2026-09-04-10:57:
  LCM escalation ladder, tiers 1-2 (tier 3, deterministic partial branch rewrite, is
  RUFU-183 and must NOT appear here). compactSessionContext is total: it returns a
  reason-coded CompactionOutcome instead of throwing or returning null, so every branch
  switches on outcome.reason. Tier 2 (aggressive directive) runs ONLY after an error
  arm — a transient upstream failure or a cancelled pass left the branch unmutated. pi's
  "Already compacted" / "Nothing to compact" refusals come from its own guard and are
  absolute: re-asking with a larger directive is exactly the silent-no-op retry this
  task deletes. Acceptance is strict: non-empty summary AND pi-reported reduction. Send
  vs no-send stays decided by the guard's own estimator — no second hard-limit gate.
  One bounded chat:pre-overflow-compaction audit row per invocation that reached the
  ladder; sink absence or a hostile sink never changes the outcome.
  */
  const auditContext = options.audit;
  const emitAudit = async (fields: {
    tier: CompactionEscalationTier;
    tiersAttempted: CompactionEscalationTier[];
    reason: ChatContextOverflowReason | null;
    outcome: CompactionAuditOutcome;
    afterTokens: number | null;
    retrySkippedReason: CompactionRetrySkippedReason;
  }): Promise<void> => {
    if (!auditContext?.sink) return;
    await emitBoundedRunAudit(auditContext.sink, {
      agentId: "chat-context-guard",
      runId: "chat-pre-overflow-compaction",
      domain: "database",
      mutationType: "chat:pre-overflow-compaction",
      target: auditContext.sessionId ? `chat:${auditContext.sessionId}` : "chat-context",
      taskId: auditContext.taskId ?? undefined,
      metadata: {
        tier: fields.tier,
        tiersAttempted: fields.tiersAttempted,
        reason: fields.reason,
        outcome: fields.outcome,
        beforeTokens: contextTokens,
        afterTokens: fields.afterTokens,
        threshold,
        retrySkippedReason: fields.retrySkippedReason,
      },
    });
  };

  const runTier = async (customInstructions?: string): Promise<CompactionOutcome> => {
    try {
      return await compactSessionContext(session as unknown as AgentSession, customInstructions);
    } catch (err) {
      // compactSessionContext is total (classifies instead of throwing); this defensive
      // catch applies the same classifier so a helper bug cannot escape as an
      // unclassified throw and bypass the ladder's tier semantics.
      return classifyCompactionFailure(err);
    }
  };

  const tiersAttempted: CompactionEscalationTier[] = ["normal"];
  let tier: CompactionEscalationTier = "normal";
  let outcome = await runTier();

  if (isRetryAfterCompactionFailureLegal(outcome)) {
    /*
    FNXC:ChatContextGuardEscalation 2026-09-04-10:57:
    Tier-2 legality is branch-mutation-based, not failure-class based: aborted/cancelled
    and transient throws both appended nothing, so one directive-driven pass is legal for
    each. Re-measure with the guard's own estimator before escalating so the log records
    what the retry faces; the directive's target budget derives from the threshold, not
    from this measurement.
    */
    const tier2Remeasured = estimateLoadedContextTokens(session) ?? contextTokens;
    piLog.warn(
      `chat-context-guard: tier-1 compaction failed (${outcome.engineMessage ?? "unknown engine error"}) with the branch unmutated — escalating once to the aggressive-directive tier (remeasured ${tier2Remeasured} tokens)`,
    );
    tier = "aggressive";
    tiersAttempted.push("aggressive");
    outcome = await runTier(buildAggressiveCompactionDirective(threshold));
  }

  const refusalDetails = (reason: ChatContextOverflowReason, extra: Record<string, unknown> = {}) => ({
    reason,
    tiersAttempted,
    contextTokens,
    threshold,
    hardLimit,
    contextWindow,
    stage: "compaction",
    ...extra,
  });

  if (outcome.reason === "unsupported") {
    await emitAudit({
      tier,
      tiersAttempted,
      reason: "unsupported",
      outcome: "refused",
      afterTokens: null,
      retrySkippedReason: "capability-missing",
    });
    throw new ChatContextOverflowError(
      `Pre-overflow compaction is unsupported on this session shape (reason=unsupported, tiers attempted: ${tiersAttempted.join(", ")}): the session exposes no compaction capability — measured ${contextTokens} tokens >= threshold ${threshold}; the prompt was not sent`,
      refusalDetails("unsupported", { engineMessage: outcome.engineMessage }),
    );
  }

  if (outcome.reason === "already-compacted" || outcome.reason === "nothing-to-compact") {
    /*
    FNXC:ChatContextGuard 2026-08-20-12:20:
    Stale-usage cross-check (RUFU-135 follow-up), carried into the reason-coded refusal
    arms by RUFU-182: pi refusing to compact means the recorded usage may describe a
    LARGER static context than the session carries now (it is restored from the session
    file and predates whatever deploy changed the prompt/toolset). Re-measure the current
    prompt + active tool schemas + messages; if the fresh measurement fits under the
    threshold, the recorded usage is stale and the send is safe. When it also exceeds the
    threshold the refusal is surfaced honestly — naming pi's refusal, NOT a static-floor
    claim — and the gate keeps its fail-loud behavior.
    */
    const freshTokens = freshLoadedContextEstimate(session);
    if (freshTokens !== null && freshTokens < threshold) {
      piLog.log(
        `chat-context-guard: recorded context ${contextTokens} tokens is stale — fresh measurement of the current prompt + tools + messages is ${freshTokens} tokens (< threshold ${threshold}); the session's static context changed since the usage was recorded. Proceeding with the current context.`,
      );
      await emitAudit({
        tier,
        tiersAttempted,
        reason: outcome.reason,
        outcome: "proceeded-without-reduction",
        afterTokens: freshTokens,
        retrySkippedReason: "pi-refuses-second-compaction",
      });
      return { compacted: false, contextTokens: freshTokens, threshold };
    }
    await emitAudit({
      tier,
      tiersAttempted,
      reason: outcome.reason,
      outcome: "refused",
      afterTokens: freshTokens,
      retrySkippedReason: "pi-refuses-second-compaction",
    });
    throw new ChatContextOverflowError(
      `Pre-overflow compaction was refused by the session engine (reason=${outcome.reason}, tiers attempted: ${tiersAttempted.join(", ")}): pi: "${outcome.engineMessage ?? outcome.reason}" — this refusal is absolute, a larger compaction directive cannot unlock it; measured ${contextTokens} tokens >= threshold ${threshold}${hardLimit !== null ? `, hard limit ${hardLimit}` : ""}${freshTokens !== null ? `, fresh measurement of the current prompt + tools + messages is ${freshTokens} tokens${freshTokens >= threshold ? " — reduce the agent's tools/memory or use a larger-window model" : ""}` : "; the fresh measurement is unavailable"}; the prompt was not sent`,
      refusalDetails(outcome.reason, { freshTokens, engineMessage: outcome.engineMessage }),
    );
  }

  if (outcome.reason === "error") {
    // Reaching this arm means the tier-1 error escalated and the single legal retry
    // also errored — the retry was attempted, so it was never "skipped".
    await emitAudit({
      tier,
      tiersAttempted,
      reason: "compaction-error",
      outcome: "refused",
      afterTokens: null,
      retrySkippedReason: "not-needed",
    });
    const engineMessage = outcome.engineMessage ?? "unknown engine error";
    throw new ChatContextOverflowError(
      `Pre-overflow compaction failed (reason=compaction-error, tiers attempted: ${tiersAttempted.join(", ")}): ${engineMessage} — measured ${contextTokens} tokens >= threshold ${threshold}${hardLimit !== null ? `, hard limit ${hardLimit}` : ""}; the prompt was not sent`,
      refusalDetails("compaction-error", { engineMessage }),
      new Error(engineMessage),
    );
  }

  // outcome.reason is now "compacted" | "no-progress": the branch is mutated; the strict
  // acceptance rule decides. A `no-progress` outcome (RUFU-187) is a MEASURED non-reduction by
  // construction, so it normalizes into the SAME not-accepted/escalation branch a `compacted`
  // outcome with `reduced:false` already takes — the guard must not invent a second refusal shape
  // for the same operator-visible fact.
  if (outcome.reason === "compacted" && outcome.summary.trim().length === 0) {
    await emitAudit({
      tier,
      tiersAttempted,
      reason: "empty-summary",
      outcome: "refused",
      afterTokens: null,
      retrySkippedReason: "branch-already-mutated",
    });
    throw new ChatContextOverflowError(
      `Pre-overflow compaction returned an empty summary (reason=empty-summary, tiers attempted: ${tiersAttempted.join(", ")}): the branch was mutated but nothing usable was produced for a ${contextTokens}-token context (threshold ${threshold}); the prompt was not sent`,
      refusalDetails("empty-summary", { tokensBefore: outcome.tokensBefore }),
    );
  }

  const bounds = resolveCompactionBounds(session.model?.contextWindow, session.model?.maxTokens);
  if (!bounds) {
    // The threshold check above already proved a valid bound existed at decision time;
    // a model change mid-call cannot make this reachable, but fail loud anyway.
    throw new ChatContextOverflowError(
      `Compaction completed but the hard limit is no longer computable for a ${contextTokens}-token context; the prompt was not sent`,
      {
        reason: "post-compaction-over-limit",
        tiersAttempted,
        contextTokens,
        threshold,
        contextWindow,
        stage: "post-compaction",
      },
    );
  }

  const afterTokens = estimateLoadedContextTokens(session);
  const overLimit = afterTokens !== null && afterTokens >= bounds.hardLimit;

  /*
  FNXC:CompactionNoProgress 2026-09-04-16:35:
  RUFU-187 — normalize the two non-reduction sources into one decision so the guard has a single
  non-acceptance path: `didReduce` is false for BOTH a `compacted` pi-report that did not beat
  `tokensBefore` AND the `no-progress` kind; `measuredAfterTokens` is the pi after-count when usable
  (a `number` on the `no-progress` arm by construction). The refusal/proceed split below is unchanged
  for a `compacted` non-reduction; a `no-progress` outcome simply enters it through the same door.
  */
  const didReduce = outcome.reason === "compacted" ? outcome.reduced : false;
  const measuredAfterTokens = outcome.estimatedTokensAfter;

  if (!didReduce && measuredAfterTokens !== null) {
    // pi's measurement is usable and shows NO reduction: never a hard failure when the
    // send still fits (that would create refusals where today's sends work), but a
    // refusal when the un-reduced context is over the hard limit — the reason names the
    // failed reduction, not a generic over-limit claim.
    if (overLimit) {
      await emitAudit({
        tier,
        tiersAttempted,
        reason: "non-reducing-summary",
        outcome: "refused",
        afterTokens,
        retrySkippedReason: "branch-already-mutated",
      });
      throw new ChatContextOverflowError(
        `Pre-overflow compaction produced a summary that did not reduce the context (reason=non-reducing-summary, tiers attempted: ${tiersAttempted.join(", ")}): ${afterTokens} tokens remain vs the ${bounds.hardLimit} hard limit (threshold ${threshold}, contextWindow ${contextWindow ?? "unknown"}); the prompt was not sent`,
        refusalDetails("non-reducing-summary", {
          afterTokens,
          tokensBefore: outcome.tokensBefore,
          estimatedTokensAfter: measuredAfterTokens,
          stage: "post-compaction",
        }),
      );
    }
    piLog.warn(
      `chat-context-guard: compaction summary did not reduce the context (pi estimated ${measuredAfterTokens} tokens vs ${outcome.tokensBefore}); proceeding without a validated reduction`,
    );
    await emitAudit({
      tier,
      tiersAttempted,
      reason: "non-reducing-summary",
      outcome: "proceeded-without-reduction",
      afterTokens,
      retrySkippedReason: "branch-already-mutated",
    });
    return { compacted: false, contextTokens: afterTokens ?? measuredAfterTokens, threshold };
  }

  if (outcome.estimatedTokensAfter === null) {
    /*
    FNXC:ChatContextGuardEscalation 2026-09-04-10:57:
    measurement-unknown: pi's own after-measurement is unusable (estimatedTokensAfter is
    message-only), so the strict acceptance rule cannot be satisfied. The audit outcome
    is ALWAYS measurement-unknown on this arm — even on a throw — because the honest
    statement is "we could not observe what compaction did". Send vs no-send defers to
    the guard's own estimator; a fitting send proceeds UNVALIDATED (compacted:false).
    */
    if (overLimit) {
      await emitAudit({
        tier,
        tiersAttempted,
        reason: "post-compaction-over-limit",
        outcome: "measurement-unknown",
        afterTokens,
        retrySkippedReason: "branch-already-mutated",
      });
      throw new ChatContextOverflowError(
        `Context measurement after compaction is unvalidated and the guard's own estimate is ${afterTokens} tokens, at or above the ${bounds.hardLimit} hard limit (reason=post-compaction-over-limit, tiers attempted: ${tiersAttempted.join(", ")}, threshold ${threshold}, contextWindow ${contextWindow ?? "unknown"}); the prompt was not sent`,
        refusalDetails("post-compaction-over-limit", {
          afterTokens,
          hardLimit: bounds.hardLimit,
          stage: "post-compaction",
        }),
      );
    }
    piLog.warn(
      "chat-context-guard: post-compaction measurement unknown — proceeding without a validated reduction",
    );
    await emitAudit({
      tier,
      tiersAttempted,
      reason: null,
      outcome: "measurement-unknown",
      afterTokens,
      retrySkippedReason: "branch-already-mutated",
    });
    return { compacted: false, contextTokens: afterTokens, threshold };
  }

  if (overLimit) {
    await emitAudit({
      tier,
      tiersAttempted,
      reason: "post-compaction-over-limit",
      outcome: "refused",
      afterTokens,
      retrySkippedReason: "branch-already-mutated",
    });
    throw new ChatContextOverflowError(
      `Context is still ${afterTokens} tokens after compaction (reason=post-compaction-over-limit, tiers attempted: ${tiersAttempted.join(", ")}, hard limit ${bounds.hardLimit}, contextWindow ${contextWindow ?? "unknown"}); the prompt was not sent`,
      refusalDetails("post-compaction-over-limit", {
        afterTokens,
        hardLimit: bounds.hardLimit,
        stage: "post-compaction",
      }),
    );
  }

  if (afterTokens === null) {
    piLog.warn("chat-context-guard: post-compaction measurement unknown — proceeding after a successful compaction");
  }
  await emitAudit({
    tier,
    tiersAttempted,
    reason: null,
    outcome: "compacted",
    afterTokens,
    retrySkippedReason: "not-needed",
  });
  return { compacted: true, contextTokens, threshold };
}
