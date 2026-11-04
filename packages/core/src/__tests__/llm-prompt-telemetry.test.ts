import { describe, expect, it, vi } from "vitest";
import { emitUsageEvent as emitUsageEventAsync } from "../task-store/async/async-events.js";
import {
  emitUsageEvent,
  USAGE_EVENT_META_MAX_BYTES,
  type UsageEventInput,
} from "../tasks/usage-events.js";
import {
  LLM_TELEMETRY_META_BUDGET_BYTES,
  LlmTelemetryMetaTooLargeError,
  bucketDivergenceOffset,
  buildLlmPromptEndMeta,
  buildLlmPromptHeadMeta,
  buildLlmTokenUsageMeta,
  cacheReadShareOf,
  firstDivergenceOffset,
  hashPromptHead,
  heartbeatPromptTokenShareOf,
  lowerMedian,
  promptHeadByteLength,
  promptTokensOf,
} from "../telemetry/llm-prompt-telemetry.js";

/**
 * RUFU-284 privacy contract: the sink accepts the new kinds, refuses an over-cap meta, and can never
 * receive prompt text — the builders are the barrier, and this test is the pin that says so.
 */

const PRIVATE_SYSTEM_PROMPT = [
  "You are the Workflow Executor. Implement the approved scope with production-quality changes.",
  "SECRET-SOUL-SENTINEL: never leak the operator's private worktree path /home/private/worktree.",
].join("\n");

