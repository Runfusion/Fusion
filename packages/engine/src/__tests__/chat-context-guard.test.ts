/**
 * RUFU-118 phase 1: deterministic pre-overflow compaction gate — unit tests.
 *
 * Covers the threshold math (exact spec values), the loaded-context estimator
 * (usage-first with chars/4 fallback, the zero-provider-usage blind spot), and the
 * gate seam contract. RUFU-182 replaced the null-contract gate tests with the full
 * escalation-ladder matrix: the gate's fake session compact() is a STATE MACHINE that
 * mirrors pi 0.84.4's absolute rules (a compaction entry appended becomes the last
 * branch entry and any later pass rejects with "Already compacted"; a branch below the
 * compaction floor rejects with "Nothing to compact (session too small)"; a throw
 * appends no entry), so every ladder arm — including the skipped-escalation rows — is
 * proven through ensureContextWithinCompactionThreshold rather than a mocked helper.
 * Deterministic in-memory fakes only — no real LLM or network calls.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildAggressiveCompactionDirective,
  ChatContextOverflowError,
  computeCompactionThreshold,
  ensureContextWithinCompactionThreshold,
  estimateLoadedContextTokens,
  freshLoadedContextEstimate,
  type CompactionGateOptions,
  type CompactionGateSession,
} from "../chat-context-guard.js";
import { COMPACTION_FALLBACK_INSTRUCTIONS } from "../pi.js";

/**
 * One scripted `session.compact()` call consumed in order. A `throws` entry fails the
 * pass without appending an entry (branch unmutated); otherwise the pass appends a
 * compaction entry (replacing the loaded messages, as pi does) and reports
 * `tokensBefore` / `estimatedTokensAfter` — the latter omitted defaults to pi's own
 * message-only measurement of the new branch state, which keeps the default success
 * strictly reducing and self-consistent.
 */
interface CompactionAttempt {
  throws?: string;
  summaryChars?: number;
  tokensBefore?: number;
  estimatedTokensAfter?: number | null;
  /** User-content chars left loaded ALONGSIDE the summary (a weak-summary repro). */
  remainingUserChars?: number;
}

/**
 * Build a fake pi-shaped session whose `compact` mirrors pi 0.84.4's refusal rules:
 *
 * - last branch entry is a compaction entry → reject `Error("Already compacted")`,
 *   regardless of the instructions passed;
 * - `belowFloor` models a branch under pi's compaction floor → reject
 *   `Error("Nothing to compact (session too small)")`;
 * - a throw from the scripted pass appends NOTHING (branch unmutated, retry-legal);
 * - a success replaces the loaded messages with the compaction entry and moves the
 *   usage reader to pi's post-compaction shape (tokens null — no provider usage yet).
 *
 * `usage`: the value `getContextUsage()` initially returns; `"undefined"` simulates a
 * session with no model / zero context window; `"throw"` simulates a throwing reader.
 * `withPiShape: false` omits `getContextUsage` entirely (plugin CLI runtime shape);
 * `withState: false` omits `state`; `noCompactMethod` removes `compact` (the
 * unsupported capability arm). `systemPrompt`/`activeToolNames`/`allTools` feed the
 * fresh static cross-check.
 */
