import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { appendAgentActivityEvent as appendDurableAgentActivity } from "../../../core/src/task-store/async/async-agent-activity.js";
import { resolveAgentActivityAttribution } from "../../../core/src/task-store/agent-activity-outbox.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";

/*
FNXC:AgentActivityStream 2026-08-09-22:35:
FN-8915 pins the documented truncation repair endpoints so clients can reconstruct the omitted
half-open range without depending on the SSE implementation's private tuning constants.
*/

const { queryAgentActivityEvents, getMaxAgentActivitySeq } = vi.hoisted(() => ({
  queryAgentActivityEvents: vi.fn(),
  getMaxAgentActivitySeq: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  queryAgentActivityEvents,
  getMaxAgentActivitySeq,
}));

import { createSSE } from "../sse.js";

class MockSocket extends EventEmitter {
  destroyed = false;
  setKeepAlive = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("close");
  });
}

class MockResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  write = vi.fn();
  flushHeaders = vi.fn();
  end = vi.fn(() => {
    this.writableEnded = true;
    this.emit("close");
  });
  constructor(readonly socket: MockSocket) { super(); }
  setHeader(): void {}
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function event(seq: string) {
  return {
    seq,
    eventId: `evt_${seq.padStart(16, "0")}`,
    projectId: "project-a",
    agentId: "agent-deadbeef",
    agentAttribution: "agent" as const,
    taskId: "FN-8864",
    type: "task:started" as const,
    fromAgentId: null,
    toAgentId: null,
    summary: "agent-deadbeef started FN-8864",
    occurredAt: "2026-08-09T00:00:00.000Z",
    metadata: null,
  };
}

