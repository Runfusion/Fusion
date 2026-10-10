/**
 * RUFU-183: escalation tier 3 — deterministic non-LLM truncation.
 *
 * Tier 3 runs only after the two LLM tiers failed or pi refused absolutely, and only for a
 * session that exposes pi's public compaction surface. These tests drive
 * `ensureContextWithinCompactionThreshold` end to end (no mocked helper) through a fake
 * `SessionManager` that mirrors pi 0.84.4's projection rules — `buildContextEntries`
 * reconstruction, `buildSessionContext` message rebuild, and an `appendCompaction` that
 * appends a real compaction entry to the leaf — so the gate's proof and the split floor are
 * exercised against pi-shaped data rather than a hand-shaped expectation.
 *
 * The fixture invariants the numbers below depend on:
 * - window 128 000 / maxTokens 16 384 → threshold 102 400, hard limit 111 616,
 *   compaction target 76 800 (`compactionTargetBudget`).
 * - a 350-char system prompt → static floor 100 tokens, so the message budget is 76 700.
 * - the leaf holds a LIVE compaction (`c0`, firstKeptEntryId `m3`) followed by two entries, so
 *   the split floor must force the new cut at `m5` — a cut at `m4` would re-project `c0`'s
 *   summary as active context.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextEntries, buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ChatContextOverflowError,
  compactionTargetBudget,
  ensureContextWithinCompactionThreshold,
  staticContextFloorEstimate,
  type CompactionGateSession,
} from "../chat-context-guard.js";
import { buildDeterministicFallbackCompaction } from "../chat-context-deterministic-fallback.js";

/*
FNXC:ChatContextGuardTier3 2026-09-04-20:21:
The fake transcript uses pi's REAL entry shapes (a `message` entry WRAPS an AgentMessage) and
pi's REAL `buildContextEntries`/`buildSessionContext`, so the gate's projection, split floor and
proof are exercised against the shipped 0.84.4 semantics rather than a hand-shaped mirror. Only
`appendCompaction`'s persistence is faked — it appends a genuine compaction entry to the leaf.
*/

/** One leaf entry of the fake transcript (message or compaction, linear parent chain). */
type FakeEntry = ReturnType<typeof messageEntry> | ReturnType<typeof compactionEntry>;

const TS = "2026-09-04T00:00:00.000Z";

function messageEntry(id: string, parentId: string | null, role: string, content: string) {
  return { id, parentId, timestamp: TS, type: "message" as const, message: { role, content } };
}

function compactionEntry(
  id: string,
  parentId: string | null,
  summary: string,
  firstKeptEntryId: string,
  tokensBefore: number,
) {
  return { id, parentId, timestamp: TS, type: "compaction" as const, summary, firstKeptEntryId, tokensBefore };
}

function indexById(entries: Array<{ id: string }>): Map<string, FakeEntry> {
  return new Map(entries.map((entry) => [entry.id, entry as FakeEntry]));
}

function makeFakeSessionManager(seed: readonly FakeEntry[], opts: { rebuiltMessages?: unknown[] } = {}) {
  const entries: FakeEntry[] = [...seed];
  const appended: Array<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
    fromHook?: boolean;
  }> = [];
  let seq = 0;
  const leafId = () => entries[entries.length - 1]?.id ?? null;
  const manager = {
    getEntries: () => entries,
    getLeafId: () => leafId(),
    buildContextEntries: () => buildContextEntries(entries as never, leafId(), indexById(entries)),
    buildSessionContext: () =>
      opts.rebuiltMessages
        ? ({ messages: opts.rebuiltMessages } as ReturnType<typeof buildSessionContext>)
        : buildSessionContext(entries as never, leafId(), indexById(entries)),
    appendCompaction: vi.fn((
      summary: string,
      firstKeptEntryId: string,
      tokensBefore: number,
      details?: unknown,
      fromHook?: boolean,
    ) => {
      appended.push({ summary, firstKeptEntryId, tokensBefore, details, fromHook });
      const id = `c-${++seq}`;
      entries.push(compactionEntry(id, leafId(), summary, firstKeptEntryId, tokensBefore) as FakeEntry);
      return id;
    }),
  };
  return { manager, entries, appended };
}

/**
 * The shared over-limit transcript: `m3` (60k tokens) + three 20k-token turns sit far over the
 * 102 400 threshold, and `c0` marks the branch as already compacted with `m3` kept.
 */
