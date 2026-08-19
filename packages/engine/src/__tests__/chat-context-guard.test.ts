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

  it("returns null when the hard limit is non-positive (reserve >= window)", () => {
    // 16000 window - 16384 reserve = -384
    expect(computeCompactionThreshold({ contextWindow: 16000, maxTokens: 16384 })).toBeNull();
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
