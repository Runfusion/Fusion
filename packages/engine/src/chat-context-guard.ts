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

import { estimateTokens, type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { piLog } from "./logger.js";
import {
  classifyCompactionFailure,
  compactSessionContext,
  isRetryAfterCompactionFailureLegal,
  type CompactionOutcome,
} from "./pi.js";
import { PermanentError } from "./errors/engine-errors.js";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "./util/emit-bounded-run-audit.js";
import { buildDeterministicFallbackCompaction } from "./chat-context-deterministic-fallback.js";

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

/**
 * LCM escalation tier.
 *
 * FNXC:ChatOverflowCompaction 2026-09-04-19:20:
 * RUFU-183 adds tier 3 (`fallback`): a deterministic, non-LLM truncation that runs when the LLM
 * summarizer is unavailable or refuses, so an over-threshold session is never PERMANENTLY
 * unsendable. It is a new TIER, not a ninth refusal reason — a tier-3 attempt that cannot converge
 * still surfaces the existing reasons unchanged. Attempts are capped at one per send: escalation is
 * bounded, not "loop while stuck", so a stuck card fails loudly on tier 3's own result instead of
 * spinning on the one lever that has no model call to blame.
 */
export type CompactionEscalationTier = "normal" | "aggressive" | "fallback";

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
/**
 * The public surface of pi's `SessionManager` this gate is allowed to touch.
 *
 * FNXC:ChatOverflowCompaction 2026-09-04-19:20:
 * Tier 3 needs five public members and no private ones: `buildContextEntries` (the active,
 * compaction-aware leaf view to split), `getEntries` + `getLeafId` (real leaf-path order, needed to
 * place the split past any live compaction — `buildSessionPath`/`getBranch` are NOT exported),
 * `appendCompaction` (the only append it may use) and `buildSessionContext` (the rebuilt message
 * list to install into the live view). `appendMessage` and `newSession` are deliberately ABSENT: a
 * gate may not write messages or open a branch, so tier 3 cannot drop history outside
 * `appendCompaction`. Every member is optional so a plugin/fake session that lacks the manager —
 * or an older pi that lacks a member — is treated as CANNOT REDUCE and keeps today's refusal
 * verbatim rather than receiving a weaker reduction or a crash on a missing method.
 */
export interface CompactionGateSessionManager {
  buildContextEntries?: () => SessionEntry[];
  buildSessionContext?: () => { messages?: unknown[] } | undefined;
  getEntries?: () => SessionEntry[];
  getLeafId?: () => string | null;
  appendCompaction?: (
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    usage?: unknown,
  ) => string;
}

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
  /** pi's public transcript manager. Its ABSENCE makes escalation tier 3 incapable. */
  sessionManager?: CompactionGateSessionManager;
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
  /*
  FNXC:ChatContextGuardEstimateParity 2026-09-16-12:40:
  Review finding (RUFU-118 PR): this estimator measured the prompt in UTF-16 code units while
  {@link staticContextFloorEstimate} measured it in bytes, so a non-ASCII prompt diverged up to 3x
  between the two paths that the doc comment requires to agree. Bytes are the conservative unit
  (bytes >= code units), so both estimators now price the static prompt identically in bytes.
  */
  let chars = Buffer.byteLength(systemPrompt, "utf8");
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
 *
 * FNXC:ChatOverflowCompaction 2026-09-04-19:20:
 * Exported for RUFU-183: escalation tier 3 must subtract this floor from its message budget AND
 * prove its result against it — a message-only comparison would pass when the static floor alone
 * already sits over target.
 */
export function staticContextFloorEstimate(session: CompactionGateSession): number | null {
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
 * Where a compaction aims, as a fraction of the trigger threshold. pi keeps a flat
 * `keepRecentTokens` (20 000) rather than a budget, so this target is the guard's own concept —
 * the number both escalation steers toward.
 */
const COMPACTION_TARGET_FRACTION = 0.75;

/**
 * The compaction tier's target budget: strictly below the trigger threshold.
 *
 * FNXC:ChatOverflowCompaction 2026-09-04-19:20:
 * RUFU-183 makes this ONE definition shared by tier 2's directive and tier 3's proof ceiling so the
 * two cannot drift. It derives from the EFFECTIVE threshold rather than the raw window: the
 * threshold is `min(tokenCap, hardLimit)`, and a target computed from the window alone can sit ABOVE
 * a small operator tokenCap — breaking the invariant this function exists to hold
 * (`target < threshold`). Deriving from the threshold keeps it true for every cap while staying
 * window-sourced, because the threshold itself is computed from the same window.
 *
 * Why strictly below matters: a reduction landing between target and threshold satisfies this send
 * but re-arms the next one, which is the loop the ladder exists to terminate. It is also what makes
 * tier 3 provable: the deterministic fallback is only given `target - staticFloor` message tokens,
 * so the rebuilt context ends under the target, not merely under the threshold.
 */
export function compactionTargetBudget(threshold: number): number {
  return Math.floor(threshold * COMPACTION_TARGET_FRACTION);
}

/**
 * Lowest active-entry index the tier-3 split may keep from, so it never re-projects the session's
 * live compaction.
 *
 * FNXC:ChatOverflowCompaction 2026-09-04-19:20:
 * `buildContextEntries()` projects the active context as
 * `[live compaction, entries kept from firstKeptEntryId up to it, entries appended after it]`, while
 * the leaf path runs in the opposite order for the middle group (they PRECEDE the compaction in
 * leaf order). Cutting inside that middle group would make the new compaction re-include the old one
 * and double-count it — the plan would promise more reduction than it delivers. The number of leaf
 * entries after the last compaction (`afterCount`) is therefore also the number of active entries
 * after it, so the first safe kept index is `activeEntryCount - afterCount`. No live compaction ⇒ 1
 * (the builder's own default). pi's `buildSessionPath` is not exported, so the leaf path is
 * reconstructed from the public `getEntries()` + `getLeafId()` by walking `parentId`; a malformed
 * parent chain is bounded by the `seen` set and degrades to 1, which the builder's turn-start search
 * still constrains.
 */
export function deterministicFallbackSplitFloor(
  manager: CompactionGateSessionManager,
  activeEntryCount: number,
): number {
  try {
    const all = manager.getEntries?.();
    if (!Array.isArray(all) || all.length === 0) return 1;
    const byId = new Map<string, SessionEntry>();
    for (const entry of all) {
      if (entry && typeof entry.id === "string") byId.set(entry.id, entry);
    }
    const leafId = manager.getLeafId?.() ?? null;
    const path: SessionEntry[] = [];
    const seen = new Set<string>();
    let current: SessionEntry | undefined = leafId ? byId.get(leafId) : all[all.length - 1];
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current);
      const parentId = (current as { parentId?: unknown }).parentId;
      current = typeof parentId === "string" ? byId.get(parentId) : undefined;
    }
    path.reverse();
    let lastCompaction = -1;
    for (let i = 0; i < path.length; i++) {
      if (path[i]!.type === "compaction") lastCompaction = i;
    }
    if (lastCompaction < 0) return 1;
    const afterCount = path.length - lastCompaction - 1;
    const floor = activeEntryCount - afterCount;
    if (!Number.isFinite(floor) || floor < 1) return 1;
    return floor;
  } catch {
    // A broken transcript reader must not turn a rescue attempt into a crash: degrade to the
    // builder's own default bound (supersession then relies on the builder's turn-start search).
    return 1;
  }
}

