/**
 * RUFU-118 phase 1: deterministic pre-overflow compaction gate — unit tests.
 *
 * Covers the threshold math (exact spec values), the loaded-context estimator
 * (usage-first with chars/4 fallback, the zero-provider-usage blind spot), and the
 * gate seam contract (compact-before-prompt at threshold, fail-loud on compaction
 * failure, post-compaction still-over hard limit, non-pi shape skip, small-context
 * no-op). Deterministic in-memory fakes only — no real LLM or network calls.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ChatContextOverflowError,
  computeCompactionThreshold,
  estimateLoadedContextTokens,
  ensureContextWithinCompactionThreshold,
  freshLoadedContextEstimate,
  type CompactionGateSession,
} from "../chat-context-guard.js";

/**
 * Build a fake pi-shaped session.
 *
 * - `usage`: the value `getContextUsage()` initially returns; `"undefined"` simulates a
 *   session with no model / zero context window; `"throw"` simulates a throwing reader.
 *   The live value lives in `usageState.current` so a fake `compact` can model pi's
 *   post-compaction shape (no assistant message with non-zero usage after the summary
 *   → `tokens: null`).
 * - `compactImpl`: replaces `session.compact`; the default succeeds with a small summary.
 * - `withPiShape: false` omits `getContextUsage` entirely (plugin CLI runtime shape).
 * - `withState: false` omits `state` entirely (no loaded-message list to measure).
 */
function makeFakePiSession(opts: {
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  usage?: { tokens: number | null; contextWindow: number; percent: number | null } | "undefined" | "throw";
  messages?: unknown[];
  compactImpl?: (instructions?: string) => unknown | Promise<unknown>;
  withPiShape?: boolean;
  withState?: boolean;
  /** The session's current final system prompt (pi getter) for the fresh cross-check. */
  systemPrompt?: string;
  /** pi's active tool names. */
  activeToolNames?: string[];
  /** pi's configured tool definitions. */
  allTools?: Array<{ name?: string; description?: string; parameters?: unknown }>;
}): {
  session: CompactionGateSession;
  compact: ReturnType<typeof vi.fn>;
  usageState: { current: { tokens: number | null; contextWindow: number; percent: number | null } | undefined; throwing: boolean };
} {
  const usageState: {
    current: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
    throwing: boolean;
  } = {
    current: opts.usage === "undefined" || opts.usage === "throw" ? undefined : opts.usage,
    throwing: opts.usage === "throw",
  };
  const compact = vi.fn(opts.compactImpl ?? (async () => ({ summary: "s", tokensBefore: 1 })));
  const session: Record<string, unknown> = {
    model: {
      contextWindow: opts.contextWindow ?? 128000,
      maxTokens: opts.maxTokens ?? 16384,
    },
    compact,
  };
  if (opts.withState !== false) {
    session.state = { messages: opts.messages ?? [] };
  }
  if (opts.withPiShape !== false) {
    session.getContextUsage = () => {
      if (usageState.throwing) {
        throw new Error("usage reader failed");
      }
      return usageState.current;
    };
  }
  if (opts.systemPrompt !== undefined) {
    session.systemPrompt = opts.systemPrompt;
  }
  if (opts.activeToolNames !== undefined) {
    session.getActiveToolNames = () => opts.activeToolNames!;
  }
  if (opts.allTools !== undefined) {
    session.getAllTools = () => opts.allTools!;
  }
  return { session: session as unknown as CompactionGateSession, compact, usageState };
}

/** N chars of user content estimate to exactly N/4 tokens (chars/4, ceiled). */
function userMessageOf(chars: number): unknown {
  return { role: "user", content: "a".repeat(chars) };
}

/**
 * Compact the fake session down to a small compaction summary, as real pi does: replace
 * the loaded messages with a compactionSummary and move the usage reader to pi's
 * post-compaction shape (null tokens — no post-compaction assistant usage yet).
 */
function compactToSummary(
  session: CompactionGateSession,
  usageState: { current: { tokens: number | null; contextWindow: number; percent: number | null } | undefined; throwing: boolean },
  summaryChars: number,
  tokensBefore: number,
): { summary: string; tokensBefore: number } {
  (session.state as { messages: unknown[] }).messages = [
    { role: "compactionSummary", summary: "s".repeat(summaryChars) },
  ];
  if (usageState.current !== undefined) {
    usageState.current = { tokens: null, contextWindow: usageState.current.contextWindow, percent: null };
  }
  return { summary: "summary", tokensBefore };
}

