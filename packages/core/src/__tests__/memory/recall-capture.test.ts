import { describe, expect, it, vi } from "vitest";
import {
  buildRecallCaptureContent,
  createRecallCaptureWriter,
  RECALL_CAPTURE_CONTENT_MAX_BYTES,
  RECALL_CAPTURE_KIND_BY_ORIGIN,
  RECALL_CAPTURE_SOURCE_ORIGIN_BY_ORIGIN,
} from "../../memory/recall-capture.js";
import type { RecallAppendInput } from "../../memory/recall/recall-types.js";

const layer = {} as never;
const logger = { warn: vi.fn() };

function created(input: RecallAppendInput) {
  return {
    status: "created" as const,
    record: {
      id: "recall-1", projectId: "project", kind: input.kind, content: input.content,
      contentHash: "hash", source: input.source, tags: input.tags ?? [], graphNodeIds: input.graphNodeIds ?? [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("recall capture writer", () => {
  it("maps every automatic origin to FN-8922 kinds and source provenance", async () => {
    const append = vi.fn(async (input: RecallAppendInput) => created(input));
    const writer = createRecallCaptureWriter({ layer, logger, append });
    writer.capture({ origin: "task-completion", summary: "Implemented the safe retry.", taskId: "FN-1", agentId: "agent-1" });
    writer.capture({ origin: "research-finding", summary: "The upstream API rejects empty cursors." });
    writer.capture({ origin: "insight", summary: "Prefer bounded paging." });
    await writer.flushPendingCaptures();

    expect(RECALL_CAPTURE_KIND_BY_ORIGIN).toEqual({ "task-completion": "solution", "research-finding": "solution", insight: "decision" });
    expect(RECALL_CAPTURE_SOURCE_ORIGIN_BY_ORIGIN).toEqual({ "task-completion": "task-completion", "research-finding": "deep-research", insight: "other" });
    expect(append.mock.calls.map(([input]) => ({ kind: input.kind, origin: input.source.origin }))).toEqual([
      { kind: "solution", origin: "task-completion" },
      { kind: "solution", origin: "deep-research" },
      { kind: "decision", origin: "other" },
    ]);
    expect(append.mock.calls[0]?.[0].source).toMatchObject({ taskId: "FN-1", agentId: "agent-1" });
  });

  it("builds structured UTF-8-safe content within its durable byte budget", () => {
    const content = buildRecallCaptureContent({ origin: "insight", title: "✨".repeat(3_000), summary: "é".repeat(3_000) });
    expect(content).toContain("[insight]\nTitle:");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(RECALL_CAPTURE_CONTENT_MAX_BYTES);
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
  });

  it("returns undefined synchronously even when persistence never settles", () => {
    const append = vi.fn(() => new Promise<never>(() => {}));
    const writer = createRecallCaptureWriter({ layer, logger, append });
    expect(writer.capture({ origin: "insight", summary: "Never block the insight seam." })).toBeUndefined();
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed append and logs exactly once", async () => {
    const warn = vi.fn();
    const writer = createRecallCaptureWriter({ layer, logger: { warn }, append: async () => { throw new Error("recall unavailable"); } });
    writer.capture({ origin: "research-finding", summary: "Failure remains best effort." });
    await writer.flushPendingCaptures();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Automatic recall capture failed for research-finding");
  });

  it("records ids-only capture audit metadata after persistence", async () => {
    const audit = vi.fn(async () => {});
    const append = vi.fn(async (input: RecallAppendInput) => created(input));
    const writer = createRecallCaptureWriter({ layer, logger, append, audit });
    writer.capture({ origin: "insight", summary: "distinctive model prose must not reach audit", insightId: "INS-1", sessionId: "INSR-1" });
    await writer.flushPendingCaptures();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      type: "memory:capture-recorded",
      metadata: { recallRecordId: "recall-1", outcome: "created" },
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("distinctive model prose");
    expect(append.mock.calls[0]?.[0].tags).toContain("insight:INS-1");
  });

  it("drains in-flight writes deterministically", async () => {
    let release!: () => void;
    const append = vi.fn(() => new Promise<ReturnType<typeof created>>((resolve) => { release = () => resolve(created({ kind: "decision", content: "x", source: { origin: "other" } })); }));
    const writer = createRecallCaptureWriter({ layer, logger, append });
    writer.capture({ origin: "insight", summary: "Await only in tests." });
    let drained = false;
    const drain = writer.flushPendingCaptures().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await drain;
    expect(drained).toBe(true);
  });

  it("relies on FN-8922 append deduplication for repeated identical captures", async () => {
    const records = new Map<string, RecallAppendInput>();
    const append = vi.fn(async (input: RecallAppendInput) => {
      const prior = records.get(input.content);
      if (prior) return { status: "duplicate" as const, duplicateOf: created(prior).record, similarity: 1 };
      records.set(input.content, input);
      return created(input);
    });
    const writer = createRecallCaptureWriter({ layer, logger, append });
    const input = { origin: "task-completion" as const, summary: "Use the existing retry policy.", taskId: "FN-2" };
    writer.capture(input);
    writer.capture(input);
    await writer.flushPendingCaptures();
    expect(records).toHaveLength(1);
    expect(append).toHaveBeenCalledTimes(2);
  });
});