/**
 * Tier-2 escalation directive: an explicit target budget derived from the compaction
 * threshold (75% of it), so the summarizer is told to drop content rather than
 * re-summarize at the same granularity as the fallback directive. Must stay distinct
 * from pi's COMPACTION_FALLBACK_INSTRUCTIONS — asserting they differ is the
 * no-silent-no-op contract for the escalation tier.
 */
export function buildAggressiveCompactionDirective(threshold: number): string {
  const targetTokens = compactionTargetBudget(threshold);
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
/**
 * Provider-reported context usage for the session, or null when the provider reports none
 * (zero-usage providers per earendil-works/pi#8328) or the reader throws.
 */
function providerUsageTokens(session: CompactionGateSession): number | null {
  if (typeof session.getContextUsage !== "function") return null;
  try {
    const usage = session.getContextUsage();
    if (usage && typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens > 0) {
      return usage.tokens;
    }
  } catch {
    // A throwing usage reader must not break the send.
  }
  return null;
}

/**
 * Token estimate for a pending outbound prompt, for {@link CompactionGateOptions.pendingRequestTokens}.
 * Uses pi's own message estimator so the gate prices the new turn the same way it prices history.
 */
export function estimatePendingRequestTokens(prompt: string): number {
  try {
    return estimateTokens({ role: "user", content: prompt, timestamp: Date.now() });
  } catch {
    // An unestimable prompt counts as 0; the static floor still guards the send.
    return 0;
  }
}

export function estimateLoadedContextTokens(session: CompactionGateSession): number | null {
  const usage = providerUsageTokens(session);
  if (usage !== null) {
    return usage;
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
  /**
   * FNXC:ChatContextGuard 2026-09-16-12:40:
   * Tokens the caller intends to append after this gate returns (the pending user prompt).
   * A zero-usage provider reports only what is already loaded, so without this the guard could
   * clear a context for a request that still crosses the hard limit once the prompt is added.
   * Callers pass {@link estimatePendingRequestTokens} of the prompt they are about to send.
   */
  pendingRequestTokens?: number | null;
}

/** Result of a gate evaluation. */
export interface CompactionGateResult {
  /** Whether this gate call compacted the session. */
  compacted: boolean;
  /**
   * Estimated whole-request context tokens at the point the gate hands back: the pre-compaction
   * measurement on every non-compacting path; the floor-aware POST-compaction measurement when
   * tier 1/2 compaction succeeded or tier 3 truncated (null when unmeasurable).
   */
  contextTokens: number | null;
  /** Effective threshold used for the decision (null when unknown/unavailable). */
  threshold: number | null;
  /**
   * Set ONLY when the send was rescued by escalation tier 3 (deterministic truncation).
   *
   * FNXC:ChatOverflowCompaction 2026-09-04-19:20:
   * RUFU-183: the caller (dashboard chat send / room responder) persists this on the message it
   * saves, so the operator can see the engine truncated their context WITHOUT an LLM summary. The
   * run-audit row is not allowed to be the only trace: an invisible truncation is a silent content
   * loss, and "the summarizer was unavailable" cannot be inferred from the reply alone. Absent on
   * every other path (below threshold, tier 1/2 success, skip, refusal).
   */
  fallback?: Tier3RescueEvidence;
}

/**
 * What a tier-3 deterministic truncation removed and what it could not touch.
 *
 * FNXC:ChatOverflowCompaction 2026-09-04-22:26:
 * RUFU-183 review — one evidence shape serves BOTH the rescue (proof passed) and the refused
 * after-truncation case (proof failed), because Route A has no deletion primitive: once
 * `appendCompaction` lands, the shortening is durable and the refusal must describe the state
 * actually left behind, not the pre-truncation numbers. `contextTokensAfter` is the floor-aware
 * re-measurement after the rebuild (null when the rebuild could not be measured); the rescue
 * narrows it to a proven number.
 */
export interface Tier3TruncationEvidence {
  /** Active context entries the engine dropped (turns, tool results, prior summaries). */
  droppedMessageCount: number;
  /** Tokens removed, measured before-minus-after with the gate's own estimator (0 when unmeasurable). */
  droppedTokens: number;
  /** Static prompt/tool floor tokens that were not reducible and were excluded from the budget. */
  floorTokens: number;
  /** Floor-aware measurement of the rebuilt context; null when the rebuild could not be measured. */
  contextTokensAfter: number | null;
}

/** Tier-3 evidence whose floor-aware proof passed — the reduction is real and measured. */
export interface Tier3RescueEvidence extends Tier3TruncationEvidence {
  contextTokensAfter: number;
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
 * context reduction. Every arm that still ends in a refusal then gets escalation tier 3: one
 * deterministic (non-LLM) partial rewrite of the branch, allowed to run only where it can PROVE the
 * rebuilt context fits under the compaction target (RUFU-183) — incapable, static-floor-only, or
 * unproven sessions keep the refusal exactly as written. Every throw names its
 * {@link ChatContextOverflowReason}. The prompt is never sent on a refusal.
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

  /*
  FNXC:ChatContextGuard 2026-09-16-12:40:
  The gate prices the WHOLE outbound request, not just what the session already holds. Provider
  usage (when the provider reports any) already covers prompt, tool schemas and history, so it is
  used as-is plus the pending prompt. Without usage the measurement would otherwise count only
  loaded messages and omit the static floor (system prompt + active tool schemas), letting a 64K
  model send a request past its hard limit. The static floor is added exactly when usage is absent
  because a reported usage number already includes the static context.
  */
  const pendingRequestTokens = Math.max(0, options.pendingRequestTokens ?? 0);
  const providerUsage = providerUsageTokens(session);
  const loadedTokens = estimateLoadedContextTokens(session);
  const contextTokens =
    loadedTokens === null
      ? null
      : providerUsage === null
        ? loadedTokens + (staticContextFloorEstimate(session) ?? 0) + pendingRequestTokens
        : loadedTokens + pendingRequestTokens;
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
  LCM escalation ladder, tiers 1-2. compactSessionContext is total: it returns a
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
    /** Tier-3-only surface: what the deterministic truncation removed and what it could not touch. */
    droppedMessageCount?: number;
    droppedTokens?: number;
    floorTokens?: number;
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
        // Tier-3 extras stay absent from tiers 1-2 rows so the RUFU-182 payload shape is unchanged
        // for every pre-existing outcome; only a deterministic truncation names its removals.
        ...(fields.droppedMessageCount !== undefined
          ? { droppedMessageCount: fields.droppedMessageCount }
          : {}),
        ...(fields.droppedTokens !== undefined ? { droppedTokens: fields.droppedTokens } : {}),
        ...(fields.floorTokens !== undefined ? { floorTokens: fields.floorTokens } : {}),
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

  /*
  FNXC:ChatOverflowCompaction 2026-09-04-19:20:
  Escalation tier 3 (RUFU-183): the LLM-free fallback. Tiers 1-2 both depend on a summarizer
  round-trip, so saneca chat-b6a74d40 refused with the context at 221% of its hard limit — pi said
  "Already compacted" while a 110,034-token message list was still loaded, because pi compares
  message-only tokens against a 20 000-token keep-recent budget and never subtracts the static
  prompt/tool floor it must still send. A deterministic partial branch rewrite cannot fix that
  measurement (only pi owns it) but it CAN guarantee the outcome: the floor is constant, so cutting
  the message list to `compactionTarget - floor` provably lands the rebuilt context under target.

  Route A, mirroring pi's own compact() tail exactly — public `appendCompaction`, then
  `buildSessionContext()`, then the live-view assignment — so there is no private-pi back door and
  the durable transcript is re-read rather than assumed. pi's in-memory refresh is a direct
  `agent.state.messages =` write with no event or handler, so Route A installs the rebuilt list the
  same way; no pi event is replayed. Supersession is carried by the public `firstKeptEntryId`, which
  is why a `newSession` branch is not needed and not used.

  It runs AT MOST ONCE per send, never on a healthy send, never for `nothing-to-compact` (which is
  "too small", not "too big") and never when the outcome was produced. An attempt reports four
  outcomes (RUFU-183 review): `rescued` proves the reduction; `floor-dominated` means the static
  floor alone leaves no message budget, so the refusal re-attributes to `static-floor` — blaming
  pi's refusal there sends triage to retry compaction instead of trimming the tool set; a
  `truncated-unproven` attempt keeps the arm's reason but carries the truncation evidence, because
  Route A cannot un-append a durable compaction; `incapable` leaves the refusal arms byte-identical
  to RUFU-182 — a tier that cannot prove convergence is not allowed to trade the honest refusal
  for a weaker reduction.
  */
  const staticFloor = staticContextFloorEstimate(session);
  const compactionTarget = compactionTargetBudget(threshold);
  /**
   * The ONE tier-3 outcome per send. The four statuses are kept DISTINCT on purpose
   * (RUFU-183 review): floor-dominated refusals must re-attribute to `static-floor`, and
   * truncated-but-unproven refusals must carry the truncation evidence, while only an
   * incapable attempt leaves the arm's RUFU-182 shape byte-identical.
   */
  type Tier3Attempt =
    | { status: "incapable" }
    | { status: "floor-dominated"; floorTokens: number; target: number }
    | { status: "truncated-unproven"; evidence: Tier3TruncationEvidence }
    | { status: "rescued"; evidence: Tier3RescueEvidence };
  let fallbackRan = false;
  let fallbackAttempt: Tier3Attempt | null = null;

  /**
   * Attempt tier 3 once and report the typed outcome. Emits no audit row: every arm owns its
   * single row, which is what preserves RUFU-182's "exactly one row per gate invocation".
   */
  const runDeterministicFallback = async (): Promise<Tier3Attempt> => {
    if (fallbackRan && fallbackAttempt) return fallbackAttempt;
    fallbackRan = true;
    const settle = (attempt: Tier3Attempt): Tier3Attempt => {
      fallbackAttempt = attempt;
      return attempt;
    };
    const manager = session.sessionManager;
    // A session that does not expose the public compaction surface (fake, plugin runtime, older pi)
    // is NOT given a weaker reduction: it keeps today's refusal verbatim.
    const capable =
      !!manager &&
      typeof manager.buildContextEntries === "function" &&
      typeof manager.buildSessionContext === "function" &&
      typeof manager.appendCompaction === "function" &&
      typeof manager.getEntries === "function" &&
      typeof manager.getLeafId === "function";
    if (!capable || !session.state || typeof session.state !== "object") return settle({ status: "incapable" });
    if (staticFloor === null) {
      // Without the floor there is no honest floor-aware proof — and no measured domination to
      // blame either, so the arm's own attribution stays honest.
      return settle({ status: "incapable" });
    }
    const messageTokenBudget = compactionTarget - staticFloor;
    if (messageTokenBudget <= 0) {
      // The untouchable floor alone eats the target (the saneca class): the boundary IS the
      // static context, so the refusal must say `static-floor` with the floor named, not quote
      // pi's refusal — triage reading "retry compaction" would chase the wrong lever.
      return settle({ status: "floor-dominated", floorTokens: staticFloor, target: compactionTarget });
    }
    tiersAttempted.push("fallback");
    let appendedDroppedCount: number | null = null;
    try {
      const activeEntries = manager!.buildContextEntries!();
      if (!Array.isArray(activeEntries) || activeEntries.length < 2) return settle({ status: "incapable" });
      const plan = buildDeterministicFallbackCompaction({
        activeEntries,
        messageTokenBudget,
        tokensBefore: contextTokens,
        minSplitIndex: deterministicFallbackSplitFloor(manager!, activeEntries.length),
      });
      // No turn boundary makes the branch fit under the message budget. The floor left room
      // (budget > 0), so this is not floor domination — the arm's own reason stays honest.
      if (!plan) return settle({ status: "incapable" });
      manager!.appendCompaction!(
        plan.summary,
        plan.firstKeptEntryId,
        plan.tokensBefore,
        {
          deterministicFallback: true,
          droppedEntryCount: plan.droppedEntryCount,
          keptEntryCount: plan.keptEntryCount,
        },
        true,
        undefined,
      );
      // From this line on the branch IS shortened — Route A has no deletion primitive, so any
      // later failure must report the durable truncation instead of hiding it.
      appendedDroppedCount = plan.droppedEntryCount;
      // Re-read the durable transcript (never assume what was written) and install the rebuilt
      // active context into the live view — the same write pi's own compact() performs.
      const rebuilt = manager!.buildSessionContext!();
      if (!rebuilt || !Array.isArray(rebuilt.messages)) {
        return settle({
          status: "truncated-unproven",
          evidence: {
            droppedMessageCount: appendedDroppedCount,
            droppedTokens: 0,
            floorTokens: staticFloor,
            contextTokensAfter: null,
          },
        });
      }
      session.state.messages = rebuilt.messages;
      // Floor-aware proof, measured through the existing estimator (never a new token math).
      /*
      FNXC:ChatContextGuard 2026-09-16-15:45 (#3620 review — greptile P1 / coderabbit):
      The tier-3 proof must price the WHOLE next request. `freshLoadedContextEstimate` already
      covers the static prompt/tool floor; the messages-only fallback does not, so its floor is
      added when usage is absent — the same composition rule as the entry check. The pending
      prompt is always charged: a rescue that proved "under target" without it could still send
      an over-limit request — the deadlock this tier exists to end, re-opened by its own proof.
      */
      const t3Fresh = freshLoadedContextEstimate(session);
      const afterTokens = t3Fresh ?? estimateLoadedContextTokens(session);
      const afterRequestTokens = afterTokens === null
        ? null
        : afterTokens + pendingRequestTokens
          + (t3Fresh === null && providerUsageTokens(session) === null
            ? (staticContextFloorEstimate(session) ?? 0)
            : 0);
      const evidence: Tier3TruncationEvidence = {
        droppedMessageCount: plan.droppedEntryCount,
        // Unattributable (0) when the post-rebuild measurement failed; a fabricated guess would
        // overstate what the operator lost. Like-for-like: both sides price the whole request.
        droppedTokens: afterRequestTokens === null ? 0 : Math.max(0, contextTokens - afterRequestTokens),
        floorTokens: staticFloor,
        contextTokensAfter: afterRequestTokens,
      };
      if (afterRequestTokens === null || afterRequestTokens >= compactionTarget) {
        // The proof rejected the reduction, but the truncation stands on disk — the refusal
        // must describe the shortened state actually left behind, not the pre-truncation numbers.
        return settle({ status: "truncated-unproven", evidence });
      }
      if (afterRequestTokens >= threshold) {
        // Unreachable while target <= threshold; the guard's estimator is not the proof's
        // contract, so fail loud rather than send. The truncation still happened.
        piLog.warn(
          `chat-context-guard: deterministic fallback truncated to ${afterRequestTokens} tokens but the floor-aware re-measurement still exceeds the ${threshold}-token threshold; refusing to send`,
        );
        return settle({ status: "truncated-unproven", evidence });
      }
      return settle({ status: "rescued", evidence: evidence as Tier3RescueEvidence });
    } catch {
      // A broken transcript is not a reason to crash the gate. If the append already landed,
      // though, the shortening is durable — report it rather than fall back silently.
      if (appendedDroppedCount !== null) {
        return settle({
          status: "truncated-unproven",
          evidence: {
            droppedMessageCount: appendedDroppedCount,
            droppedTokens: 0,
            floorTokens: staticFloor,
            contextTokensAfter: null,
          },
        });
      }
      return settle({ status: "incapable" });
    }
  };

  /**
   * The refusal attribution a tier-3 attempt dictates for the arm that called it.
   *
   * FNXC:ChatOverflowCompaction 2026-09-04-22:26:
   * RUFU-183 review — an `incapable` overlay is empty so untouched arms stay byte-identical to
   * RUFU-182; `floor-dominated` rewrites the reason to `static-floor` (the triage-relevant fact
   * is "reduce the tool set / larger window", not "retry compaction"); `truncated-unproven`
   * keeps the arm's reason but replaces the arm's pre-truncation measurement with the honest
   * post-rebuild number and names the shortening — the persisted row and message must describe
   * the state the session is actually in, because the truncation cannot be rolled back.
   */
  interface Tier3RefusalOverlay {
    /** Replaces the arm's reason when tier 3 proved a different boundary (static-floor). */
    reason: ChatContextOverflowReason | null;
    /** Honest post-tier-3 measurement; `undefined` = keep the arm's own number. */
    afterTokens: number | null | undefined;
    /** Audit metadata present only when tier 3 acted; empty spreads keep rows unchanged. */
    auditExtras: { droppedMessageCount?: number; droppedTokens?: number; floorTokens?: number };
    /** Same evidence for the error details (bare `floorTokens` or a nested `tier3` object). */
    detailExtras: Record<string, unknown>;
    /** Sentence appended before "; the prompt was not sent". */
    suffix: string;
  }
  const tier3RefusalOverlay = (attempt: Tier3Attempt): Tier3RefusalOverlay => {
    if (attempt.status === "floor-dominated") {
      return {
        reason: "static-floor",
        afterTokens: undefined,
        auditExtras: { droppedMessageCount: 0, droppedTokens: 0, floorTokens: attempt.floorTokens },
        detailExtras: { floorTokens: attempt.floorTokens },
        suffix: `; the deterministic fallback was refused because the static context floor of ${attempt.floorTokens} tokens already exceeds the ${attempt.target}-token compaction target — the floor IS the boundary; reduce the agent's tools/memory or use a larger-window model`,
      };
    }
    if (attempt.status === "truncated-unproven") {
      const ev = attempt.evidence;
      return {
        reason: null,
        afterTokens: ev.contextTokensAfter,
        auditExtras: {
          droppedMessageCount: ev.droppedMessageCount,
          droppedTokens: ev.droppedTokens,
          floorTokens: ev.floorTokens,
        },
        detailExtras: { tier3: ev },
        suffix: `; the deterministic fallback truncated ${ev.droppedMessageCount} messages but ${
          ev.contextTokensAfter === null
            ? "the floor-aware re-measurement is unavailable"
            : `the floor-aware re-measurement is ${ev.contextTokensAfter} tokens, not proven under the ${compactionTarget}-token compaction target`
        } — the branch IS shortened on disk while this refusal stands`,
      };
    }
    return { reason: null, afterTokens: undefined, auditExtras: {}, detailExtras: {}, suffix: "" };
  };
  /** Overlay-aware number pick: `??` would wrongly fall through a deliberate null. */
  const reportedTokens = (overlay: Tier3RefusalOverlay, armValue: number | null): number | null =>
    overlay.afterTokens === undefined ? armValue : overlay.afterTokens;

  /** The single audit row + result for a tier-3 rescue; arms call this instead of duplicating it. */
  const finishFallback = async (
    rescued: Tier3RescueEvidence,
  ): Promise<CompactionGateResult> => {
    piLog.warn(
      `chat-context-guard: escalation tier 3 truncated the context deterministically (no LLM summary) — ${rescued.droppedMessageCount} entries dropped, ${contextTokens} -> ${rescued.contextTokensAfter} tokens (target ${compactionTarget}, static floor ${rescued.floorTokens})`,
    );
    await emitAudit({
      tier: "fallback",
      tiersAttempted,
      reason: null,
      outcome: "compacted",
      afterTokens: rescued.contextTokensAfter,
      retrySkippedReason: "not-needed",
      droppedMessageCount: rescued.droppedMessageCount,
      droppedTokens: rescued.droppedTokens,
      floorTokens: rescued.floorTokens,
    });
    return { compacted: true, contextTokens: rescued.contextTokensAfter, threshold, fallback: rescued };
  };

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
    /*
    FNXC:ChatOverflowCompaction 2026-09-04-19:20:
    Tier 3 deliberately does NOT hook this arm: with no compaction capability there is no branch to
    truncate at all, so "cannot reduce" is honest and the refusal stays exactly as RUFU-182 wrote it.
    */
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
    /*
    FNXC:ChatContextGuard 2026-09-16-15:45 (#3620 review — greptile P1 / coderabbit):
    "Proceeding because the current context fits" must price the WHOLE next request — the
    pending prompt included — or a stale-usage "recovery" sends an over-limit request. The
    measurement label follows the composition so the operator sees what was priced.
    */
    const freshRequestTokens = freshTokens === null ? null : freshTokens + pendingRequestTokens;
    const freshLabel = pendingRequestTokens > 0
      ? "the whole next request (prompt + tools + messages + pending prompt)"
      : "fresh measurement of the current prompt + tools + messages";
    if (freshRequestTokens !== null && freshRequestTokens < threshold) {
      piLog.log(
        `chat-context-guard: recorded context ${contextTokens} tokens is stale — ${freshLabel} is ${freshRequestTokens} tokens (< threshold ${threshold}); the session's static context changed since the usage was recorded. Proceeding with the current context.`,
      );
      await emitAudit({
        tier,
        tiersAttempted,
        reason: outcome.reason,
        outcome: "proceeded-without-reduction",
        afterTokens: freshRequestTokens,
        retrySkippedReason: "pi-refuses-second-compaction",
      });
      return { compacted: false, contextTokens: freshRequestTokens, threshold };
    }
    /*
    FNXC:ChatOverflowCompaction 2026-09-04-19:20:
    Tier 3 hooks this arm for `already-compacted` ONLY. `nothing-to-compact` means "too small to
    compact", not "too big to send": truncating a branch pi just declared too small would reduce a
    context that never needed reduction, and RUFU-182's reading of that refusal is "an over-imposed
    static floor, not oversized history" — which a branch rewrite cannot fix either.
    */
    const attempt: Tier3Attempt =
      outcome.reason === "already-compacted" ? await runDeterministicFallback() : { status: "incapable" };
    if (attempt.status === "rescued") return finishFallback(attempt.evidence);
    const refusal = tier3RefusalOverlay(attempt);
    const refusalReason: ChatContextOverflowReason = refusal.reason ?? outcome.reason;
    const reportedFreshTokens = reportedTokens(refusal, freshRequestTokens);
    await emitAudit({
      tier,
      tiersAttempted,
      reason: refusalReason,
      outcome: "refused",
      afterTokens: reportedFreshTokens,
      retrySkippedReason: "pi-refuses-second-compaction",
      ...refusal.auditExtras,
    });
    throw new ChatContextOverflowError(
      `Pre-overflow compaction was refused by the session engine (reason=${refusalReason}, tiers attempted: ${tiersAttempted.join(", ")}): pi: "${outcome.engineMessage ?? outcome.reason}" — this refusal is absolute, a larger compaction directive cannot unlock it; measured ${contextTokens} tokens >= threshold ${threshold}${hardLimit !== null ? `, hard limit ${hardLimit}` : ""}${reportedFreshTokens !== null ? `, ${freshLabel} is ${reportedFreshTokens} tokens${reportedFreshTokens >= threshold ? " — reduce the agent's tools/memory or use a larger-window model" : ""}` : "; the fresh measurement is unavailable"}${refusal.suffix}; the prompt was not sent`,
      refusalDetails(refusalReason, {
        freshTokens: reportedFreshTokens,
        engineMessage: outcome.engineMessage,
        ...refusal.detailExtras,
      }),
    );
  }

  if (outcome.reason === "error") {
    const attempt = await runDeterministicFallback();
    if (attempt.status === "rescued") return finishFallback(attempt.evidence);
    // Reaching this arm means the tier-1 error escalated and the single legal retry
    // also errored — the retry was attempted, so it was never "skipped".
    const refusal = tier3RefusalOverlay(attempt);
    const refusalReason: ChatContextOverflowReason = refusal.reason ?? "compaction-error";
    await emitAudit({
      tier,
      tiersAttempted,
      reason: refusalReason,
      outcome: "refused",
      afterTokens: reportedTokens(refusal, null),
      retrySkippedReason: "not-needed",
      ...refusal.auditExtras,
    });
    const engineMessage = outcome.engineMessage ?? "unknown engine error";
    throw new ChatContextOverflowError(
      `Pre-overflow compaction failed (reason=${refusalReason}, tiers attempted: ${tiersAttempted.join(", ")}): ${engineMessage} — measured ${contextTokens} tokens >= threshold ${threshold}${hardLimit !== null ? `, hard limit ${hardLimit}` : ""}${refusal.suffix}; the prompt was not sent`,
      refusalDetails(refusalReason, { engineMessage, ...refusal.detailExtras }),
      new Error(engineMessage),
    );
  }

  // outcome.reason is now "compacted" | "no-progress": the branch is mutated; the strict
  // acceptance rule decides. A `no-progress` outcome (RUFU-187) is a MEASURED non-reduction by
  // construction, so it normalizes into the SAME not-accepted/escalation branch a `compacted`
  // outcome with `reduced:false` already takes — the guard must not invent a second refusal shape
  // for the same operator-visible fact.
  if (outcome.reason === "compacted" && outcome.summary.trim().length === 0) {
    const attempt = await runDeterministicFallback();
    if (attempt.status === "rescued") return finishFallback(attempt.evidence);
    const refusal = tier3RefusalOverlay(attempt);
    const refusalReason: ChatContextOverflowReason = refusal.reason ?? "empty-summary";
    await emitAudit({
      tier,
      tiersAttempted,
      reason: refusalReason,
      outcome: "refused",
      afterTokens: reportedTokens(refusal, null),
      retrySkippedReason: "branch-already-mutated",
      ...refusal.auditExtras,
    });
    throw new ChatContextOverflowError(
      `Pre-overflow compaction returned an empty summary (reason=${refusalReason}, tiers attempted: ${tiersAttempted.join(", ")}): the branch was mutated but nothing usable was produced for a ${contextTokens}-token context (threshold ${threshold})${refusal.suffix}; the prompt was not sent`,
      refusalDetails(refusalReason, { tokensBefore: outcome.tokensBefore, ...refusal.detailExtras }),
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
  /*
  FNXC:ChatContextGuard 2026-09-16-15:45 (#3620 review — greptile P1 / coderabbit):
  The post-compaction acceptance check must price the WHOLE outbound request, not just the
  compacted messages. Provider usage is stale after compaction (it describes the pre-compaction
  request), so when usage was absent at entry the static floor is added exactly like at entry;
  the pending prompt is added unconditionally. Without this, a compacted session below the hard
  limit on messages alone could still send a request over the limit — the overflow the gate
  exists to prevent, arriving one statement later.
  */
  const afterUsage = providerUsageTokens(session);
  const afterRequestTokens = afterTokens === null
    ? null
    : afterTokens + (afterUsage === null ? (staticContextFloorEstimate(session) ?? 0) : 0) + pendingRequestTokens;
  const overLimit = afterRequestTokens !== null && afterRequestTokens >= bounds.hardLimit;

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
      const attempt = await runDeterministicFallback();
      if (attempt.status === "rescued") return finishFallback(attempt.evidence);
      const refusal = tier3RefusalOverlay(attempt);
      const refusalReason: ChatContextOverflowReason = refusal.reason ?? "non-reducing-summary";
      const reportedAfterTokens = reportedTokens(refusal, afterRequestTokens);
      await emitAudit({
        tier,
        tiersAttempted,
        reason: refusalReason,
        outcome: "refused",
        afterTokens: reportedAfterTokens,
        retrySkippedReason: "branch-already-mutated",
        ...refusal.auditExtras,
      });
      throw new ChatContextOverflowError(
        `Pre-overflow compaction produced a summary that did not reduce the context (reason=${refusalReason}, tiers attempted: ${tiersAttempted.join(", ")}): ${reportedAfterTokens} tokens priced for the next request vs the ${bounds.hardLimit} hard limit (threshold ${threshold}, contextWindow ${contextWindow ?? "unknown"})${refusal.suffix}; the prompt was not sent`,
        refusalDetails(refusalReason, {
          afterTokens: reportedAfterTokens,
          tokensBefore: outcome.tokensBefore,
          estimatedTokensAfter: measuredAfterTokens,
          stage: "post-compaction",
          ...refusal.detailExtras,
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
      const attempt = await runDeterministicFallback();
      if (attempt.status === "rescued") return finishFallback(attempt.evidence);
      const refusal = tier3RefusalOverlay(attempt);
      // The outcome enum stays measurement-unknown even on a throw (RUFU-182): the honest
      // statement is "we could not observe what compaction did", whichever boundary hit.
      const refusalReason: ChatContextOverflowReason = refusal.reason ?? "post-compaction-over-limit";
      const reportedAfterTokens = reportedTokens(refusal, afterRequestTokens);
      await emitAudit({
        tier,
        tiersAttempted,
        reason: refusalReason,
        outcome: "measurement-unknown",
        afterTokens: reportedAfterTokens,
        retrySkippedReason: "branch-already-mutated",
        ...refusal.auditExtras,
      });
      throw new ChatContextOverflowError(
        `Context measurement after compaction is unvalidated and the guard's own estimate is ${reportedAfterTokens} tokens, at or above the ${bounds.hardLimit} hard limit (reason=${refusalReason}, tiers attempted: ${tiersAttempted.join(", ")}, threshold ${threshold}, contextWindow ${contextWindow ?? "unknown"})${refusal.suffix}; the prompt was not sent`,
        refusalDetails(refusalReason, {
          afterTokens: reportedAfterTokens,
          hardLimit: bounds.hardLimit,
          stage: "post-compaction",
          ...refusal.detailExtras,
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
    const attempt = await runDeterministicFallback();
    if (attempt.status === "rescued") return finishFallback(attempt.evidence);
    const refusal = tier3RefusalOverlay(attempt);
    const refusalReason: ChatContextOverflowReason = refusal.reason ?? "post-compaction-over-limit";
    const reportedAfterTokens = reportedTokens(refusal, afterRequestTokens);
    await emitAudit({
      tier,
      tiersAttempted,
      reason: refusalReason,
      outcome: "refused",
      afterTokens: reportedAfterTokens,
      retrySkippedReason: "branch-already-mutated",
      ...refusal.auditExtras,
    });
    throw new ChatContextOverflowError(
      `Context is still ${reportedAfterTokens} tokens after compaction (reason=${refusalReason}, tiers attempted: ${tiersAttempted.join(", ")}, hard limit ${bounds.hardLimit}, contextWindow ${contextWindow ?? "unknown"})${refusal.suffix}; the prompt was not sent`,
      refusalDetails(refusalReason, {
        afterTokens: reportedAfterTokens,
        hardLimit: bounds.hardLimit,
        stage: "post-compaction",
        ...refusal.detailExtras,
      }),
    );
  }

  if (afterTokens === null) {
    piLog.warn("chat-context-guard: post-compaction measurement unknown — proceeding after a successful compaction");
  }
  /*
  FNXC:ChatContextGuard 2026-09-17-05:46 (#3626 review — greptile P1):
  The compacted-success row must price the SAME quantity every other row prices: the whole outbound
  request. The old code audited the message-only `afterTokens` and returned the PRE-compaction
  `contextTokens`, so a provider without usage lost the static floor and pending prompt from the
  audit (apples-to-oranges against the entry row, which IS floor-aware), and callers received the
  stale oversized count. This also made the result contract diverge from tier 3, whose
  finishFallback returns the post-truncation `contextTokensAfter`.
  */
  await emitAudit({
    tier,
    tiersAttempted,
    reason: null,
    outcome: "compacted",
    afterTokens: afterRequestTokens,
    retrySkippedReason: "not-needed",
  });
  return { compacted: true, contextTokens: afterRequestTokens, threshold };
}