/** Run the gate once and capture the rejection (null on resolve). */
async function captureGateError(
  session: CompactionGateSession,
  options: { tokenCap?: number | null },
): Promise<ChatContextOverflowError | null> {
  try {
    await ensureContextWithinCompactionThreshold(session, options);
    return null;
  } catch (err) {
    return err as ChatContextOverflowError;
  }
}

describe("computeCompactionThreshold", () => {
  it("yields exactly 102400 for a 128K window with no tokenCap", () => {
    // min(round(0.8 * 128000), 128000 - 16384) = min(102400, 111616) = 102400
    expect(computeCompactionThreshold({ contextWindow: 128000, maxTokens: 16384, tokenCap: undefined })).toBe(102400);
  });

  it("applies tokenCap as a lower upper bound", () => {
    expect(computeCompactionThreshold({ contextWindow: 128000, maxTokens: 16384, tokenCap: 50000 })).toBe(50000);
  });

  it("clamps tokenCap above the hard limit to the hard limit", () => {
    // tokenCap 130000 > hardLimit 111616 → clamped
    expect(computeCompactionThreshold({ contextWindow: 128000, maxTokens: 16384, tokenCap: 130000 })).toBe(111616);
  });

  it("uses the model maxTokens as the reserve when it exceeds the 16384 floor", () => {
    // 32K window, maxTokens 20000 → hardLimit 12000; cap round(0.8*32000)=25600 → 12000
    expect(computeCompactionThreshold({ contextWindow: 32000, maxTokens: 20000, tokenCap: undefined })).toBe(12000);
  });

  it("keeps the 16384 reserve floor when maxTokens is smaller", () => {
    // 32K window, maxTokens 8000 → reserve 16384 → hardLimit 15616 beats cap 25600
    expect(computeCompactionThreshold({ contextWindow: 32000, maxTokens: 8000, tokenCap: undefined })).toBe(15616);
  });

  it("returns null when the context window is unknown", () => {
    expect(computeCompactionThreshold({ contextWindow: undefined, maxTokens: 16384 })).toBeNull();
    expect(computeCompactionThreshold({ contextWindow: 0, maxTokens: 16384 })).toBeNull();
    expect(computeCompactionThreshold({ contextWindow: -1, maxTokens: 16384 })).toBeNull();
  });

  /*
  FNXC:ChatContextGuard 2026-08-20-22:27: RUFU-145 PR #3493 review (safe small-window
  threshold): a reserve that cannot fit inside the window no longer yields null — the
  reserve is capped at half the window so small-window models get a usable threshold.
  */
  it("caps the reserve at half the window when the reserve cannot fit (safe small-window threshold)", () => {
    // 16K window with the 16384 floor: reserve 16384 >= 16000 → cap to floor(16000*0.5)=8000
    // → hard limit 8000 → threshold min(12800, 8000) = 8000.
    expect(computeCompactionThreshold({ contextWindow: 16000, maxTokens: 16384 })).toBe(8000);
    // The review fixture: an 8K probe window with no maxTokens (engine defaults to 16384)
    // used to compute min(6554, 8192-16384) = -8192; now: reserve cap floor(8192*0.5)=4096
    // → threshold min(6554, 4096) = 4096 — a usable gate instead of a permanently failing one.
    expect(computeCompactionThreshold({ contextWindow: 8192 })).toBe(4096);
    // An explicit small maxTokens that still cannot beat the 16384 floor: the floor wins,
    // the cap applies, same 4096.
    expect(computeCompactionThreshold({ contextWindow: 8192, maxTokens: 4000 })).toBe(4096);
    // A window that barely fits the reserve is unchanged: 20K/16384 → hard limit 3616.
    expect(computeCompactionThreshold({ contextWindow: 20000, maxTokens: 16384 })).toBe(3616);
  });

  it("treats degenerate tokenCap values (0, negative, NaN) as unset", () => {
    expect(computeCompactionThreshold({ contextWindow: 128000, maxTokens: 16384, tokenCap: 0 })).toBe(102400);
    expect(computeCompactionThreshold({ contextWindow: 128000, maxTokens: 16384, tokenCap: -5 })).toBe(102400);
    expect(computeCompactionThreshold({ contextWindow: 128000, maxTokens: 16384, tokenCap: NaN })).toBe(102400);
  });
});

