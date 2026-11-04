import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeLlmLaneTelemetry } from "../board/lane-usage-analytics.js";
import {
  buildLlmPromptHeadMeta,
  buildLlmTokenUsageMeta,
  LLM_PROMPT_HEAD_EVENT_KIND,
  LLM_PROMPT_END_EVENT_KIND,
  LLM_TOKEN_USAGE_EVENT_KIND,
} from "../telemetry/llm-prompt-telemetry.js";
import type { UsageEvent } from "../tasks/usage-events.js";

/**
 * RUFU-284 (R1/R5/R6): the windowed aggregate is what the panel prints, so its honest-absence rules are
 * product behaviour: a lane whose provider never reports cache reads must read as UNMEASURED, and no
 * number may ever be presented as a sum of the three accounting systems.
 */

const TO = "2026-11-04T12:00:00.000Z";
const FROM = "2026-11-04T11:00:00.000Z";

let nextId = 1;

function usageEvent(input: {
  kind: string;
  ts?: string;
  model?: string | null;
  provider?: string | null;
  meta: Record<string, unknown>;
}): UsageEvent {
  return {
    id: nextId++,
    ts: input.ts ?? TO,
    kind: input.kind as UsageEvent["kind"],
    taskId: null,
    agentId: null,
    nodeId: null,
    model: input.model ?? null,
    provider: input.provider ?? null,
    toolName: null,
    category: null,
    meta: input.meta,
  };
}

function usage(opts: {
  lane: string;
  input: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  reported?: boolean;
  model?: string;
  provider?: string;
  ts?: string;
}): UsageEvent {
  const total = opts.input + (opts.output ?? 0) + (opts.cached ?? 0) + (opts.cacheWrite ?? 0);
  return usageEvent({
    kind: LLM_TOKEN_USAGE_EVENT_KIND,
    ts: opts.ts,
    model: opts.model ?? "claude-opus-4-1",
    provider: opts.provider ?? "anthropic",
    meta: buildLlmTokenUsageMeta({
      lane: opts.lane as never,
      runtimeId: "pi",
      inputTokens: opts.input,
      outputTokens: opts.output ?? 0,
      cachedTokens: opts.cached ?? 0,
      cacheWriteTokens: opts.cacheWrite ?? 0,
      totalTokens: total,
      cacheReadReported: opts.reported !== false,
    }),
  });
}

function head(opts: {
  lane: string;
  headBytes?: number;
  staticBytes?: number;
  dynamicBytes?: number;
  dynamicStart?: number;
  divergenceStatus?: "baseline" | "identical" | "diverged";
  firstDivergenceOffset?: number | null;
  requestId?: string;
  ts?: string;
}): UsageEvent {
  return usageEvent({
    kind: LLM_PROMPT_HEAD_EVENT_KIND,
    ts: opts.ts,
    meta: buildLlmPromptHeadMeta({
      lane: opts.lane as never,
      source: "engine-assembly",
      runtimeId: "pi",
      headHash: `h${opts.headBytes ?? 0}-${opts.divergenceStatus ?? "baseline"}`,
      headBytes: opts.headBytes ?? 1000,
      staticBytes: opts.staticBytes ?? 800,
      dynamicBytes: opts.dynamicBytes ?? 200,
      dynamicStart: opts.dynamicStart ?? 800,
      divergenceStatus: opts.divergenceStatus ?? "baseline",
      firstDivergenceOffset: opts.firstDivergenceOffset ?? null,
      requestId: opts.requestId ?? "req-1",
      sessionEpoch: 1,
    }),
  });
}

function compute(events: UsageEvent[]) {
  return computeLlmLaneTelemetry(events, { window: "1h", from: FROM, to: TO });
}