describe("agent activity SSE tail", () => {
  beforeEach(() => {
    queryAgentActivityEvents.mockReset();
    getMaxAgentActivitySeq.mockReset();
  });

  it("delivers a durable nudge racing the seed without replaying prior history", async () => {
    let resolveInitialSeq: ((seq: string) => void) | undefined;
    getMaxAgentActivitySeq
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveInitialSeq = resolve;
      }))
      .mockResolvedValueOnce("101")
      .mockResolvedValueOnce("101");
    queryAgentActivityEvents.mockResolvedValueOnce({ events: [event("101")], nextCursor: null });
    const store = Object.assign(new EventEmitter(), {
      getAsyncLayer: () => ({ projectId: "project-a" }),
      getResearchStore: () => ({ on: vi.fn(), off: vi.fn() }),
    });
    const socket = new MockSocket();
    const request = Object.assign(new EventEmitter(), { query: {}, socket, headers: {} }) as Request;
    const response = new MockResponse(socket);

    createSSE(store as never)(request, response as unknown as Response);
    await Promise.resolve();
    store.emit("agent:activity", event("101"));
    expect(resolveInitialSeq).toBeTypeOf("function");
    // The query result has already observed the new row, along with 100 old rows.
    resolveInitialSeq!("101");
    await settle();

    expect(queryAgentActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-a" }),
      expect.objectContaining({ since: "100", order: "asc" }),
    );
    const frames = response.write.mock.calls
      .map(([frame]) => String(frame))
      .filter((frame) => frame.startsWith("event: agent:activity"));
    expect(frames).toHaveLength(1);
    response.emit("close");
  });

  it("drains a cross-process durable write that races cursor initialization", async () => {
    getMaxAgentActivitySeq
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("1");
    queryAgentActivityEvents.mockResolvedValueOnce({ events: [event("1")], nextCursor: null });
    const store = Object.assign(new EventEmitter(), {
      getAsyncLayer: () => ({ projectId: "project-a" }),
      getResearchStore: () => ({ on: vi.fn(), off: vi.fn() }),
    });
    const socket = new MockSocket();
    const request = Object.assign(new EventEmitter(), { query: {}, socket, headers: {} }) as Request;
    const response = new MockResponse(socket);

    createSSE(store as never)(request, response as unknown as Response);
    await settle();

    expect(queryAgentActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-a" }),
      expect.objectContaining({ since: "0", order: "asc" }),
    );
    expect(response.write.mock.calls.filter(([frame]) => String(frame).startsWith("event: agent:activity"))).toHaveLength(1);
    response.emit("close");
  });

  it("drains outbox pages in ascending seq order after a durable nudge", async () => {
    getMaxAgentActivitySeq.mockResolvedValue("0");
    queryAgentActivityEvents
      .mockResolvedValueOnce({ events: [event("1"), event("2")], nextCursor: null })
      .mockResolvedValueOnce({ events: [], nextCursor: null });
    const store = Object.assign(new EventEmitter(), {
      getAsyncLayer: () => ({ projectId: "project-a" }),
      getResearchStore: () => ({ on: vi.fn(), off: vi.fn() }),
    });
    const socket = new MockSocket();
    const request = Object.assign(new EventEmitter(), { query: {}, socket, headers: {} }) as Request;
    const response = new MockResponse(socket);

    createSSE(store as never)(request, response as unknown as Response);
    await settle();
    // This is deliberately the only wake-up: no in-process event payload is used for delivery.
    store.emit("agent:activity");
    await settle();

    const frames = response.write.mock.calls
      .map(([frame]) => String(frame))
      .filter((frame) => frame.startsWith("event: agent:activity"));
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => JSON.parse(frame.split("data: ")[1]!.trim()).seq)).toEqual(["1", "2"]);
    expect(queryAgentActivityEvents).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: "project-a" }),
      expect.objectContaining({ since: "0", order: "asc" }),
    );

    response.emit("close");
    expect(store.listenerCount("agent:activity")).toBe(0);
  });

  it("drains a multi-page durable backlog from polling without an in-process nudge", async () => {
    vi.useFakeTimers();
    try {
      getMaxAgentActivitySeq.mockResolvedValue("0");
      const firstPage = Array.from({ length: 100 }, (_, index) => event(String(index + 1)));
      queryAgentActivityEvents
        .mockResolvedValueOnce({ events: firstPage, nextCursor: null })
        .mockResolvedValueOnce({ events: [event("101")], nextCursor: null });
      const store = Object.assign(new EventEmitter(), {
        getAsyncLayer: () => ({ projectId: "project-a" }),
        getResearchStore: () => ({ on: vi.fn(), off: vi.fn() }),
      });
      const socket = new MockSocket();
      const request = Object.assign(new EventEmitter(), { query: {}, socket, headers: {} }) as Request;
      const response = new MockResponse(socket);

      createSSE(store as never)(request, response as unknown as Response);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      const frames = response.write.mock.calls
        .map(([frame]) => String(frame))
        .filter((frame) => frame.startsWith("event: agent:activity"));
      expect(frames.map((frame) => JSON.parse(frame.split("data: ")[1]!.trim()).seq)).toEqual(
        Array.from({ length: 101 }, (_, index) => String(index + 1)),
      );
      expect(queryAgentActivityEvents).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ projectId: "project-a" }),
        expect.objectContaining({ since: "100", order: "asc" }),
      );
      response.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed durable poll without advancing the cursor", async () => {
    vi.useFakeTimers();
    try {
      getMaxAgentActivitySeq.mockResolvedValue("0");
      queryAgentActivityEvents
        .mockRejectedValueOnce(new Error("temporary query failure"))
        .mockResolvedValueOnce({ events: [event("1")], nextCursor: null });
      const store = Object.assign(new EventEmitter(), {
        getAsyncLayer: () => ({ projectId: "project-a" }),
        getResearchStore: () => ({ on: vi.fn(), off: vi.fn() }),
      });
      const socket = new MockSocket();
      const request = Object.assign(new EventEmitter(), { query: {}, socket, headers: {} }) as Request;
      const response = new MockResponse(socket);

      createSSE(store as never)(request, response as unknown as Response);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const frames = response.write.mock.calls
        .map(([frame]) => String(frame))
        .filter((frame) => frame.startsWith("event: agent:activity"));
      expect(frames).toHaveLength(1);
      expect(queryAgentActivityEvents).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ projectId: "project-a" }),
        expect.objectContaining({ since: "0", order: "asc" }),
      );
      response.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a bounded truncation marker instead of flooding a large backlog", async () => {
    getMaxAgentActivitySeq
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("5001");
    const store = Object.assign(new EventEmitter(), {
      getAsyncLayer: () => ({ projectId: "project-a" }),
      getResearchStore: () => ({ on: vi.fn(), off: vi.fn() }),
    });
    const socket = new MockSocket();
    const request = Object.assign(new EventEmitter(), { query: {}, socket, headers: {} }) as Request;
    const response = new MockResponse(socket);

    createSSE(store as never)(request, response as unknown as Response);
    await settle();
    store.emit("agent:activity", event("5001"));
    await settle();

    // docs/agent-activity-contract.md#sse-truncation-repair
    const marker = { truncated: true, fromSeq: "0", toSeq: "5001" };
    expect(response.write).toHaveBeenCalledWith(
      `event: agent:activity\ndata: ${JSON.stringify(marker)}\n\n`,
    );
    expect(marker.fromSeq).toBe("0");
    expect(marker.toSeq).toBe("5001");
    expect(queryAgentActivityEvents).not.toHaveBeenCalled();
    response.emit("close");
  });
});