describe("estimateLoadedContextTokens", () => {
  it("prefers the getContextUsage token count when it is concrete", () => {
    const { session } = makeFakePiSession({
      usage: { tokens: 12345, contextWindow: 128000, percent: 9.6 },
      messages: [userMessageOf(100000)],
    });
    expect(estimateLoadedContextTokens(session)).toBe(12345);
  });

  it("falls back to the chars/4 message sum when usage tokens are null", () => {
    // user 8000 chars → 2000 tokens; assistant text 4000 chars → 1000 tokens
    const { session } = makeFakePiSession({
      usage: { tokens: null, contextWindow: 128000, percent: null },
      messages: [
        userMessageOf(8000),
        { role: "assistant", content: [{ type: "text", text: "b".repeat(4000) }] },
      ],
    });
    expect(estimateLoadedContextTokens(session)).toBe(3000);
  });

  it("falls back to the chars/4 message sum when getContextUsage is undefined", () => {
    const { session } = makeFakePiSession({ usage: "undefined", messages: [userMessageOf(4000)] });
    expect(estimateLoadedContextTokens(session)).toBe(1000);
  });

  it("sums messages even without a pi-shaped usage reader", () => {
    const { session } = makeFakePiSession({ withPiShape: false, messages: [userMessageOf(4000)] });
    expect(estimateLoadedContextTokens(session)).toBe(1000);
  });

  it("returns null when neither usage nor a message list are available", () => {
    const { session } = makeFakePiSession({ usage: "undefined", withState: false });
    expect(estimateLoadedContextTokens(session)).toBeNull();
  });

  it("measures an empty loaded message list as zero tokens", () => {
    const { session } = makeFakePiSession({ usage: "undefined" });
    expect(estimateLoadedContextTokens(session)).toBe(0);
  });

  it("survives a throwing usage reader by falling back to the message sum", () => {
    const { session } = makeFakePiSession({ usage: "throw", messages: [userMessageOf(4000)] });
    expect(estimateLoadedContextTokens(session)).toBe(1000);
  });

  it("counts malformed messages as zero instead of throwing", () => {
    const { session } = makeFakePiSession({
      usage: "undefined",
      messages: [userMessageOf(4000), { role: "assistant", content: undefined }],
    });
    expect(estimateLoadedContextTokens(session)).toBe(1000);
  });
});

describe("freshLoadedContextEstimate", () => {
  it("returns null when the session does not expose a non-empty system prompt", () => {
    const { session } = makeFakePiSession({ usage: { tokens: 1, contextWindow: 128000, percent: 0 } });
    expect(freshLoadedContextEstimate(session)).toBeNull();
    const { session: empty } = makeFakePiSession({
      usage: { tokens: 1, contextWindow: 128000, percent: 0 },
      systemPrompt: "",
    });
    expect(freshLoadedContextEstimate(empty)).toBeNull();
  });

  it("measures the system prompt in chars/3.5 plus the loaded messages", () => {
    const { session } = makeFakePiSession({
      usage: { tokens: 1, contextWindow: 128000, percent: 0 },
      systemPrompt: "p".repeat(35_000),
      messages: [userMessageOf(4000)],
    });
    // 35000/3.5 = 10000 + 4000/4 = 1000 → 11000
    expect(freshLoadedContextEstimate(session)).toBe(11_000);
  });

  it("counts only the active tools' schemas, not the full registry", () => {
    const { session } = makeFakePiSession({
      usage: { tokens: 1, contextWindow: 128000, percent: 0 },
      systemPrompt: "p".repeat(3_500), // 1000 tokens
      activeToolNames: ["a"],
      allTools: [
        { name: "a", description: "a".repeat(3_400), parameters: { x: 1 } }, // ~3400 chars ≈ 971 tokens
        { name: "b", description: "b".repeat(3_400), parameters: { y: 1 } }, // inactive → excluded
      ],
    });
    const withActive = freshLoadedContextEstimate(session) ?? 0;
    // Sanity: the active-only measurement is strictly smaller than counting both tools.
    const { session: bothActive } = makeFakePiSession({
      usage: { tokens: 1, contextWindow: 128000, percent: 0 },
      systemPrompt: "p".repeat(3_500),
      activeToolNames: ["a", "b"],
      allTools: [
        { name: "a", description: "a".repeat(3_400), parameters: { x: 1 } },
        { name: "b", description: "b".repeat(3_400), parameters: { y: 1 } },
      ],
    });
    const withBoth = freshLoadedContextEstimate(bothActive) ?? 0;
    expect(withBoth).toBeGreaterThan(withActive);
  });

  it("degrades to the prompt-only estimate when tool introspection throws", () => {
    const session = {
      model: { contextWindow: 128000, maxTokens: 16384 },
      systemPrompt: "p".repeat(3_500),
      getActiveToolNames: () => {
        throw new Error("registry unavailable");
      },
    } as unknown as CompactionGateSession;
    expect(freshLoadedContextEstimate(session)).toBe(1000);
  });
});

