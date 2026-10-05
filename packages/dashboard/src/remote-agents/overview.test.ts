import { describe, expect, it } from "vitest";
import type { RankingScan, RankingSessionCandidate, Attribution } from "@fusion/core";
import { summarizeOverview } from "./overview.js";

/*
FNXC:ExternalSessionOverview 2026-09-24-08:12:
The aggregate's honesty rules: unpriced work is counted and excluded rather than silently dropped, truncation
survives into the answer, and the Fusion-run figure is a SPLIT of the external total rather than something to
add to task telemetry.
*/
const band = (model: string, input: number, output: number) => ({
  model, inputTokens: input, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0,
  outputTokens: output, reasoningTokens: null, fast: false, longContext: false });

const candidate = (over: Partial<RankingSessionCandidate> = {}): RankingSessionCandidate => ({
  sessionId: "s1", hostId: "m3", provider: "codex", title: "Session", nativeSessionId: "native-1",
  observedAt: "2026-09-20T10:00:00.000Z", usage: [band("gpt-5.6-sol", 1_000_000, 100_000)], usageComplete: true, ...over });

const scan = (candidates: RankingSessionCandidate[], over: Partial<RankingScan<RankingSessionCandidate>> = {}):
  RankingScan<RankingSessionCandidate> => ({ candidates, scanned: candidates.length, truncated: false, withoutUsage: 0, ...over });

describe("external session cost overview", () => {
  it("totals priced sessions and splits them by day, model and server", () => {
    const overview = summarizeOverview(scan([
      candidate(),
      candidate({ sessionId: "s2", hostId: "m5", observedAt: "2026-09-21T10:00:00.000Z" }),
      candidate({ sessionId: "s3", hostId: "m3", observedAt: "2026-09-20T20:00:00.000Z" }),
    ]), undefined);
    expect(overview.totalUsd).toBeGreaterThan(0);
    // The day buckets partition the total exactly; a breakdown that does not sum to the headline is a bug.
    expect(overview.byDay.reduce((sum, b) => sum + b.usd, 0)).toBeCloseTo(overview.totalUsd, 10);
    expect(overview.byDay.map(b => b.key)).toEqual(["2026-09-20", "2026-09-21"]);
    expect(overview.byDay[0]!.sessions).toBe(2);
    expect(overview.byHost.map(b => b.key).sort()).toEqual(["m3", "m5"]);
    expect(overview.byModel.map(b => b.key)).toEqual(["gpt-5.6-sol"]);
    expect(overview.coverage).toMatchObject({ scanned: 3, priced: 3, unpriced: 0, truncated: false });
  });

  it("counts sessions it could not price instead of dropping them from the answer", () => {
    // An unmapped provider has no rate table, so its usage cannot be priced.
    const overview = summarizeOverview(scan([candidate(), candidate({ sessionId: "s2", provider: "manual-test" })]), undefined);
    expect(overview.coverage.priced).toBe(1);
    expect(overview.coverage.unpriced).toBe(1);
    // The unpriced session contributes nothing rather than an invented amount.
    expect(overview.byDay.reduce((sum, b) => sum + b.sessions, 0)).toBe(1);
  });

  it("carries truncation and usage-free counts through to the answer", () => {
    const overview = summarizeOverview(scan([candidate()], { scanned: 2000, truncated: true, withoutUsage: 7 }), undefined);
    expect(overview.coverage).toMatchObject({ scanned: 2000, truncated: true, withoutUsage: 7 });
  });

  it("reports Fusion-run cost as a split of this total, never as a separate addable figure", () => {
    const attributed = new Map<string, Attribution>([
      ["s1", { taskId: "FN-1", cliSessionId: "cli-1", ambiguous: false }],
      ["s2", { taskId: null, cliSessionId: null, ambiguous: true }],
    ]);
    const overview = summarizeOverview(scan([candidate(), candidate({ sessionId: "s2" }), candidate({ sessionId: "s3" })]), undefined, attributed);
    expect(overview.fusionAttributed.sessions).toBe(1);
    expect(overview.fusionAttributed.ambiguous).toBe(1);
    // The split is part of the total, so it can never exceed it.
    expect(overview.fusionAttributed.usd).toBeLessThan(overview.totalUsd);
    expect(overview.fusionAttributed.usd).toBeCloseTo(overview.totalUsd / 3, 10);
  });

  it("attributes nothing when reconciliation found nothing, without implying the sessions are separate", () => {
    const overview = summarizeOverview(scan([candidate()]), undefined);
    expect(overview.fusionAttributed).toEqual({ sessions: 0, usd: 0, ambiguous: 0 });
    expect(overview.totalUsd).toBeGreaterThan(0);
  });

  it("buckets an undated session explicitly rather than discarding it", () => {
    const overview = summarizeOverview(scan([candidate({ observedAt: null })]), undefined);
    expect(overview.byDay.map(b => b.key)).toEqual(["undated"]);
    expect(overview.byDay[0]!.usd).toBeCloseTo(overview.totalUsd, 10);
  });

  it("is empty, not zero-with-confidence, when nothing reported usage", () => {
    const overview = summarizeOverview(scan([candidate({ usage: [] })], { withoutUsage: 1 }), undefined);
    expect(overview.totalUsd).toBe(0);
    expect(overview.byDay).toEqual([]);
    expect(overview.coverage).toMatchObject({ priced: 0, withoutUsage: 1 });
  });
});
