import { describe, expect, it } from "vitest";
import { rankTurns, rankSessions } from "./rankings.js";

const usage = (model = "claude-sonnet-5") => [{ model, inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0,
  cacheWriteHourTokens: 0, outputTokens: 100, reasoningTokens: null, fast: false, longContext: false }];
const rate = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, source: "recorded" };
const turn = (over: Record<string, unknown> = {}) => ({ sessionId: "s1", hostId: "j", provider: "claude", title: "T",
  nativeTurnId: "t1", ordinal: 0, at: "2026-09-20T00:00:00.000Z", usage: usage(), usageComplete: true, pricing: null, ...over });
const scan = (candidates: unknown[], over: Record<string, unknown> = {}) =>
  ({ candidates, scanned: candidates.length, truncated: false, withoutUsage: 0, ...over }) as never;

describe("expensive work rankings", () => {
  it("orders by cost and reports the total across every priced row, not just the shown ones", () => {
    const cheap = turn({ nativeTurnId: "cheap", usage: usage() });
    const dear = turn({ nativeTurnId: "dear", usage: [{ ...usage()[0], outputTokens: 100000 }] });
    const ranking = rankTurns(scan([cheap, dear]), undefined, 1);
    expect(ranking.entries).toHaveLength(1);
    expect(ranking.entries[0]!.nativeTurnId).toBe("dear");
    // The total must cover both, or the shown list would understate spend.
    expect(ranking.coverage.pricedTotalUsd).toBeGreaterThan(ranking.entries[0]!.usd);
    expect(ranking.coverage.priced).toBe(2);
  });

  it("counts rows it could not price instead of dropping them from the picture", () => {
    const unpriceable = turn({ nativeTurnId: "unknown-model", usage: usage("model-with-no-rate") });
    const ranking = rankTurns(scan([turn(), unpriceable]), undefined);
    expect(ranking.entries).toHaveLength(1);
    expect(ranking.coverage.unpriced).toBe(1);
    expect(ranking.coverage.priced).toBe(1);
  });

  it("carries rows with no usage and truncation through to coverage", () => {
    const ranking = rankTurns(scan([turn()], { withoutUsage: 4, truncated: true, scanned: 5 }), undefined);
    expect(ranking.coverage).toMatchObject({ withoutUsage: 4, truncated: true, scanned: 5 });
  });

  it("ranks a stamped turn on its recorded rates and says so", () => {
    const stamped = turn({ pricing: { asOf: "2026-01-01", source: "then", rates: { "claude_code:claude-sonnet-5": rate } } });
    const ranking = rankTurns(scan([stamped]), undefined);
    expect(ranking.entries[0]).toMatchObject({ recordedRates: true, recalculated: false });
    expect(ranking.entries[0]!.usd).toBeCloseTo(0.003 + 0.0015, 10);
  });

  it("marks an unstamped historical row as a recalculation rather than a billed cost", () => {
    const ranking = rankTurns(scan([turn({ at: "2026-01-01T00:00:00.000Z" })]), undefined);
    expect(ranking.entries[0]).toMatchObject({ recordedRates: false, recalculated: true });
  });

  it("ranks a partially priced row on what is known and still flags the gap", () => {
    const mixed = turn({ usage: [...usage(), { ...usage("no-rate-model")[0] }] });
    const ranking = rankTurns(scan([mixed]), undefined);
    expect(ranking.entries).toHaveLength(1);
    expect(ranking.entries[0]!.usd).toBeGreaterThan(0);
  });

  it("ranks sessions from their own usage", () => {
    const session = { sessionId: "s1", hostId: "j", provider: "claude", title: "S",
      observedAt: "2026-09-20T00:00:00.000Z", usage: usage(), usageComplete: true };
    const ranking = rankSessions(scan([session]), undefined);
    expect(ranking.entries[0]).toMatchObject({ sessionId: "s1", hostId: "j" });
    expect(ranking.entries[0]!.nativeTurnId).toBeUndefined();
  });
});