describe("ensureContextWithinCompactionThreshold", () => {
  it("does not compact below the threshold (small-context no-op)", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 50000, contextWindow: 128000, percent: 39.1 },
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result).toEqual({ compacted: false, contextTokens: 50000, threshold: 102400 });
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not compact in a small window below its (hard-limit-clamped) threshold", async () => {
    // 32K window → threshold 12000 (hard limit)
    const { session, compact } = makeFakePiSession({
      contextWindow: 32000,
      maxTokens: 20000,
      usage: { tokens: 8000, contextWindow: 32000, percent: 25 },
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result).toEqual({ compacted: false, contextTokens: 8000, threshold: 12000 });
    expect(compact).not.toHaveBeenCalled();
  });

  it("compacts exactly once at the threshold and returns compacted", async () => {
    const { session, compact, usageState } = makeFakePiSession({
      usage: { tokens: 102400, contextWindow: 128000, percent: 80 },
      compactImpl: async () => compactToSummary(session, usageState, 2000, 102400),
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(true);
    expect(result.contextTokens).toBe(102400);
    expect(result.threshold).toBe(102400);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:ChatContextGuard 2026-08-19-15:05:
  RUFU-118: operator opt-out — enabled: false no-ops the gate even when the loaded
  context is above the threshold (no measurement, no compaction, no throw). The gate
  is a selectable feature (Settings.chatPreOverflowCompactionEnabled), on by default.
  */
  it("no-ops (no compact, no throw) when explicitly disabled, even above threshold", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
    });
    const result = await ensureContextWithinCompactionThreshold(session, {
      tokenCap: undefined,
      enabled: false,
    });
    expect(result).toEqual({ compacted: false, contextTokens: null, threshold: null });
    expect(compact).not.toHaveBeenCalled();
  });

  it("still compacts when enabled: true is passed explicitly (default-on opt-out)", async () => {
    const { session, compact, usageState } = makeFakePiSession({
      usage: { tokens: 102400, contextWindow: 128000, percent: 80 },
      compactImpl: async () => compactToSummary(session, usageState, 2000, 102400),
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined, enabled: true });
    expect(result.compacted).toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("compacts when the loaded context is above the threshold and fits after compaction", async () => {
    const { session, compact, usageState } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      compactImpl: async () => compactToSummary(session, usageState, 4000, 120000),
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("throws ChatContextOverflowError when the post-compaction estimate is still at/above the hard limit", async () => {
    // 124000 tokens loaded → compact "succeeds" but the context is still ~116000
    // tokens (>= 111616 hard limit) → fail loud; never send an over-window call.
    const { session, compact, usageState } = makeFakePiSession({
      usage: { tokens: 124000, contextWindow: 128000, percent: 96.9 },
      compactImpl: async () => {
        // The "compacted" remainder still estimates to 464000 chars / 4 = 116000
        // tokens >= the 111616 hard limit; post-compaction usage is null so the
        // gate re-measures via the message sum.
        (session.state as { messages: unknown[] }).messages = [userMessageOf(464000)];
        usageState.current = { tokens: null, contextWindow: 128000, percent: null };
        return { summary: "summary", tokensBefore: 124000 };
      },
    });
    const err = await captureGateError(session, { tokenCap: undefined });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(err?.retryable).toBe(false);
    expect(compact).toHaveBeenCalledTimes(1); // exactly one compaction attempt — no loop
  });

  it("throws ChatContextOverflowError when compaction returns no result", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      compactImpl: async () => undefined, // session.compact() produced nothing
    });
    const err = await captureGateError(session, { tokenCap: undefined });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(err?.retryable).toBe(false);
    expect(err?.cause?.message).toContain("no compaction result");
    expect(compact).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:ChatContextGuard 2026-08-20-12:20:
  Stale-usage cross-check (RUFU-135 follow-up): the provider-reported usage is
  restored from the session file and describes the static context of the turn that
  RECORDED it. After a deploy that shrank the chat prompt/toolset the live context
  is far smaller than the recorded number — the gate must detect that via a fresh
  measurement of the current prompt + tools + messages and proceed instead of
  dead-ending every send with ChatContextOverflowError.
  */
  it("proceeds WITHOUT compacting when the fresh measurement fits (stale recorded usage, cross-check runs before compaction)", async () => {
    // Recorded usage says 120K (>= threshold 102400) but the session's CURRENT
    // prompt is small (~100K chars ≈ 28.5K tokens fresh) → the usage is stale.
    /*
    FNXC:ChatContextGuard 2026-08-20-22:27: RUFU-145 PR #3493 review: the cross-check
    moved before compaction — the gate now detects the stale usage up front and skips
    the compaction round-trip entirely (previously it compacted first and only caught
    the stale number in the "no compaction result" branch).
    */
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      compactImpl: async () => undefined, // nothing to compact (small branch)
      systemPrompt: "p".repeat(100_000),
      activeToolNames: ["fn_task_list"],
      allTools: [{ name: "fn_task_list", description: "list", parameters: { type: "object" } }],
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    // No throw; reported as a fresh (non-compacted) measurement below the threshold.
    expect(result.compacted).toBe(false);
    expect(result.threshold).toBe(102400);
    expect(result.contextTokens).not.toBeNull();
    expect(result.contextTokens!).toBeLessThan(102400);
    expect(compact).not.toHaveBeenCalled();
  });

  it("skips compaction for a stale recorded usage even when the conversation branch is still large (review scenario)", async () => {
    // The documented RUFU-135 case: recorded 124K (>= threshold 102400), live context
    // ~36K — but the conversation branch itself is still large, so pi's compact() WOULD
    // have produced a result and the old post-compaction re-measure would have read the
    // stale usage again. The pre-compaction fresh measurement sees the live view and
    // proceeds without the compaction round-trip.
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 124000, contextWindow: 128000, percent: 96.9 },
      compactImpl: async () => ({ summary: "s", tokensBefore: 124000 }),
      systemPrompt: "p".repeat(35_000), // ≈ 10K tokens fresh
      messages: [userMessageOf(300_000)], // ≈ 75K tokens (chars/4)
      activeToolNames: ["fn_task_list"],
      allTools: [{ name: "fn_task_list", description: "list", parameters: { type: "object" } }],
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(false);
    expect(result.threshold).toBe(102400);
    expect(result.contextTokens!).toBeLessThan(102400);
    expect(compact).not.toHaveBeenCalled();
  });

  it("still compacts when the fresh measurement also exceeds the threshold (real overflow, large conversation)", async () => {
    // Fresh measurement (~143K from the 500K-char prompt + 75K messages) is >= the
    // threshold — the overflow is real, so the gate proceeds to compaction as before.
    const { session, compact, usageState } = makeFakePiSession({
      usage: { tokens: 124000, contextWindow: 128000, percent: 96.9 },
      compactImpl: async () => compactToSummary(session, usageState, 2000, 124000),
      systemPrompt: "p".repeat(500_000),
      messages: [userMessageOf(300_000)],
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("still throws when compaction returns no result AND the fresh measurement also exceeds the threshold (real static overflow)", async () => {
    // Recorded 120K AND the current prompt is genuinely huge (~500K chars ≈ 143K
    // tokens fresh >= threshold) → the static floor itself no longer fits.
    const { session } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      compactImpl: async () => undefined,
      systemPrompt: "p".repeat(500_000),
    });
    const err = await captureGateError(session, { tokenCap: undefined });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(err?.message).toContain("fresh measurement");
  });

  it("keeps the fail-loud behavior when the session does not expose the current system prompt", async () => {
    // No systemPrompt on the session shape → fresh estimate is null → the gate
    // cannot distinguish stale from real and must keep throwing (legacy behavior).
    const { session } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      compactImpl: async () => undefined,
    });
    const err = await captureGateError(session, { tokenCap: undefined });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
  });

  it("throws ChatContextOverflowError when session.compact() throws", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      compactImpl: async () => {
        throw new Error("upstream 500 during summarization");
      },
    });
    // compactSessionContext swallows the underlying error and returns null, so the
    // gate throws the fail-loud error with a "no compaction result" cause.
    const err = await captureGateError(session, { tokenCap: undefined });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(err?.retryable).toBe(false);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("skips (no throw) for non-pi session shapes", async () => {
    // Plugin CLI runtime shape: top-level messages, no getContextUsage, no compact.
    const session = {
      model: { contextWindow: 128000, maxTokens: 16384 },
      messages: [userMessageOf(900000)],
    } as unknown as CompactionGateSession;
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result).toEqual({ compacted: false, contextTokens: null, threshold: null });
  });

  it("skips (no throw) when the context window is unknown", async () => {
    const { session, compact } = makeFakePiSession({
      contextWindow: 0,
      usage: { tokens: 200000, contextWindow: 0, percent: null },
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(false);
    expect(result.threshold).toBeNull();
    expect(compact).not.toHaveBeenCalled();
  });

  it("skips (no throw) when the loaded token count is unknown", async () => {
    const { session, compact } = makeFakePiSession({ usage: "undefined", withState: false });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result).toEqual({ compacted: false, contextTokens: null, threshold: 102400 });
    expect(compact).not.toHaveBeenCalled();
  });

  it("zero-provider-usage variant: the pure chars/4 estimate from getContextUsage still trips the gate", async () => {
    // The RUFU-118 repro: every assistant message carries all-zero provider usage (dsai1
    // omits usage in the stream), so pi's _checkCompaction reports "No usage data at all"
    // and never threshold-compacts. pi's getContextUsage still returns the pure chars/4
    // estimate (~122K here) — the gate must fire on that number.
    const { session, compact, usageState } = makeFakePiSession({
      usage: { tokens: 122000, contextWindow: 128000, percent: 95.3 },
      compactImpl: async () => compactToSummary(session, usageState, 4000, 122000),
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("zero-provider-usage variant: null usage tokens fall back to the loaded-message estimate", async () => {
    // Post-compaction shape (or any all-zero-usage history without a compaction entry):
    // usage tokens are null, so the gate sums pi's per-message estimate over the loaded
    // messages. 420000 chars → 105000 tokens >= 102400 threshold → compacts.
    const { session, compact, usageState } = makeFakePiSession({
      usage: { tokens: null, contextWindow: 128000, percent: null },
      messages: [userMessageOf(420000)],
      compactImpl: async () => compactToSummary(session, usageState, 4000, 105000),
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(true);
    expect(result.contextTokens).toBe(105000);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("respects a lower tokenCap as the effective threshold", async () => {
    // tokenCap 50000 < default 102400 → threshold 50000; 50000 loaded tokens triggers
    // compaction even though the default threshold would not.
    const { session, compact, usageState } = makeFakePiSession({
      usage: { tokens: 50000, contextWindow: 128000, percent: 39.1 },
      compactImpl: async () => compactToSummary(session, usageState, 4000, 50000),
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: 50000 });
    expect(result.compacted).toBe(true);
    expect(result.threshold).toBe(50000);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("clamps a high tokenCap to the hard limit for the decision", async () => {
    // tokenCap 130000 clamps to the 111616 hard limit; 112000 loaded tokens triggers.
    const { session, compact, usageState } = makeFakePiSession({
      usage: { tokens: 112000, contextWindow: 128000, percent: 87.5 },
      compactImpl: async () => compactToSummary(session, usageState, 4000, 112000),
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: 130000 });
    expect(result.compacted).toBe(true);
    expect(result.threshold).toBe(111616);
    expect(compact).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:CustomProviderModelWindows 2026-08-20-13:25:
RUFU-123 integration pin (carried over from the standalone custom-provider-model-windows
branch, where it cannot run because this guard module is absent there): once per-model
contextWindow/maxTokens are registered for custom-provider models, the threshold for a
32768-window / 4096-maxTokens model must be 16384 — not the ~102,400 the pre-fix
hardcoded 128000 registry default produced. Combined with the registry tests on the
RUFU-123 branch, this proves the registered window flows all the way to the gate.
*/
describe("per-model window thresholds (RUFU-123 integration)", () => {
  it("computes 16384 (not 102400) for a 32768-window / 4096-maxTokens model", () => {
    expect(computeCompactionThreshold({ contextWindow: 32768, maxTokens: 4096 })).toBe(16384);
    // Regression pin: the pre-fix hardcoded registry default produced 102,400 here.
    expect(computeCompactionThreshold({ contextWindow: 128000, maxTokens: 16384 })).toBe(102400);
  });
});
