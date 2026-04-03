import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Response, Request } from "express";
import { createSSE, getActiveSSEConnections } from "../sse.js";

/** Minimal mock TaskStore — just needs EventEmitter behaviour. */
function createMockStore() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  return emitter as any;
}

/** Create a mock Express response with a writeable buffer. */
function createMockResponse() {
  const chunks: string[] = [];
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    writableEnded: false,
    destroyed: false,
  } as unknown as Response;
  return { res, chunks };
}

/** Create a mock Express request that can fire 'close'. */
function createMockRequest() {
  const emitter = new EventEmitter();
  return emitter as unknown as Request;
}

describe("createSSE", () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
  });

  it("writes initial connected comment", () => {
    const req = createMockRequest();
    const { res, chunks } = createMockResponse();
    createSSE(store)(req, res);
    expect(chunks[0]).toBe(": connected\n\n");
  });

  it("relays task:created events as SSE messages", () => {
    const req = createMockRequest();
    const { res, chunks } = createMockResponse();
    createSSE(store)(req, res);

    const task = { id: "FN-001", description: "test" };
    store.emit("task:created", task);

    const sseMsg = chunks.find((c) => c.includes("task:created"));
    expect(sseMsg).toBeDefined();
    expect(sseMsg).toContain(JSON.stringify(task));
  });

  it("relays task:moved events as SSE messages", () => {
    const req = createMockRequest();
    const { res, chunks } = createMockResponse();
    createSSE(store)(req, res);

    const data = { task: { id: "FN-001" }, from: "triage", to: "todo" };
    store.emit("task:moved", data);

    const sseMsg = chunks.find((c) => c.includes("task:moved"));
    expect(sseMsg).toBeDefined();
    expect(sseMsg).toContain(JSON.stringify(data));
  });

  it("relays task:updated events as SSE messages", () => {
    const req = createMockRequest();
    const { res, chunks } = createMockResponse();
    createSSE(store)(req, res);

    const task = { id: "FN-001", title: "Updated" };
    store.emit("task:updated", task);

    const sseMsg = chunks.find((c) => c.includes("task:updated"));
    expect(sseMsg).toBeDefined();
  });

  it("relays task:deleted events as SSE messages", () => {
    const req = createMockRequest();
    const { res, chunks } = createMockResponse();
    createSSE(store)(req, res);

    const task = { id: "FN-001" };
    store.emit("task:deleted", task);

    const sseMsg = chunks.find((c) => c.includes("task:deleted"));
    expect(sseMsg).toBeDefined();
  });

  it("relays task:merged events as SSE messages", () => {
    const req = createMockRequest();
    const { res, chunks } = createMockResponse();
    createSSE(store)(req, res);

    const result = { task: { id: "FN-001" }, success: true };
    store.emit("task:merged", result);

    const sseMsg = chunks.find((c) => c.includes("task:merged"));
    expect(sseMsg).toBeDefined();
  });

  it("cleans up listeners when client disconnects", () => {
    const req = createMockRequest();
    const { res } = createMockResponse();
    createSSE(store)(req, res);

    const before = store.listenerCount("task:created");
    expect(before).toBe(1);

    // Simulate client disconnect
    req.emit("close");

    expect(store.listenerCount("task:created")).toBe(0);
    expect(store.listenerCount("task:moved")).toBe(0);
    expect(store.listenerCount("task:updated")).toBe(0);
    expect(store.listenerCount("task:deleted")).toBe(0);
    expect(store.listenerCount("task:merged")).toBe(0);
  });

  it("stops writing when response is destroyed", () => {
    const req = createMockRequest();
    const { res, chunks } = createMockResponse();
    createSSE(store)(req, res);

    // Mark response as destroyed
    (res as any).destroyed = true;

    const initialCount = chunks.length;
    store.emit("task:created", { id: "FN-001" });

    // No new chunks should be written
    expect(chunks.length).toBe(initialCount);
  });

  it("stops writing and cleans up when res.write throws", () => {
    const req = createMockRequest();
    const { res } = createMockResponse();
    createSSE(store)(req, res);

    // Make write throw on next call
    (res.write as any).mockImplementation(() => {
      throw new Error("Socket closed");
    });

    // This should not throw — the error is caught internally
    expect(() => store.emit("task:created", { id: "FN-001" })).not.toThrow();

    // Listeners should be cleaned up
    expect(store.listenerCount("task:created")).toBe(0);
  });

  it("tracks active connection count", () => {
    const req1 = createMockRequest();
    const { res: res1 } = createMockResponse();
    const req2 = createMockRequest();
    const { res: res2 } = createMockResponse();

    const initial = getActiveSSEConnections();
    createSSE(store)(req1, res1);
    expect(getActiveSSEConnections()).toBe(initial + 1);
    createSSE(store)(req2, res2);
    expect(getActiveSSEConnections()).toBe(initial + 2);

    req1.emit("close");
    expect(getActiveSSEConnections()).toBe(initial + 1);
    req2.emit("close");
    expect(getActiveSSEConnections()).toBe(initial);
  });
});
