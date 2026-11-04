/**
 * RUFU-284 real-schema round-trip for LLM lane telemetry.
 *
 * FNXC:LaneTelemetry 2026-11-04-06:10:
 * Every other RUFU-284 test reaches the sinks through fakes, which proves the builders and the maths but
 * says nothing about whether the shipped `project.usage_events` table accepts the three new kinds at all.
 * This file is the DB audit the spec asks for, automated: `emitUsageEvent` is FAIL-SOFT (a CHECK
 * violation, an over-long column, or any other rejection comes back as `false`, never as a thrown error),
 * so an assertion that a write returned `true` against real PostgreSQL is the proof that no migration is
 * required and that the async read-back returns the row the writer claimed to store. The window test then
 * runs against real rows: a 30-minute-old row must appear in the 1h window and be absent from the 10m
 * window, which is the delimiting the operator's panel depends on.
 *
 * The last case is the privacy barrier measured on stored bytes rather than on a builder's intent: the
 * meta of every telemetry row must contain ONLY the declared key vocabulary, and no value may look like
 * prose. Prompt text is unrepresentable in the builders, and this is the pin that keeps a later writer
 * from smuggling it into a row that already exists.
 *
 * Auto-skips via pgDescribe when PostgreSQL is unavailable.
 */
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { emitUsageEvent, queryUsageEvents } from "../../task-store/async/async-events.js";
import { aggregateLlmLaneTelemetry } from "../../board/lane-usage-analytics.js";
import {
  buildLlmPromptEndMeta,
  buildLlmPromptHeadMeta,
  buildLlmTokenUsageMeta,
  LLM_PROMPT_END_EVENT_KIND,
  LLM_PROMPT_HEAD_EVENT_KIND,
  LLM_TOKEN_USAGE_EVENT_KIND,
} from "../../telemetry/llm-prompt-telemetry.js";

const pgTest = pgDescribe;

const PROJECT = "p1";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REQ_1 = "11111111-1111-4111-8111-111111111111";
const REQ_2 = "22222222-2222-4222-8222-222222222222";

/** Closed key vocabulary for all three kinds; anything else in a stored row is out of contract. */
const ALLOWED_META_KEYS = new Set<string>([
  "lane",
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "cacheWriteTokens",
  "totalTokens",
  "cacheReadReported",
  "sourceKind",
  "requestId",
  "headHash",
  "headBytes",
  "staticBytes",
  "dynamicBytes",
  "dynamicStart",
  "divergenceStatus",
  "firstDivergenceOffset",
  "offsetBucket",
  "source",
  "runtimeId",
  "sessionEpoch",
  "outcome",
  "durationMs",
]);