function makeFakePiSession(opts: {
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  usage?: { tokens: number | null; contextWindow: number; percent: number | null } | "undefined" | "throw";
  messages?: unknown[];
  attempts?: CompactionAttempt[];
  startCompacted?: boolean;
  belowFloor?: boolean;
  noCompactMethod?: boolean;
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
  // pi's estimateTokens counts chars/4 over content/summary text (verified against the
  // hoisted 0.84.4 build); the fake mirrors that so tokensBefore defaults match the
  // gate's own estimator without importing the real one.
  const messageTokens = (entries: unknown[]): number =>
    entries.reduce((acc, raw) => {
      const m = raw as { content?: unknown; summary?: unknown };
      const chars =
        typeof m?.content === "string"
          ? m.content.length
          : Array.isArray(m?.content)
            ? m.content.reduce<number>((s, p) => s + ((p as { type?: string; text?: string })?.type === "text" ? (p as { text?: string }).text?.length ?? 0 : 0), 0)
            : typeof m?.summary === "string"
              ? m.summary.length
              : 0;
      return acc + Math.ceil(chars / 4);
    }, 0);

  const entries: unknown[] = [...(opts.messages ?? [])];
  if (opts.startCompacted) {
    // A prior compaction pass left a compaction entry as the LAST branch entry —
    // pi's guard then refuses every further pass. Empty summary keeps the fixture's
    // token math exact.
    entries.push({ role: "compactionSummary", summary: "" });
  }
  const attempts = [...(opts.attempts ?? [])];
  const compact = vi.fn(async (instructions?: string) => {
    const last = entries[entries.length - 1] as { role?: string } | undefined;
    if (last?.role === "compactionSummary") {
      throw new Error("Already compacted");
    }
    if (opts.belowFloor) {
      throw new Error("Nothing to compact (session too small)");
    }
    const attempt = attempts.shift() ?? {};
    if (attempt.throws) {
      throw new Error(attempt.throws);
    }
    const summaryChars = attempt.summaryChars ?? 2000;
    const tokensBefore = attempt.tokensBefore ?? usageState.current?.tokens ?? messageTokens(entries);
    entries.length = 0;
    entries.push({ role: "compactionSummary", summary: "s".repeat(summaryChars) });
    if (attempt.remainingUserChars) {
      entries.push(userMessageOf(attempt.remainingUserChars));
    }
    if (usageState.current !== undefined) {
      usageState.current = { tokens: null, contextWindow: usageState.current.contextWindow, percent: null };
    }
    const estimatedTokensAfter =
      attempt.estimatedTokensAfter === undefined
        ? Math.ceil(summaryChars / 4) + Math.ceil((attempt.remainingUserChars ?? 0) / 4)
        : attempt.estimatedTokensAfter;
    return { summary: "s".repeat(summaryChars), tokensBefore, estimatedTokensAfter };
  });
  const session: Record<string, unknown> = {
    model: {
      contextWindow: opts.contextWindow ?? 128000,
      maxTokens: opts.maxTokens ?? 16384,
    },
  };
  if (!opts.noCompactMethod) {
    session.compact = compact;
  }
  if (opts.withState !== false) {
    session.state = { messages: entries };
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

/** Fake run-audit sink for the chat:pre-overflow-compaction row; `throws` models a hostile sink. */
function makeAuditSink(throws = false): { sink: { recordRunAuditEvent: ReturnType<typeof vi.fn> }; events: unknown[] } {
  const events: unknown[] = [];
  const sink = {
    recordRunAuditEvent: vi.fn((input: unknown) => {
      if (throws) throw new Error("audit sink down");
      events.push(input);
    }),
  };
  return { sink, events };
}

/** Assert the single audit row shape and return it for per-arm metadata checks. */
function auditEvent(events: unknown[], index = 0): {
  domain: string;
  mutationType: string;
  target: string;
  metadata: Record<string, unknown>;
} {
  expect(events.length).toBeGreaterThan(index);
  const event = events[index] as {
    domain: string;
    mutationType: string;
    target: string;
    metadata: Record<string, unknown>;
  };
  expect(event.domain).toBe("database");
  expect(event.mutationType).toBe("chat:pre-overflow-compaction");
  return event;
}

/** Run the gate once and capture the rejection (null on resolve). */
async function captureGateError(
  session: CompactionGateSession,
  options: CompactionGateOptions = {},
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

/*
FNXC:ChatContextGuardEscalation 2026-09-04-10:57:
The fake session's compact() above mirrors pi 0.84.4's compaction rules. This fidelity
test pins that mirror directly: a real pi branch accepts ONE accepted pass and then
refuses every further pass with the absolute "Already compacted" literal — instructions
are irrelevant to the refusal. That is precisely why the escalation tier may only follow
an error (branch unmutated): re-asking after an accepted pass or a refusal is the
silent-no-op retry RUFU-182 deletes.
*/
describe("fake engine compaction-state fidelity (mirrors pi 0.84.4)", () => {
  it("accepts one pass, then refuses any further pass regardless of instructions", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      messages: [userMessageOf(200_000)],
    });
    await expect(session.compact!("first-directive")).resolves.toBeTruthy();
    await expect(session.compact!("second-directive")).rejects.toThrow("Already compacted");
    expect(compact.mock.calls.map((call) => call[0])).toEqual(["first-directive", "second-directive"]);
  });

  it("refuses a below-floor branch with pi's too-small literal", async () => {
    const { session } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      belowFloor: true,
    });
    await expect(session.compact!("anything")).rejects.toThrow("Nothing to compact (session too small)");
  });

  it("leaves the branch unmutated when a pass throws", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      messages: [userMessageOf(200_000)],
      attempts: [{ throws: "upstream 500" }],
    });
    await expect(session.compact!("directive")).rejects.toThrow("upstream 500");
    // No compaction entry was appended: the next pass is still eligible (not
    // "Already compacted"), which is the precondition for a legal tier-2 retry.
    await expect(session.compact!("directive again")).resolves.toBeTruthy();
    expect(compact).toHaveBeenCalledTimes(2);
  });
});