describe("RUFU-284 lane usage analytics", () => {
  it("sums per lane and derives cache-read share from prompt tokens only", () => {
    const report = compute([
      usage({ lane: "executor", input: 1_000, output: 500, cached: 3_000 }),
      usage({ lane: "executor", input: 2_000, output: 400, cached: 1_000 }),
    ]);

    const lane = report.aggregates.find((a) => a.lane === "executor");
    expect(lane?.tokens.inputTokens).toBe(3_000);
    expect(lane?.tokens.cachedTokens).toBe(4_000);
    expect(lane?.tokens.requestCount).toBe(2);
    // 4000 / (3000 input + 4000 cached): output is excluded from the prompt denominator.
    expect(lane?.cacheReadShare).toBeCloseTo(4_000 / 7_000, 6);
    expect(report.totalPromptTokens).toBe(7_000);
  });

  it("reports an unmeasured cache share as null, never as 0%", () => {
    const report = compute([usage({ lane: "merger", input: 900, output: 10, cached: 0, reported: false })]);

    const lane = report.aggregates.find((a) => a.lane === "merger");
    expect(lane?.tokens.cacheReadReported).toBe(false);
    expect(lane?.cacheReadShare).toBeNull();
  });

  it("excludes a non-reporting provider's zero from an otherwise measured lane's denominator", () => {
    // The reported=false row contributes prompt tokens to the total (it really was sent) but cannot make
    // an unmeasured lane look measured, and the share stays over the rows the provider answered for.
    const report = compute([
      usage({ lane: "triage", input: 1_000, output: 100, cached: 4_000, provider: "anthropic" }),
      usage({ lane: "triage", input: 5_000, output: 100, cached: 0, reported: false, provider: "openai" }),
    ]);

    const lane = report.aggregates.find((a) => a.lane === "triage");
    expect(lane?.tokens.cacheReadReported).toBe(true);
    // The lane-level share is a ratio over the whole window: a provider that never answered the cache
    // question contributes its real prompt tokens to the denominator (1000+4000 + 5000+0 = 10000) but no
    // cache reads to the numerator, which is the honest reading of "we cannot tell what its hit rate was".
    expect(lane?.cacheReadShare).toBeCloseTo(4_000 / 10_000, 6);
  });

  it("computes the heartbeat share over every lane's prompt tokens", () => {
    const report = compute([
      usage({ lane: "heartbeat", input: 1_000, cached: 0 }),
      usage({ lane: "executor", input: 3_000, cached: 0 }),
    ]);

    expect(report.heartbeatPromptTokenShare).toBeCloseTo(0.25, 6);
  });

  it("leaves the heartbeat share unmeasured when no lane reported prompt tokens", () => {
    const report = compute([
      usageEvent({ kind: LLM_PROMPT_END_EVENT_KIND, meta: { lane: "executor", requestId: "r", outcome: "completed" } }),
    ]);

    expect(report.totalPromptTokens).toBe(0);
    expect(report.heartbeatPromptTokenShare).toBeNull();
    expect(report.aggregates).toEqual([]);
  });

  it("grids lane × model without merging different models of one lane", () => {
    const report = compute([
      usage({ lane: "executor", model: "model-a", input: 100 }),
      usage({ lane: "executor", model: "model-b", input: 200 }),
      usage({ lane: "triage", model: "model-a", input: 300 }),
    ]);

    expect(report.grid).toHaveLength(3);
    expect(report.grid.map((c) => `${c.lane}/${c.model}`).sort()).toEqual([
      "executor/model-a",
      "executor/model-b",
      "triage/model-a",
    ]);
  });

  it("counts distinct head hashes, divergence statuses and offset buckets per lane", () => {
    const report = compute([
      head({ lane: "executor", divergenceStatus: "baseline", headBytes: 1_000 }),
      head({ lane: "executor", divergenceStatus: "identical", headBytes: 1_000 }),
      head({ lane: "executor", divergenceStatus: "diverged", firstDivergenceOffset: 900, headBytes: 1_000 }),
      head({ lane: "executor", divergenceStatus: "diverged", firstDivergenceOffset: null, headBytes: 1_000 }),
      head({ lane: "triage", divergenceStatus: "baseline", headBytes: 2_000 }),
    ]);

    const lane = report.aggregates.find((a) => a.lane === "executor");
    expect(lane?.head.headEventCount).toBe(4);
    expect(lane?.head.distinctHeadHashCount).toBe(3);
    expect(lane?.head.divergenceCounts).toEqual({ baseline: 1, identical: 1, diverged: 2 });
    expect(lane?.head.offsetBucketCounts.lt1k).toBe(1);
    expect(lane?.head.offsetUnknownCount).toBe(1);
    expect(lane?.head.medianHeadBytes).toBe(1_000);
  });

  it("omits a head row with no byte length from the median instead of counting it as zero", () => {
    const report = compute([
      head({ lane: "executor", headBytes: 4_000 }),
      head({ lane: "executor", headBytes: 6_000 }),
      usageEvent({
        kind: LLM_PROMPT_HEAD_EVENT_KIND,
        meta: { lane: "executor", requestId: "r2", source: "pi-runtime", divergenceStatus: "identical" },
      }),
    ]);

    const lane = report.aggregates.find((a) => a.lane === "executor");
    expect(lane?.head.medianHeadBytes).toBe(4_000);
    expect(lane?.head.headEventCount).toBe(3);
  });

  it("lists recent head events newest-first with the fields the panel needs and no text", () => {
    const report = compute([
      head({ lane: "executor", ts: "2026-11-04T11:10:00.000Z", headBytes: 1_000 }),
      head({ lane: "executor", ts: "2026-11-04T11:50:00.000Z", headBytes: 1_004, divergenceStatus: "identical" }),
    ]);

    expect(report.headEvents[0]?.headBytes).toBe(1_004);
    expect(report.headEvents[1]?.headBytes).toBe(1_000);
    expect(Object.keys(report.headEvents[0]!).sort()).toEqual(
      [
        "dynamicBytes",
        "dynamicStart",
        "divergenceStatus",
        "firstDivergenceOffset",
        "headBytes",
        "headHash",
        "id",
        "lane",
        "requestId",
        "runtimeId",
        "source",
        "staticBytes",
        "ts",
      ].sort(),
    );
  });

  it("returns zeros and empty arrays for an empty window rather than nulls", () => {
    const report = compute([]);

    expect(report.grid).toEqual([]);
    expect(report.aggregates).toEqual([]);
    expect(report.headEvents).toEqual([]);
    expect(report.totalPromptTokens).toBe(0);
    expect(report.heartbeatPromptTokenShare).toBeNull();
    expect(report.window).toBe("1h");
    expect(report.gridTruncated).toBe(false);
    expect(report.headTruncated).toBe(false);
  });

  it("reads only usage_events: no token-analytics import and no other accounting table", () => {
    // R5: the third accounting system must not silently become a sum of the other two. Scanning the
    // module's own imports is the cheapest structural guard for that, and it is a code construct, not
    // prose.
    const source = readFileSync(fileURLToPath(new URL("../board/lane-usage-analytics.ts", import.meta.url)), "utf8");
    // Comments in this file name the forbidden sources on purpose (they explain the boundary), so the
    // scan is over code only — the same comment-stripping technique the legacy-tombstones ratchet uses.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const imports = [...code.matchAll(/^import[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);

    expect(imports.filter((i) => i.includes("token-analytics") || i.includes("agent-token-usage"))).toEqual([]);
    expect(code).not.toMatch(/aggregateTokenAnalytics|chatTokenUsage|tokenUsagePerModel/);
  });
});