/*
FNXC:AgentActivityStream 2026-08-09-13:18:
This uses a real outbox append with no TaskStore emitter, matching a short-lived external writer.
The SSE tail must discover that durable cross-process row by polling rather than relying on an
in-process nudge.
*/
pgDescribe("agent activity SSE durable integration", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_sse_agent_activity", projectId: "sse-agent-activity",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("delivers an out-of-process-shaped persisted append through the seq tail", async () => {
    // FNXC:AgentActivityStream 2026-08-12-00:00: drive the real durable poll fast via its
    // bounded env test-seam instead of sleeping a full 2s production cycle (FN-5048).
    const priorPollMs = process.env.FUSION_AGENT_ACTIVITY_POLL_MS;
    process.env.FUSION_AGENT_ACTIVITY_POLL_MS = "20";
    const realCore = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
    getMaxAgentActivitySeq.mockReset().mockImplementation((layer) => realCore.getMaxAgentActivitySeq(layer));
    queryAgentActivityEvents.mockReset().mockImplementation((layer, query) => realCore.queryAgentActivityEvents(layer, query));
    const store = Object.assign(new EventEmitter(), {
      getAsyncLayer: () => h.layer(),
      getResearchStore: () => ({ on: vi.fn(), off: vi.fn() }),
    });
    const socket = new MockSocket();
    const request = Object.assign(new EventEmitter(), { query: {}, socket, headers: {} }) as Request;
    const response = new MockResponse(socket);

    try {
      createSSE(store as never)(request, response as unknown as Response);
      await settle();
      await appendDurableAgentActivity(h.layer(), {
        type: "task:started",
        attributionClaim: resolveAgentActivityAttribution([{ id: "executor", provenance: "lane" }], "executor"),
        taskId: "FN-8864",
        occurredAt: "2026-08-09T00:00:01.000Z",
        discriminator: "external-exec-after-connect",
        metadata: { runId: "exec-FN-8864-1234567891-abcd" },
      });
      // No store.emit: the poll is the delivery guarantee for external writers. Poll for the
      // frame rather than sleeping a fixed cycle so the test tracks real delivery, not a timer.
      const agentActivityFrames = () =>
        response.write.mock.calls
          .map(([frame]) => String(frame))
          .filter((frame) => frame.startsWith("event: agent:activity"));
      const deadline = Date.now() + 5_000;
      while (agentActivityFrames().length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const frames = agentActivityFrames();
      expect(frames).toHaveLength(1);
      expect(JSON.parse(frames[0]!.split("data: ")[1]!.trim())).toMatchObject({ seq: "1", taskId: "FN-8864" });
    } finally {
      response.emit("close");
      if (priorPollMs === undefined) delete process.env.FUSION_AGENT_ACTIVITY_POLL_MS;
      else process.env.FUSION_AGENT_ACTIVITY_POLL_MS = priorPollMs;
    }
  });
});