describe("usage-event kind sets (sync + async mirror)", () => {
  /** The sync seam is the only place the kind set is observable without a PostgreSQL harness. */
  function syncSink() {
    const run = vi.fn();
    const db = { prepare: vi.fn(() => ({ run })) } as unknown as Parameters<typeof emitUsageEvent>[0];
    return { db, run };
  }

  it.each(["token_usage", "prompt_head", "prompt_end"] as const)("sync layer accepts %s", (kind) => {
    const { db, run } = syncSink();
    expect(emitUsageEvent(db, { kind: kind as UsageEventInput["kind"] })).toBe(true);
    expect(run).toHaveBeenCalled();
  });

  it("async mirror accepts the same three kinds (a private-set omission would silently drop rows)", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn(() => ({ values })) } as unknown as Parameters<typeof emitUsageEventAsync>[0];
    for (const kind of ["token_usage", "prompt_head", "prompt_end"] as const) {
      await expect(emitUsageEventAsync(db, "proj-1", { kind: kind as UsageEventInput["kind"] })).resolves.toBe(true);
    }
    expect(values).toHaveBeenCalledTimes(3);
  });

  it("refuses an unknown kind instead of writing it", () => {
    const { db, run } = syncSink();
    expect(emitUsageEvent(db, { kind: "not_a_kind" as UsageEventInput["kind"] })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an over-cap meta rather than storing a truncated one", () => {
    const { db, run } = syncSink();
    const oversized = { blob: "x".repeat(USAGE_EVENT_META_MAX_BYTES + 10) };
    expect(emitUsageEvent(db, { kind: "token_usage", meta: oversized })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("LLM telemetry meta builders", () => {
  it("keeps every builder inside the smallest sink cap by construction", () => {
    const meta = buildLlmTokenUsageMeta({
      lane: "executor",
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 7,
      cacheWriteTokens: 1,
      totalTokens: 23,
      cacheReadReported: true,
    });
    expect(Buffer.byteLength(JSON.stringify(meta), "utf8")).toBeLessThanOrEqual(LLM_TELEMETRY_META_BUDGET_BYTES);
  });

  it("refuses to hand the sink a meta it would silently drop", () => {
    // A digest far longer than sha256's 64 hex chars cannot fit under the sync cap alongside the
    // fixed fields, which is exactly the shape a builder must refuse instead of shipping.
    const absurdHash = "a".repeat(64 * 200);
    expect(() => buildLlmPromptHeadMeta({
      lane: "chat",
      requestId: "req-1",
      headHash: absurdHash,
      headBytes: 1,
      divergenceStatus: "baseline",
      firstDivergenceOffset: null,
      source: "engine-assembly",
      runtimeId: "pi",
    })).toThrow(LlmTelemetryMetaTooLargeError);
  });

  it("rejects a lane outside the closed union rather than inventing one", () => {
    expect(() => buildLlmTokenUsageMeta({
      lane: "executor-sneaky" as never,
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      cacheReadReported: false,
    })).toThrow(TypeError);
  });

  it("never carries the head text it hashed", () => {
    const meta = buildLlmPromptHeadMeta({
      lane: "executor",
      requestId: "req-1",
      headHash: hashPromptHead(PRIVATE_SYSTEM_PROMPT),
      headBytes: promptHeadByteLength(PRIVATE_SYSTEM_PROMPT),
      staticBytes: 80,
      dynamicBytes: 40,
      dynamicStart: 80,
      divergenceStatus: "baseline",
      firstDivergenceOffset: null,
      source: "engine-assembly",
      runtimeId: "pi",
    });
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("Workflow Executor");
    expect(serialized).not.toContain("SECRET-SOUL-SENTINEL");
    expect(serialized).not.toContain("/home/private/worktree");
    expect(meta.headHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries no token numbers in the tail row (token_usage owns those)", () => {
    const meta = buildLlmPromptEndMeta({ lane: "triage", requestId: "req-9", outcome: "completed", durationMs: 12 });
    expect(Object.keys(meta).sort()).toEqual(["durationMs", "lane", "outcome", "requestId"]);
  });
});

describe("head digest and divergence arithmetic", () => {
  const STATIC = "A".repeat(200);
  const DYNAMIC = "timestamp 2026-11-04";

  it("is deterministic per byte string and changes on one character", () => {
    expect(hashPromptHead(STATIC)).toBe(hashPromptHead(STATIC));
    expect(hashPromptHead(`${STATIC}!`)).not.toBe(hashPromptHead(STATIC));
  });

  it("normalizes CRLF and surrounding whitespace to the same digest", () => {
    expect(hashPromptHead(`  ${STATIC}\r\n  `)).toBe(hashPromptHead(STATIC));
  });

  it("reports the dynamic boundary when both halves are present", () => {
    expect(firstDivergenceOffset(STATIC + "old-dynamic", STATIC + "new-dynamic")).toBe(STATIC.length);
  });

  it("reports offset 0 when only the static half moved", () => {
    expect(firstDivergenceOffset(STATIC + DYNAMIC, "B" + STATIC.slice(1) + DYNAMIC)).toBe(0);
  });

  it("reports the shorter length for a prefix divergence (dynamic half dropped entirely)", () => {
    expect(firstDivergenceOffset(STATIC + DYNAMIC, STATIC)).toBe(STATIC.length);
  });

  it("returns null for an identical head and for a head past the byte cap", () => {
    expect(firstDivergenceOffset(STATIC, STATIC)).toBeNull();
    const huge = "z".repeat(300 * 1024);
    expect(firstDivergenceOffset(STATIC, huge)).toBeNull();
  });

  it("buckets offsets on the declared boundaries", () => {
    expect(bucketDivergenceOffset(127)).toBe("lt128");
    expect(bucketDivergenceOffset(128)).toBe("lt1k");
    expect(bucketDivergenceOffset(1024)).toBe("lt8k");
    expect(bucketDivergenceOffset(8192)).toBe("lt64k");
    expect(bucketDivergenceOffset(65536)).toBe("gte64k");
    expect(bucketDivergenceOffset(null)).toBeNull();
  });
});

describe("aggregate definitions", () => {
  it("counts prompt tokens as input + cached, excluding output", () => {
    expect(promptTokensOf({ inputTokens: 100, cachedTokens: 50 })).toBe(150);
  });

  it("answers null rather than 0 for an absent denominator", () => {
    expect(cacheReadShareOf({ cachedTokens: 0, promptTokens: 0 })).toBeNull();
    expect(heartbeatPromptTokenShareOf(10, 0)).toBeNull();
    expect(lowerMedian([])).toBeNull();
  });

  it("computes the ratios the panel publishes", () => {
    expect(cacheReadShareOf({ cachedTokens: 50, promptTokens: 150 })).toBeCloseTo(1 / 3);
    expect(heartbeatPromptTokenShareOf(25, 100)).toBeCloseTo(0.25);
    expect(lowerMedian([5, 1, 3])).toBe(3);
    expect(lowerMedian([4, 1, 3, 2])).toBe(2);
  });
});