function seedChain(): FakeEntry[] {
  return [
    messageEntry("m1", null, "user", "a".repeat(400)),
    messageEntry("m2", "m1", "assistant", "b".repeat(400)),
    messageEntry("m3", "m2", "user", "x".repeat(240_000)),
    messageEntry("m4", "m3", "user", "y".repeat(80_000)),
    compactionEntry("c0", "m4", "c".repeat(400), "m3", 120_000),
    messageEntry("m5", "c0", "user", "z".repeat(80_000)),
    messageEntry("m6", "m5", "user", "w".repeat(80_000)),
  ];
}

type CompactBehavior =
  | "already-compacted"
  | "nothing-to-compact"
  | "error"
  | "empty-summary"
  | "non-reducing"
  | "measurement-unknown"
  | "still-over"
  | "unsupported";

function makeTier3Fixture(opts: {
  behavior: CompactBehavior;
  capable?: boolean;
  systemPrompt?: string;
  /** Override what the rebuild reports, to model an unprovable reduction. */
  rebuiltMessages?: unknown[];
}) {
  const seed = seedChain();
  const { manager, entries, appended } = makeFakeSessionManager(seed, {
    rebuiltMessages: opts.rebuiltMessages,
  });
  const liveMessages = buildSessionContext(seed as never, "m6", indexById(seed)).messages;
  const compact = vi.fn(async () => {
    switch (opts.behavior) {
      case "already-compacted":
        throw new Error("Already compacted");
      case "nothing-to-compact":
        throw new Error("Nothing to compact (session too small)");
      case "error":
        throw new Error("Provider API error");
      case "empty-summary":
        return { summary: "", firstKeptEntryId: "m5", tokensBefore: 200_000, estimatedTokensAfter: 5_000 };
      case "non-reducing":
        return { summary: "s".repeat(800), firstKeptEntryId: "m5", tokensBefore: 200_000, estimatedTokensAfter: 200_000 };
      case "measurement-unknown":
        return { summary: "s".repeat(800), firstKeptEntryId: "m5", tokensBefore: 200_000, estimatedTokensAfter: null };
      case "still-over":
        return { summary: "s".repeat(800), firstKeptEntryId: "m5", tokensBefore: 200_000, estimatedTokensAfter: 1_000 };
      default:
        throw new Error("unreachable");
    }
  });
  const events: unknown[] = [];
  const sink = { recordRunAuditEvent: vi.fn((input: unknown) => events.push(input)) };
  const session: Record<string, unknown> = {
    model: { contextWindow: 128_000, maxTokens: 16_384 },
    systemPrompt: opts.systemPrompt === undefined ? "p".repeat(350) : opts.systemPrompt,
    state: { messages: [...liveMessages] },
    getContextUsage: () => ({ tokens: 200_000, contextWindow: 128_000, percent: 156 }),
  };
  if (opts.behavior !== "unsupported") session.compact = compact;
  if (opts.capable !== false) session.sessionManager = manager;
  const gateSession = session as unknown as CompactionGateSession;
  const run = () =>
    ensureContextWithinCompactionThreshold(gateSession, {
      enabled: true,
      audit: { sink, sessionId: "chat-tier3-test" },
    });
  return { session: gateSession, manager, entries, appended, compact, events, run };
}

/** Run-audit metadata of row `index`. */
function meta(events: unknown[], index = 0): Record<string, unknown> {
  return (events[index] as { metadata: Record<string, unknown> }).metadata;
}