describe("ensureContextWithinCompactionThreshold", () => {
  // Matrix case 1: below threshold — no ladder, no audit row.
  it("does not compact below the threshold (small-context no-op)", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 50000, contextWindow: 128000, percent: 39.1 },
    });
    const { sink, events } = makeAuditSink();
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined, audit: { sink } });
    expect(result).toEqual({ compacted: false, contextTokens: 50000, threshold: 102400 });
    expect(compact).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
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

  // Matrix case 2: above threshold, strictly-reducing pass that fits → accepted,
  // tier-1 only, retrySkippedReason "not-needed".
  it("compacts once at the threshold, accepts the strictly-reducing summary, and audits compacted", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 102400, contextWindow: 128000, percent: 80 },
    });
    const { sink, events } = makeAuditSink();
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined, audit: { sink, sessionId: "s-1" } });
    expect(result.compacted).toBe(true);
    expect(result.contextTokens).toBe(102400);
    expect(result.threshold).toBe(102400);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0][0]).toBe(COMPACTION_FALLBACK_INSTRUCTIONS);
    const event = auditEvent(events);
    expect(event.target).toBe("chat:s-1");
    expect(event.metadata).toMatchObject({
      tier: "normal",
      tiersAttempted: ["normal"],
      reason: null,
      outcome: "compacted",
      beforeTokens: 102400,
      afterTokens: 500,
      threshold: 102400,
      retrySkippedReason: "not-needed",
    });
  });

  // Matrix case 3: pi accepted the pass but the summary is empty → refuse; the branch
  // is mutated, so escalation is illegal (retrySkippedReason branch-already-mutated).
  it("throws reason=empty-summary when the accepted pass produced an empty summary (1 call, no escalation)", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      attempts: [{ summaryChars: 0 }],
    });
    const { sink, events } = makeAuditSink();
    const err = await captureGateError(session, { tokenCap: undefined, audit: { sink } });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(err?.retryable).toBe(false);
    expect(err?.message).toContain("reason=empty-summary");
    expect((err?.details as Record<string, unknown>).reason).toBe("empty-summary");
    expect(compact).toHaveBeenCalledTimes(1);
    expect(auditEvent(events).metadata).toMatchObject({
      reason: "empty-summary",
      outcome: "refused",
      tier: "normal",
      retrySkippedReason: "branch-already-mutated",
    });
  });

  // Matrix case 4: pi reported NO reduction but the send still fits under the hard
  // limit → proceed without reduction (warn, no throw) — never a hard failure where
  // today's sends work.
  it("proceeds with a non-reducing summary when the context still fits under the hard limit", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      attempts: [{ summaryChars: 2000, estimatedTokensAfter: 120000, remainingUserChars: 440_000 }],
    });
    const { sink, events } = makeAuditSink();
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined, audit: { sink } });
    expect(result).toEqual({ compacted: false, contextTokens: 110_500, threshold: 102400 });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(auditEvent(events).metadata).toMatchObject({
      reason: "non-reducing-summary",
      outcome: "proceeded-without-reduction",
      afterTokens: 110_500,
      retrySkippedReason: "branch-already-mutated",
    });
  });

  // Matrix case 5: the un-reduced context is OVER the hard limit → refuse, and name
  // the failed reduction — NOT a generic over-limit claim.
  it("throws reason=non-reducing-summary when a non-reducing summary leaves the context over the hard limit", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      attempts: [{ summaryChars: 2000, estimatedTokensAfter: 120000, remainingUserChars: 470_000 }],
    });
    const { sink, events } = makeAuditSink();
    const err = await captureGateError(session, { tokenCap: undefined, audit: { sink } });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.message).toContain("reason=non-reducing-summary");
    expect(err?.message).toContain("118000");
    expect((err?.details as Record<string, unknown>).reason).toBe("non-reducing-summary");
    expect(compact).toHaveBeenCalledTimes(1); // accepted pass mutated the branch — no retry
    expect(auditEvent(events).metadata).toMatchObject({
      reason: "non-reducing-summary",
      outcome: "refused",
      afterTokens: 118_000,
      retrySkippedReason: "branch-already-mutated",
    });
  });

  /*
  FNXC:ChatContextGuardEscalation 2026-09-04-10:57:
  Matrix case 6 — the saneca repro (chat-b6a74d40). Recorded usage 119,053 >= threshold
  fires the ladder; pi rejects with its absolute "Already compacted" guard; the fresh
  measurement (102,862 tokens on saneca's real session, reproduced here) is STILL above
  the threshold, so the refusal is surfaced with its own reason. The old code labeled
  every compaction failure with the static-floor sentence; the fresh measurement proved
  saneca's static floor fit (102,862 < 111,616), so that claim was false. The refusal
  message must name pi's refusal and the fresh measurement, and must NOT claim a static
  floor overflow.
  */
  it("saneca leg: throws reason=already-compacted (never static-floor) when pi refuses and the fresh measurement also exceeds the threshold", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 119053, contextWindow: 128000, percent: 92.9 },
      startCompacted: true,
      // 360017/3.5 = 102862 tokens — saneca's measured fresh floor.
      systemPrompt: "p".repeat(360_017),
    });
    const { sink, events } = makeAuditSink();
    const err = await captureGateError(session, { tokenCap: undefined, audit: { sink } });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(err?.message).toContain("reason=already-compacted");
    expect(err?.message).toContain("Already compacted");
    expect(err?.message).toContain("fresh measurement of the current prompt + tools + messages is 102862 tokens");
    expect(err?.message).not.toContain("static context (system prompt");
    expect((err?.details as Record<string, unknown>).reason).toBe("already-compacted");
    expect((err?.details as Record<string, unknown>).freshTokens).toBe(102862);
    expect(compact).toHaveBeenCalledTimes(1); // pi's refusal is absolute — no tier-2
    const event = auditEvent(events);
    expect(event.metadata).toMatchObject({
      reason: "already-compacted",
      outcome: "refused",
      tiersAttempted: ["normal"],
      afterTokens: 102862,
      retrySkippedReason: "pi-refuses-second-compaction",
    });
  });

  // Matrix case 7: pi's too-small refusal with no fresh measurement available (no
  // systemPrompt on the shape) → fail loud naming the refusal, 1 call, no escalation.
  it("throws reason=nothing-to-compact when pi refuses below its compaction floor and no fresh measurement exists", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      belowFloor: true,
    });
    const { sink, events } = makeAuditSink();
    const err = await captureGateError(session, { tokenCap: undefined, audit: { sink } });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.message).toContain("reason=nothing-to-compact");
    expect(err?.message).toContain("Nothing to compact (session too small)");
    expect(err?.message).toContain("the fresh measurement is unavailable");
    expect(err?.message).not.toContain("static context (system prompt");
    expect(compact).toHaveBeenCalledTimes(1);
    expect(auditEvent(events).metadata).toMatchObject({
      reason: "nothing-to-compact",
      outcome: "refused",
      afterTokens: null,
      retrySkippedReason: "pi-refuses-second-compaction",
    });
  });

  // Matrix case 8: a transient tier-1 error left the branch unmutated → exactly ONE
  // escalation pass with the aggressive directive; the directives must DIFFER (the
  // no-silent-no-op contract).
  it("escalates once after a transient tier-1 error with an aggressive directive that differs from the fallback", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      attempts: [{ throws: "upstream 500 during summarization" }, { summaryChars: 2000 }],
    });
    const { sink, events } = makeAuditSink();
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined, audit: { sink } });
    expect(result.compacted).toBe(true);
    expect(compact).toHaveBeenCalledTimes(2);
    const tier1Directive = compact.mock.calls[0][0];
    const tier2Directive = compact.mock.calls[1][0];
    expect(tier1Directive).toBe(COMPACTION_FALLBACK_INSTRUCTIONS);
    expect(tier2Directive).toBe(buildAggressiveCompactionDirective(102400));
    expect(tier2Directive).not.toBe(tier1Directive);
    expect(String(tier2Directive)).toContain("76800");
    // The accepted pass left the branch under the threshold (fresh estimator view).
    expect(estimateLoadedContextTokens(session)).toBeLessThan(102400);
    const event = auditEvent(events);
    expect(event.metadata).toMatchObject({
      tier: "aggressive",
      tiersAttempted: ["normal", "aggressive"],
      reason: null,
      outcome: "compacted",
      beforeTokens: 120000,
      threshold: 102400,
      retrySkippedReason: "not-needed",
    });
  });

  // Matrix case 9: both tiers error → compaction-error; tiersAttempted records both.
  it("throws reason=compaction-error after the single legal retry also errors (exactly 2 calls)", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      attempts: [{ throws: "upstream 500 #1" }, { throws: "upstream 500 #2" }],
    });
    const { sink, events } = makeAuditSink();
    const err = await captureGateError(session, { tokenCap: undefined, audit: { sink } });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.message).toContain("reason=compaction-error");
    expect(err?.message).toContain("normal, aggressive");
    expect(err?.message).toContain("upstream 500 #2");
    expect(err?.cause?.message).toContain("upstream 500 #2");
    expect(compact).toHaveBeenCalledTimes(2);
    expect(auditEvent(events).metadata).toMatchObject({
      reason: "compaction-error",
      outcome: "refused",
      tiersAttempted: ["normal", "aggressive"],
      tier: "aggressive",
    });
  });

  // Matrix case 10: no compaction capability at all → 0 engine calls, unsupported.
  it("throws reason=unsupported without any engine call when the session exposes no compact capability", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      noCompactMethod: true,
    });
    const { sink, events } = makeAuditSink();
    const err = await captureGateError(session, { tokenCap: undefined, audit: { sink } });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.message).toContain("reason=unsupported");
    expect(compact).toHaveBeenCalledTimes(0);
    expect(auditEvent(events).metadata).toMatchObject({
      reason: "unsupported",
      outcome: "refused",
      tier: "normal",
      tiersAttempted: ["normal"],
      retrySkippedReason: "capability-missing",
    });
  });

  // Matrix case 11: usage tokens null (dsai1 zero-usage shape) — the ladder runs off
  // the guard's own chars/4 estimate and a reducing pass is accepted.
  it("runs the ladder off the message estimate when usage tokens are null (dsai1 zero-usage shape)", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: null, contextWindow: 128000, percent: null },
      messages: [userMessageOf(420000)],
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(true);
    expect(result.contextTokens).toBe(105000);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:ChatContextGuard 2026-08-19-15:05:
  RUFU-118: operator opt-out — enabled: false no-ops the gate even when the loaded
  context is above the threshold (no measurement, no compaction, no throw). The gate
  is a selectable feature (Settings.chatPreOverflowCompactionEnabled), on by default.
  Matrix case 12 adds: the kill switch writes NO audit row.
  */
  it("no-ops (no compact, no throw, no audit row) when explicitly disabled, even above threshold", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
    });
    const { sink, events } = makeAuditSink();
    const result = await ensureContextWithinCompactionThreshold(session, {
      tokenCap: undefined,
      enabled: false,
      audit: { sink },
    });
    expect(result).toEqual({ compacted: false, contextTokens: null, threshold: null });
    expect(compact).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  // Matrix case 13: the static floor (prompt + active tool schemas alone) reaches the
  // hard limit — an ENTRY TEST: throw before ever touching the ladder.
  it("throws reason=static-floor at entry, before any compaction attempt, when the static floor meets the hard limit", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      // 500_000 chars / 3.5 = 142858 tokens >= the 111616 hard limit.
      systemPrompt: "p".repeat(500_000),
    });
    const { sink, events } = makeAuditSink();
    const err = await captureGateError(session, { tokenCap: undefined, audit: { sink } });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(err?.message).toContain("the static context (system prompt + tools + memory) itself exceeds the window budget");
    expect((err?.details as Record<string, unknown>).reason).toBe("static-floor");
    expect((err?.details as Record<string, unknown>).tiersAttempted).toEqual([]);
    expect((err?.details as Record<string, unknown>).staticTokens).toBe(142858);
    expect(compact).toHaveBeenCalledTimes(0);
    // The ladder never ran → no audit row.
    expect(events).toHaveLength(0);
  });

  // Matrix case 14 (both legacy skip shapes preserved) + unknown-count skip.
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

  /*
  FNXC:ChatContextGuard 2026-08-20-12:20:
  Stale-usage cross-check (RUFU-135 follow-up), relocated by RUFU-182 into the
  reason-coded refusal arms: pi refusing to compact means the recorded usage may
  describe a LARGER static context than the session carries now (it is restored from the
  session file and predates whatever deploy changed the prompt/toolset). Matrix case 15:
  when a fresh measurement of the current prompt + tools + messages fits under the
  threshold, the send proceeds — the refusal is treated as stale evidence, not overflow.
  */
  it("proceeds when pi refuses (already-compacted) but the fresh measurement fits (stale recorded usage)", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      startCompacted: true,
      // ~100K chars ≈ 28571 tokens fresh — the usage is stale.
      systemPrompt: "p".repeat(100_000),
    });
    const { sink, events } = makeAuditSink();
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined, audit: { sink } });
    expect(result.compacted).toBe(false);
    expect(result.threshold).toBe(102400);
    expect(result.contextTokens).toBe(28571);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(auditEvent(events).metadata).toMatchObject({
      reason: "already-compacted",
      outcome: "proceeded-without-reduction",
      afterTokens: 28571,
      retrySkippedReason: "pi-refuses-second-compaction",
    });
  });

  // Matrix case 16: pi's own after-measurement is unusable (estimatedTokensAfter
  // absent) → the strict acceptance rule cannot be satisfied: proceed UNVALIDATED on
  // the guard's own fitting estimate and audit measurement-unknown.
  it("proceeds unvalidated and audits measurement-unknown when pi reports no after-measurement", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      attempts: [{ summaryChars: 2000, estimatedTokensAfter: null }],
    });
    const { sink, events } = makeAuditSink();
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined, audit: { sink } });
    expect(result).toEqual({ compacted: false, contextTokens: 500, threshold: 102400 });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(auditEvent(events).metadata).toMatchObject({
      outcome: "measurement-unknown",
      reason: null,
      afterTokens: 500,
      retrySkippedReason: "branch-already-mutated",
    });
  });

  // Measurement-unknown with the guard's own estimate over the hard limit: the honest
  // statement stays "we could not observe what compaction did" (outcome
  // measurement-unknown even on a throw) and the refusal names post-compaction-over-limit.
  it("throws post-compaction-over-limit with outcome=measurement-unknown when an unmeasurable pass leaves the context over the hard limit", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 124000, contextWindow: 128000, percent: 96.9 },
      attempts: [{ summaryChars: 2000, estimatedTokensAfter: null, remainingUserChars: 464_000 }],
    });
    const { sink, events } = makeAuditSink();
    const err = await captureGateError(session, { tokenCap: undefined, audit: { sink } });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(err?.retryable).toBe(false);
    expect(err?.message).toContain("reason=post-compaction-over-limit");
    expect(compact).toHaveBeenCalledTimes(1); // exactly one compaction attempt — no loop
    expect(auditEvent(events).metadata).toMatchObject({
      reason: "post-compaction-over-limit",
      outcome: "measurement-unknown",
      afterTokens: 116_500,
      retrySkippedReason: "branch-already-mutated",
    });
  });

  // Reduced, measured, but still over the hard limit even after the accepted pass.
  it("throws reason=post-compaction-over-limit when a reduced pass still leaves the context over the hard limit", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 124000, contextWindow: 128000, percent: 96.9 },
      attempts: [{ summaryChars: 2000, estimatedTokensAfter: 116_500, remainingUserChars: 464_000 }],
    });
    const { sink, events } = makeAuditSink();
    const err = await captureGateError(session, { tokenCap: undefined, audit: { sink } });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.message).toContain("reason=post-compaction-over-limit");
    expect(compact).toHaveBeenCalledTimes(1);
    expect(auditEvent(events).metadata).toMatchObject({
      reason: "post-compaction-over-limit",
      outcome: "refused",
      retrySkippedReason: "branch-already-mutated",
    });
  });

  // Matrix case 17: an ABORTED pass (pi's "Compaction cancelled") threw without
  // appending — branch unmutated — so one retry with the aggressive directive is legal,
  // exactly like a transient error.
  it("treats a cancelled pass as an error (retry-legal), not a refusal", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      attempts: [{ throws: "Compaction cancelled" }, { summaryChars: 2000 }],
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(true);
    expect(compact).toHaveBeenCalledTimes(2);
    expect(compact.mock.calls[1][0]).toBe(buildAggressiveCompactionDirective(102400));
    expect(compact.mock.calls[1][0]).not.toBe(compact.mock.calls[0][0]);
  });

  it("compacts when enabled: true is passed explicitly (default-on opt-out)", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 102400, contextWindow: 128000, percent: 80 },
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined, enabled: true });
    expect(result.compacted).toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("zero-provider-usage variant: the pure chars/4 estimate from getContextUsage still trips the gate", async () => {
    // The RUFU-118 repro: every assistant message carries all-zero provider usage (dsai1
    // omits usage in the stream), so pi's _checkCompaction reports "No usage data at all"
    // and never threshold-compacts. pi's getContextUsage still returns the pure chars/4
    // estimate (~122K here) — the gate must fire on that number.
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 122000, contextWindow: 128000, percent: 95.3 },
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("respects a lower tokenCap as the effective threshold", async () => {
    // tokenCap 50000 < default 102400 → threshold 50000; 50000 loaded tokens triggers
    // compaction even though the default threshold would not.
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 50000, contextWindow: 128000, percent: 39.1 },
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: 50000 });
    expect(result.compacted).toBe(true);
    expect(result.threshold).toBe(50000);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("clamps a high tokenCap to the hard limit for the decision", async () => {
    // tokenCap 130000 clamps to the 111616 hard limit; 112000 loaded tokens triggers.
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 112000, contextWindow: 128000, percent: 87.5 },
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: 130000 });
    expect(result.compacted).toBe(true);
    expect(result.threshold).toBe(111616);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("keeps the compaction outcome unchanged when no audit sink is provided", async () => {
    const { session, compact } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
    });
    const result = await ensureContextWithinCompactionThreshold(session, { tokenCap: undefined });
    expect(result.compacted).toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:ChatContextGuardEscalation 2026-09-04-10:57:
  RUFU-182: the audit row is best-effort telemetry. A throwing sink is absorbed by the
  bounded emitter and must never change what the gate returns or throws (the sink-host
  isolation contract of emitBoundedRunAudit, proven at this call site).
  */
  it("survives a hostile (throwing) audit sink without changing the outcome", async () => {
    const { session } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
    });
    const { sink } = makeAuditSink(true);
    await expect(
      ensureContextWithinCompactionThreshold(session, { tokenCap: undefined, audit: { sink, sessionId: "hostile" } }),
    ).resolves.toMatchObject({ compacted: true, contextTokens: 120000, threshold: 102400 });
    // The sink was actually reached (the row was attempted) and its throw absorbed.
    expect(sink.recordRunAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("still refuses with the original error when the audit sink throws on a refusal path", async () => {
    const { session } = makeFakePiSession({
      usage: { tokens: 120000, contextWindow: 128000, percent: 93.75 },
      belowFloor: true,
    });
    const { sink } = makeAuditSink(true);
    const err = await captureGateError(session, { tokenCap: undefined, audit: { sink } });
    expect(err).toBeInstanceOf(ChatContextOverflowError);
    expect(err?.message).toContain("reason=nothing-to-compact");
  });
});