pgTest("LLM lane telemetry on the real usage_events schema (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_llm_telemetry",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function layer() {
    return Object.assign(h.layer(), { projectId: PROJECT });
  }

  /** Seeds one executor lane (two requests), one unreported-cache heartbeat, and one 30-minute-old row. */
  async function seed(): Promise<void> {
    const db = h.layer().db;
    const now = Date.now();
    const writes = await Promise.all([
      emitUsageEvent(db, PROJECT, {
        kind: LLM_TOKEN_USAGE_EVENT_KIND,
        ts: new Date(now - 60_000).toISOString(),
        taskId: "FN-1",
        agentId: "agent-1",
        model: "claude-sonnet",
        provider: "anthropic",
        meta: buildLlmTokenUsageMeta({
          lane: "executor",
          inputTokens: 1_000,
          outputTokens: 200,
          cachedTokens: 3_000,
          cacheWriteTokens: 50,
          totalTokens: 4_250,
          cacheReadReported: true,
        }),
      }),
      emitUsageEvent(db, PROJECT, {
        kind: LLM_TOKEN_USAGE_EVENT_KIND,
        ts: new Date(now - 30 * 60_000).toISOString(),
        taskId: "FN-1",
        agentId: "agent-1",
        model: "claude-sonnet",
        provider: "anthropic",
        meta: buildLlmTokenUsageMeta({
          lane: "executor",
          inputTokens: 700,
          outputTokens: 100,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 800,
          cacheReadReported: true,
        }),
      }),
      emitUsageEvent(db, PROJECT, {
        kind: LLM_TOKEN_USAGE_EVENT_KIND,
        ts: new Date(now - 45_000).toISOString(),
        agentId: "agent-2",
        model: "gpt-4o",
        provider: "openai",
        meta: buildLlmTokenUsageMeta({
          lane: "heartbeat",
          inputTokens: 400,
          outputTokens: 20,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 420,
          cacheReadReported: false,
        }),
      }),
      emitUsageEvent(db, PROJECT, {
        kind: LLM_PROMPT_HEAD_EVENT_KIND,
        ts: new Date(now - 25 * 60_000).toISOString(),
        agentId: "agent-1",
        meta: buildLlmPromptHeadMeta({
          lane: "executor",
          requestId: REQ_1,
          headHash: HASH_A,
          headBytes: 4_096,
          staticBytes: 3_000,
          dynamicBytes: 1_096,
          dynamicStart: 3_000,
          divergenceStatus: "baseline",
          firstDivergenceOffset: null,
          source: "engine-assembly",
          runtimeId: "pi",
        }),
      }),
      emitUsageEvent(db, PROJECT, {
        kind: LLM_PROMPT_HEAD_EVENT_KIND,
        ts: new Date(now - 30_000).toISOString(),
        agentId: "agent-1",
        meta: buildLlmPromptHeadMeta({
          lane: "executor",
          requestId: REQ_2,
          headHash: HASH_B,
          headBytes: 4_120,
          staticBytes: 3_000,
          dynamicBytes: 1_120,
          dynamicStart: 3_000,
          divergenceStatus: "diverged",
          firstDivergenceOffset: 3_000,
          source: "engine-assembly",
          runtimeId: "pi",
        }),
      }),
      emitUsageEvent(db, PROJECT, {
        kind: LLM_PROMPT_END_EVENT_KIND,
        ts: new Date(now - 20_000).toISOString(),
        agentId: "agent-1",
        meta: buildLlmPromptEndMeta({ lane: "executor", requestId: REQ_2, outcome: "completed", durationMs: 1_500 }),
      }),
    ]);
    // emitUsageEvent is fail-soft: a rejected row answers `false`, never throws. So `true` per write IS
    // the schema-acceptance assertion.
    expect(writes).toEqual([true, true, true, true, true, true]);
  }

  it("stores and reads back all three kinds with no migration", async () => {
    await seed();
    const rows = await queryUsageEvents(h.layer().db, PROJECT, {
      from: new Date(Date.now() - 60 * 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
      kinds: [LLM_TOKEN_USAGE_EVENT_KIND, LLM_PROMPT_HEAD_EVENT_KIND, LLM_PROMPT_END_EVENT_KIND],
    });
    expect(rows).toHaveLength(6);
    const byKind = new Map<string, number>();
    for (const row of rows) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
    expect(byKind.get(LLM_TOKEN_USAGE_EVENT_KIND)).toBe(3);
    expect(byKind.get(LLM_PROMPT_HEAD_EVENT_KIND)).toBe(2);
    expect(byKind.get(LLM_PROMPT_END_EVENT_KIND)).toBe(1);
  });

  it("aggregates the 1h window per lane with cache-read share and head stability", async () => {
    await seed();
    const report = await aggregateLlmLaneTelemetry(layer(), { window: "1h" });

    expect(report.window).toBe("1h");
    expect(report.gridTruncated).toBe(false);
    expect(report.headTruncated).toBe(false);

    const executor = report.aggregates.find((row) => row.lane === "executor");
    expect(executor?.tokens.requestCount).toBe(2);
    expect(executor?.tokens.promptTokens).toBe(1_000 + 3_000 + 700 + 0);
    // promptTokens := input + cached (never output), so 3000 / 4700 is the honest cache-read share.
    expect(executor?.cacheReadShare).toBeCloseTo(3_000 / 4_700, 10);
    expect(executor?.head.distinctHeadHashCount).toBe(2);
    expect(executor?.head.medianHeadBytes).toBe(4_096);
    expect(executor?.head.divergenceCounts).toEqual({ baseline: 1, identical: 0, diverged: 1 });
    expect(executor?.head.offsetBucketCounts.lt1k).toBe(0);
    expect(executor?.head.offsetBucketCounts.lt8k).toBe(1);

    // A provider that never answers the cache question must read as unmeasured, never as 0%.
    const heartbeat = report.aggregates.find((row) => row.lane === "heartbeat");
    expect(heartbeat?.cacheReadShare).toBeNull();
    expect(heartbeat?.head.distinctHeadHashCount).toBe(0);
    expect(heartbeat?.head.medianHeadBytes).toBeNull();

    // 420 heartbeat prompt tokens out of 4700 + 400 total prompt tokens.
    expect(report.totalPromptTokens).toBe(4_700 + 400);
    expect(report.heartbeatPromptTokenShare).toBeCloseTo(400 / 5_100, 10);

    const cell = report.grid.find((row) => row.lane === "executor" && row.model === "claude-sonnet");
    expect(cell?.eventCount).toBe(2);
    expect(cell?.totalTokens).toBe(4_250 + 800);

    // Head rows come back newest-first and carry only ids/hashes/offsets.
    expect(report.headEvents[0]?.requestId).toBe(REQ_2);
    expect(report.headEvents[0]?.firstDivergenceOffset).toBe(3_000);
    expect(report.headEvents[1]?.headHash).toBe(HASH_A);
  });

  it("excludes a 30-minute-old row from the 10m window", async () => {
    await seed();
    const report = await aggregateLlmLaneTelemetry(layer(), { window: "10m" });
    const executor = report.aggregates.find((row) => row.lane === "executor");
    expect(executor?.tokens.requestCount).toBe(1);
    expect(executor?.tokens.promptTokens).toBe(4_000);
    expect(report.totalPromptTokens).toBe(4_000 + 400);
    // Only the newest head is inside 10 minutes, so the lane has one hash and no divergence row.
    expect(executor?.head.distinctHeadHashCount).toBe(1);
    expect(executor?.head.divergenceCounts).toEqual({ baseline: 0, identical: 0, diverged: 1 });
    expect(report.headEvents).toHaveLength(1);
  });

  it("stores no prose in any telemetry row: keys stay inside the closed vocabulary", async () => {
    await seed();
    const rows = await queryUsageEvents(h.layer().db, PROJECT, {
      from: new Date(Date.now() - 60 * 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
      kinds: [LLM_TOKEN_USAGE_EVENT_KIND, LLM_PROMPT_HEAD_EVENT_KIND, LLM_PROMPT_END_EVENT_KIND],
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const meta = (row.meta ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(meta)) {
        expect(ALLOWED_META_KEYS.has(key), `unexpected meta key ${key} in a stored ${row.kind} row`).toBe(true);
        if (typeof value === "string") {
          // A prompt sentence, a soul block, or a worktree path cannot fit this shape.
          expect(value.length, `${key} carries an over-long string`).toBeLessThanOrEqual(80);
          expect(/^[A-Za-z0-9_.:-]+$/.test(value), `${key} carries non-identifier text`).toBe(true);
        }
      }
    }
  });
});