describe("chat-context-guard escalation tier 3 (deterministic fallback)", () => {
  it("rescues an already-compacted branch by truncating deterministically", async () => {
    const fx = makeTier3Fixture({ behavior: "already-compacted" });
    const result = await fx.run();

    expect(result.compacted).toBe(true);
    expect(result.threshold).toBe(102_400);
    const fallback = result.fallback;
    expect(fallback).toBeDefined();
    // The floor must be reported from the same estimator the proof used, never a new math.
    const session = fx.session as unknown as { systemPrompt: string };
    expect(fallback!.floorTokens).toBe(staticContextFloorEstimate(fx.session));
    expect(session.systemPrompt.length).toBe(350);
    // Proven against the compaction target, not merely the trigger threshold.
    expect(fallback!.contextTokensAfter).toBeLessThan(compactionTargetBudget(102_400));
    expect(result.contextTokens).toBe(fallback!.contextTokensAfter);
    // c0 + m3 + m4 folded into the digest; m5 + m6 preserved verbatim.
    expect(fallback!.droppedMessageCount).toBe(3);
    expect(fallback!.droppedTokens).toBeGreaterThan(0);

    // Exactly one transcript write, via the public API, flagged as a programmatic hook call.
    expect(fx.appended).toHaveLength(1);
    expect(fx.appended[0]!.fromHook).toBe(true);
    expect(fx.appended[0]!.details).toMatchObject({
      deterministicFallback: true,
      droppedEntryCount: 3,
      keptEntryCount: 2,
    });
    expect(fx.compact).toHaveBeenCalledTimes(1);

    // The live view is the rebuilt transcript: digest + the two newest turns, nothing older.
    const roles = (fx.session as unknown as { state: { messages: Array<{ role: string }> } }).state.messages.map(
      (m) => m.role,
    );
    expect(roles).toEqual(["compactionSummary", "user", "user"]);
    // One audit row only: the rescue replaces the refusal it prevented.
    expect(fx.events).toHaveLength(1);
    expect(meta(fx.events)).toMatchObject({
      tier: "fallback",
      tiersAttempted: ["normal", "fallback"],
      reason: null,
      outcome: "compacted",
      retrySkippedReason: "not-needed",
      droppedMessageCount: 3,
      floorTokens: 100,
    });
  });

  it("honors the split floor: the same fixture without it would re-project the live compaction", async () => {
    // Non-vacuous control for the `minSplitIndex` assertion above: the budget alone is happy
    // with a cut at m4, which sits BEFORE c0 — pi would then project both summaries.
    const active = buildContextEntries(seedChain() as never, "m6", indexById(seedChain()));
    const unconstrained = buildDeterministicFallbackCompaction({
      activeEntries: active,
      messageTokenBudget: compactionTargetBudget(102_400) - 100,
      tokensBefore: 200_000,
    });
    expect(unconstrained).not.toBeNull();
    expect(unconstrained!.firstKeptEntryId).toBe("m4");

    const fx = makeTier3Fixture({ behavior: "already-compacted" });
    await fx.run();
    expect(fx.appended[0]!.firstKeptEntryId).toBe("m5");
  });

  it("keeps pi's refusal for every arm when the session exposes no compaction surface", async () => {
    const fx = makeTier3Fixture({ behavior: "already-compacted", capable: false });
    await expect(fx.run()).rejects.toMatchObject({
      details: { reason: "already-compacted", tiersAttempted: ["normal"] },
    });
    expect(fx.compact).toHaveBeenCalledTimes(1);
  });

  it("never runs for nothing-to-compact, which means too small rather than too big", async () => {
    const fx = makeTier3Fixture({ behavior: "nothing-to-compact" });
    const error = await fx.run().then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(ChatContextOverflowError);
    expect((error as ChatContextOverflowError).details).toMatchObject({
      reason: "nothing-to-compact",
      tiersAttempted: ["normal"],
    });
    expect(fx.appended).toHaveLength(0);
    expect(fx.events).toHaveLength(1);
    expect(meta(fx.events)).toMatchObject({ tier: "normal", outcome: "refused" });
  });

  it("never runs for the unsupported session shape", async () => {
    const fx = makeTier3Fixture({ behavior: "unsupported" });
    await expect(fx.run()).rejects.toMatchObject({ details: { reason: "unsupported" } });
    expect(fx.appended).toHaveLength(0);
  });

  it("rescues the compaction-error arm after both LLM tiers failed", async () => {
    const fx = makeTier3Fixture({ behavior: "error" });
    const result = await fx.run();
    expect(result.compacted).toBe(true);
    expect(result.fallback?.droppedMessageCount).toBe(3);
    // Tier 2 is legal after an error, so all three tiers are on the record.
    expect(meta(fx.events)).toMatchObject({
      tiersAttempted: ["normal", "aggressive", "fallback"],
      outcome: "compacted",
    });
    expect(fx.compact).toHaveBeenCalledTimes(2);
    expect(fx.events).toHaveLength(1);
  });

  it("rescues the empty-summary arm", async () => {
    const fx = makeTier3Fixture({ behavior: "empty-summary" });
    const result = await fx.run();
    expect(result.fallback?.droppedMessageCount).toBe(3);
    expect(meta(fx.events)).toMatchObject({ tier: "fallback", outcome: "compacted" });
    expect(fx.events).toHaveLength(1);
  });

  it("rescues the non-reducing-summary arm when the context is over the hard limit", async () => {
    const fx = makeTier3Fixture({ behavior: "non-reducing" });
    const result = await fx.run();
    expect(result.fallback?.contextTokensAfter).toBeLessThan(compactionTargetBudget(102_400));
    expect(meta(fx.events)).toMatchObject({ tier: "fallback", outcome: "compacted" });
  });

  it("rescues the measurement-unknown arm when the guard's own estimate is over the hard limit", async () => {
    const fx = makeTier3Fixture({ behavior: "measurement-unknown" });
    const result = await fx.run();
    expect(result.compacted).toBe(true);
    expect(meta(fx.events)).toMatchObject({ tier: "fallback", outcome: "compacted" });
  });

  it("rescues the still-over-limit arm after a reducing summary", async () => {
    const fx = makeTier3Fixture({ behavior: "still-over" });
    const result = await fx.run();
    expect(result.compacted).toBe(true);
    expect(meta(fx.events)).toMatchObject({
      tiersAttempted: ["normal", "fallback"],
      outcome: "compacted",
    });
  });

  it("re-attributes a floor-dominated refusal to static-floor, naming the floor", async () => {
    // 315 000 chars → a floor over the 76 800 target but under the 111 616 hard limit (so the
    // gate still enters the ladder), leaving no message budget at all. RUFU-183 review:
    // quoting pi's "Already compacted" here hid the real boundary — an operator (or triage
    // agent) reading `already-compacted` would retry compaction instead of trimming the tool
    // set or moving to a larger-window model, which is exactly the wrong lever.
    const fx = makeTier3Fixture({ behavior: "already-compacted", systemPrompt: "p".repeat(315_000) });
    const floor = staticContextFloorEstimate(fx.session)!;
    expect(floor).toBeGreaterThan(compactionTargetBudget(102_400));
    const error = await fx.run().then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(ChatContextOverflowError);
    const err = error as ChatContextOverflowError;
    expect(err.details).toMatchObject({ reason: "static-floor", tiersAttempted: ["normal"], floorTokens: floor });
    expect(err.message).toContain("reason=static-floor");
    expect(err.message).toContain(`static context floor of ${floor} tokens`);
    // Nothing was truncated: the zeros are the proof tier 3 refused rather than fake a reduction.
    expect(fx.appended).toHaveLength(0);
    expect(fx.events).toHaveLength(1);
    expect(meta(fx.events)).toMatchObject({
      reason: "static-floor",
      outcome: "refused",
      droppedMessageCount: 0,
      droppedTokens: 0,
      floorTokens: floor,
    });
  });

  it("keeps the refusal when the rebuilt transcript cannot be proven under the target", async () => {
    // The rebuild reports a context still over target, so the reduction is unproven: tier 3
    // must not trade the honest refusal for a weaker result. RUFU-183 review: the refusal must
    // still DISCLOSE the truncation, because `appendCompaction` is durable and Route A has no
    // deletion primitive — the branch IS shortened while the refusal stands, and hiding that
    // would leave the operator (and the next session resume) reading a lie.
    const fx = makeTier3Fixture({
      behavior: "already-compacted",
      rebuiltMessages: [{ role: "compactionSummary", summary: "u".repeat(600_000), tokensBefore: 200_000 }],
    });
    const error = await fx.run().then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(ChatContextOverflowError);
    const err = error as ChatContextOverflowError;
    expect(err.details).toMatchObject({ reason: "already-compacted", tiersAttempted: ["normal", "fallback"] });
    // The evidence names what was lost and what the honest re-measurement says.
    expect((err.details as Record<string, unknown>).tier3).toMatchObject({
      droppedMessageCount: 3,
      floorTokens: 100,
    });
    expect(err.message).toContain("the deterministic fallback truncated 3 messages");
    expect(err.message).toContain("the branch IS shortened on disk");
    // Attempted once (and only once) before the proof rejected it.
    expect(fx.appended).toHaveLength(1);
    expect(fx.events).toHaveLength(1);
    const row = meta(fx.events);
    expect(row).toMatchObject({ tier: "normal", outcome: "refused", droppedMessageCount: 3, floorTokens: 100 });
    // The audit's afterTokens describes the shortened state actually left behind — the same
    // honest number the error carries — not the pre-truncation fresh measurement.
    const after = row.afterTokens as number;
    expect((err.details as Record<string, { contextTokensAfter: number }>).tier3.contextTokensAfter).toBe(after);
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeLessThan(200_000);
    expect(after).toBeGreaterThanOrEqual(compactionTargetBudget(102_400));
  });

  it("skips tier 3 when the static floor cannot be measured (no honest proof exists)", async () => {
    const fx = makeTier3Fixture({ behavior: "already-compacted", systemPrompt: "" });
    await expect(fx.run()).rejects.toMatchObject({
      details: { reason: "already-compacted", tiersAttempted: ["normal"] },
    });
    expect(fx.appended).toHaveLength(0);
  });

  /*
  FNXC:ChatContextGuardTier3 2026-09-04-22:51:
  Requirement 7 (kill-switch parity) named at the tier-3 lane: with the operator opt-out the
  gate no-ops BEFORE any measurement, so a session whose every other tier-3 case appends a
  deterministic truncation must stay byte-untouched and emit no audit row. The general
  enabled:false skip is matrix case 12 of chat-context-guard.test.ts; this closes the tier-3
  visibility gap: turning the switch off cannot leave a half-run fallback behind.
  */
  it("bypasses tier 3 entirely under the operator kill switch (parity)", async () => {
    const fx = makeTier3Fixture({ behavior: "already-compacted" });
    const disabledSink = { recordRunAuditEvent: vi.fn() };
    const result = await ensureContextWithinCompactionThreshold(fx.session, {
      enabled: false,
      audit: { sink: disabledSink, sessionId: "chat-tier3-disabled" },
    });
    expect(result).toEqual({ compacted: false, contextTokens: null, threshold: null });
    expect(fx.compact).not.toHaveBeenCalled();
    expect(fx.appended).toHaveLength(0);
    expect(disabledSink.recordRunAuditEvent).not.toHaveBeenCalled();
    // The fixture's own sink stayed disconnected from this run; the guard emitted nothing
    // anywhere: a disabled gate writes no telemetry by design.
    expect(fx.events).toHaveLength(0);
  });

});

