/**
 * RUFU-183 tier 3: the deterministic (non-LLM) fallback compaction builder.
 *
 * Two things must hold and both are cheap to prove, so they are proven HERE rather than at runtime:
 *  1. Convergence is arithmetic, not optimism — every returned plan fits the message budget by
 *     construction (digestTokens + keptTokens < budget), and the newest turn survives verbatim.
 *  2. The seam is non-LLM — the module imports only pi's pure token/projection helpers, never the
 *     summarizer. That is asserted by a source-construct guard, not by a comment.
 *
 * The fakes are shaped like real pi `SessionEntry` objects so the module's own use of the real
 * `sessionEntryToContextMessages` / `estimateTokens` is what the assertions exercise — no mocked
 * estimator that could drift from the one the gate measures with.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildDeterministicFallbackCompaction } from "../chat-context-deterministic-fallback.js";

const TS = "2026-01-01T00:00:00.000Z";

function messageEntry(id: string, role: string, chars: number, textPrefix = ""): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: TS,
    message: { role, content: [{ type: "text", text: `${textPrefix}${"x".repeat(chars)}` }] },
  } as unknown as SessionEntry;
}

function imageEntry(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: TS,
    message: { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image" }] },
  } as unknown as SessionEntry;
}

function compactionEntry(id: string, summaryPrefix: string, chars: number): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: TS,
    summary: `${summaryPrefix}${"y".repeat(chars)}`,
    firstKeptEntryId: "nonexistent-root",
    tokensBefore: 1,
  } as unknown as SessionEntry;
}

// A large context: two heavy OLD turns then a small NEW turn. Splitting must drop the old turns and
// keep the new user+assistant pair (index 2 onward) verbatim.
function heavyThenNewTurn(): SessionEntry[] {
  return [
    messageEntry("u1", "user", 8000, "OLDU1"),
    messageEntry("a1", "assistant", 8000),
    messageEntry("u2", "user", 40, "NEWU2"),
    messageEntry("a2", "assistant", 40),
  ];
}

describe("buildDeterministicFallbackCompaction", () => {
  it("splits so the plan provably fits the message budget and keeps the newest turn", () => {
    const plan = buildDeterministicFallbackCompaction({
      activeEntries: heavyThenNewTurn(),
      messageTokenBudget: 200,
      tokensBefore: 4006,
    });
    expect(plan).not.toBeNull();
    const result = plan!;
    // Kept suffix is exactly the newest turn (u2 + a2).
    expect(result.firstKeptEntryId).toBe("u2");
    expect(result.keptEntryCount).toBe(2);
    expect(result.droppedEntryCount).toBe(2);
    // Convergence by construction, priced with pi's own compactionSummary estimator.
    expect(result.digestTokens).toBe(Math.ceil(result.summary.length / 4));
    expect(result.digestTokens + result.keptTokens).toBeLessThan(200);
    // The digest DECLARES itself a deterministic truncation and names the pre-reduction size.
    expect(result.summary).toContain("deterministic-truncation");
    expect(result.summary).toContain("Truncated from 4006 tokens");
    // Dropped oldest content is folded in; the kept newest turn is not duplicated into the digest.
    expect(result.summary).toContain("OLDU1");
    expect(result.summary).not.toContain("NEWU2");
  });

  it("marks dropped image parts instead of silently dropping them", () => {
    const plan = buildDeterministicFallbackCompaction({
      activeEntries: [
        imageEntry("img1"),
        messageEntry("a1", "assistant", 4000),
        messageEntry("u2", "user", 40),
        messageEntry("a2", "assistant", 40),
      ],
      messageTokenBudget: 200,
      tokensBefore: 1100,
    });
    expect(plan).not.toBeNull();
    expect(plan!.summary).toContain("[image omitted]");
  });

  it("keeps the newest turn even when only the last turn fits", () => {
    // Budget is roomy for the newest turn + label but nowhere near the old turns, so the split is
    // forced to the very last turn start.
    const plan = buildDeterministicFallbackCompaction({
      activeEntries: heavyThenNewTurn(),
      messageTokenBudget: 150,
      tokensBefore: 4006,
    });
    expect(plan?.firstKeptEntryId).toBe("u2");
    expect(plan!.digestTokens + plan!.keptTokens).toBeLessThan(150);
  });

  it("refuses when even the newest turn plus the mandatory label cannot fit", () => {
    // staticFloor already ate the budget: only the newest turn's ~6 tokens survive, and the
    // truncation label needs ~100 tokens, so deterministic compaction cannot converge.
    const plan = buildDeterministicFallbackCompaction({
      activeEntries: heavyThenNewTurn(),
      messageTokenBudget: 50,
      tokensBefore: 4006,
    });
    expect(plan).toBeNull();
  });

  it("refuses a non-positive or non-finite budget (the floor alone is at/over threshold)", () => {
    for (const budget of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildDeterministicFallbackCompaction({ activeEntries: heavyThenNewTurn(), messageTokenBudget: budget, tokensBefore: 1 })).toBeNull();
    }
  });

  it("refuses when there is nothing to drop or no turn-start boundary to cut at", () => {
    expect(buildDeterministicFallbackCompaction({ activeEntries: [messageEntry("u1", "user", 8000)], messageTokenBudget: 10_000, tokensBefore: 1 })).toBeNull();
    // Two assistant messages: no turn start anywhere → no legal cut point.
    expect(
      buildDeterministicFallbackCompaction({
        activeEntries: [messageEntry("a1", "assistant", 4000), messageEntry("a2", "assistant", 4000)],
        messageTokenBudget: 10_000,
        tokensBefore: 1,
      }),
    ).toBeNull();
  });

  describe("supersession past a live compaction (route-integrity, not optimism)", () => {
    const withLiveCompaction = (): SessionEntry[] => [
      compactionEntry("C0", "OLDSUM", 4000),
      messageEntry("u1", "user", 4000, "OLDU1"),
      messageEntry("a1", "assistant", 4000),
      messageEntry("u2", "user", 40, "NEWU2"),
      messageEntry("a2", "assistant", 40),
    ];

    it("without the bound it would cut before the live compaction (the double-count trap)", () => {
      // Budget roomy enough that a naive split lands on the first turn start — which sits BEFORE the
      // live compaction in leaf-path order. Re-included by buildContextEntries, that compaction would
      // be re-projected and the context would not shrink as much as the plan promised.
      const naive = buildDeterministicFallbackCompaction({
        activeEntries: withLiveCompaction(),
        messageTokenBudget: 3200,
        tokensBefore: 4026,
      });
      expect(naive?.firstKeptEntryId).toBe("u1");
    });

    it("with minSplitIndex past the live compaction it supersedes cleanly and folds it", () => {
      const plan = buildDeterministicFallbackCompaction({
        activeEntries: withLiveCompaction(),
        messageTokenBudget: 3200,
        tokensBefore: 4026,
        minSplitIndex: 3,
      });
      expect(plan).not.toBeNull();
      // The kept suffix begins at the newest turn (after the compaction), never at u1.
      expect(plan!.firstKeptEntryId).toBe("u2");
      expect(plan!.digestTokens + plan!.keptTokens).toBeLessThan(3200);
      // Both the old compaction summary AND the older kept tail are folded into the digest.
      expect(plan!.summary).toContain("OLDSUM");
      expect(plan!.summary).toContain("OLDU1");
      expect(plan!.summary).not.toContain("NEWU2");
    });
  });

  it("is a provably non-LLM seam: only pi's pure helpers may be imported from the package", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../chat-context-deterministic-fallback.ts"), "utf8");
    const match = /import\s*\{([^}]*)\}\s*from\s*"@earendil-works\/pi-coding-agent"/.exec(src);
    expect(match).not.toBeNull();
    const imported = match![1]!
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    // The seam depends on the two pure functions it prices with, and nothing else from the package.
    expect(imported).toEqual(expect.arrayContaining(["estimateTokens", "sessionEntryToContextMessages"]));
    for (const name of imported) {
      expect(["estimateTokens", "sessionEntryToContextMessages", "SessionEntry"]).toContain(name);
    }
    // Executable source (comments stripped — prose is allowed to NAME the thing the seam forbids) must
    // never import or call the summarizer. This is a code-construct ratchet, not a comment assertion.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code).not.toMatch(/generateSummary/);
    expect(code).not.toMatch(/\bcompact\s*\(/);
  });
});