/*
FNXC:ChatContextGuardTier3 2026-09-04-22:26:
Route integrity against the REAL pi SessionManager, not the fake: tier 3's whole contract is
that the digest is written through pi's own public append API into pi's own durable JSONL, so
the convergence claim is only real if (1) the marked digest and the verbatim preserved tail
survive an on-disk round trip, (2) a subsequent send proceeds normally instead of re-entering
the ladder, and (3) a RESUMED session (fresh manager over the same file — the saneca #1954
shape: the deadlock state lives on disk) still reaches tier 3 identically. A fake-only test
would pass even if the guard hand-wrote its own transcript format.
*/
describe("chat-context-guard tier 3 route integrity (real pi SessionManager on disk)", () => {
  /** Raw on-disk compaction entries, parsed straight from the session JSONL (no manager cache). */
  function diskCompactions(file: string): Array<{
    summary: string;
    firstKeptEntryId: string;
    fromHook?: boolean;
    details?: { deterministicFallback?: boolean };
  }> {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry?.type === "compaction");
  }

  function textOf(message: unknown): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => String((part as { text?: string }).text ?? "")).join("");
    return "";
  }

  it("persists the marked digest and the verbatim tail through a real on-disk round trip, proceeds on the next send, and converges again after resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rufu-183-route-"));
    try {
      const manager = SessionManager.create(process.cwd(), dir);
      // Realistic shapes: pi only creates the JSONL once an assistant message exists (a
      // lazy-flush guard in _persist), and its estimateTokens counts an assistant message's
      // TEXT BLOCKS — a plain string on an assistant message estimates as 0 tokens, so real
      // transcript shapes (array content) are load-bearing for the fresh measurement here.
      const id3 = manager.appendMessage({ role: "user", content: "x".repeat(240_000) });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "y".repeat(80_000) }] });
      // The live compaction marker is what makes pi's own compact() answer `Already compacted`
      // forever after — the deadlock RUFU-183 recovers from. Created via the public API.
      manager.appendCompaction("c".repeat(400), id3, 120_000, undefined, true);
      manager.appendMessage({ role: "user", content: "z".repeat(80_000) });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "w".repeat(80_000) }] });
      const entryCountBefore = manager.getEntries().length;

      const events: unknown[] = [];
      const sink = { recordRunAuditEvent: vi.fn((input: unknown) => events.push(input)) };
      const compact = vi.fn(async () => {
        throw new Error("Already compacted");
      });
      let usageTokens = 200_000; // provider-reported: over the 102 400 threshold
      const session = {
        model: { contextWindow: 128_000, maxTokens: 16_384 },
        systemPrompt: "p".repeat(350),
        state: { messages: [...manager.buildSessionContext().messages] },
        getContextUsage: () => ({ tokens: usageTokens, contextWindow: 128_000, percent: 156 }),
        compact,
        sessionManager: manager,
      } as unknown as CompactionGateSession;

      const first = await ensureContextWithinCompactionThreshold(session, {
        enabled: true,
        audit: { sink, sessionId: "chat-rufu-183-route" },
      });
      expect(first.compacted).toBe(true);
      expect(first.fallback?.droppedMessageCount).toBe(3); // marker digest + both pre-compaction turns
      const file = manager.getSessionFile();
      expect(file).toBeDefined();

      // (1) Round trip: the digest is on disk exactly once, marked, hook-flagged, pointing at
      // the entry the plan promised to keep — and a reopened manager rebuilds the same
      // shortened context: [digest, z-turn, w-turn] with the tail byte-identical.
      const persisted = diskCompactions(file!).filter((e) => e.details?.deterministicFallback === true);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.summary.length).toBeGreaterThan(0);
      expect(persisted[0]!.fromHook).toBe(true);
      const resumed = SessionManager.open(file!);
      const resumedMessages = resumed.buildSessionContext().messages;
      expect(resumedMessages.map((m) => (m as { role?: string }).role)).toEqual([
        "compactionSummary",
        "user",
        "assistant",
      ]);
      expect(textOf(resumedMessages[1])).toBe("z".repeat(80_000));
      expect(textOf(resumedMessages[2])).toBe("w".repeat(80_000));
      // Exactly one transcript write for the whole first send (the durable digest).
      expect(manager.getEntries().length).toBe(entryCountBefore + 1);

      // (2) Second send with the post-truncation context: proceeds normally, no ladder, no new
      // digest, no compaction call — the deadlock does not swallow healthy follow-up sends.
      usageTokens = first.fallback!.contextTokensAfter;
      const second = await ensureContextWithinCompactionThreshold(session, {
        enabled: true,
        audit: { sink, sessionId: "chat-rufu-183-route" },
      });
      expect(second.compacted).toBe(false);
      expect(second.fallback).toBeUndefined();
      expect(compact).toHaveBeenCalledTimes(1); // only the first send's tier-1 attempt
      expect(manager.getEntries().length).toBe(entryCountBefore + 1);
      expect(events).toHaveLength(1); // the rescue's single row; a skipped send emits none

      // (3) Resume shape (saneca class): a FRESH manager over the same file — the compaction
      // marker lives on disk, so pi would keep refusing forever — reaches tier 3 identically
      // when the resumed session overflows again, and converges again.
      resumed.appendMessage({ role: "user", content: "q".repeat(280_000) });
      const resumedCompact = vi.fn(async () => {
        throw new Error("Already compacted");
      });
      const resumedSession = {
        model: { contextWindow: 128_000, maxTokens: 16_384 },
        systemPrompt: "p".repeat(350),
        state: { messages: [...resumed.buildSessionContext().messages] },
        getContextUsage: () => ({ tokens: 200_000, contextWindow: 128_000, percent: 156 }),
        compact: resumedCompact,
        sessionManager: resumed,
      } as unknown as CompactionGateSession;
      const third = await ensureContextWithinCompactionThreshold(resumedSession, {
        enabled: true,
        audit: { sink, sessionId: "chat-rufu-183-route" },
      });
      expect(third.compacted).toBe(true);
      // The resumed truncation drops the first digest + both preserved turns and keeps the new
      // 280 000-char turn (alone it fits the message budget); the tail is never dropped.
      expect(third.fallback?.droppedMessageCount).toBe(3);
      expect(third.fallback!.contextTokensAfter).toBeLessThan(compactionTargetBudget(102_400));
      const persistedAfterResume = diskCompactions(file!).filter((e) => e.details?.deterministicFallback === true);
      expect(persistedAfterResume).toHaveLength(2); // convergence stays durable across resume
      const reopenedAgain = SessionManager.open(file!);
      const finalMessages = reopenedAgain.buildSessionContext().messages;
      expect(finalMessages.map((m) => (m as { role?: string }).role)).toEqual(["compactionSummary", "user"]);
      expect(textOf(finalMessages[1])).toBe("q".repeat(280_000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
