import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { TaskStore, AutomationStore } from "@fusion/core";
import { createSSE, disconnectSSEClient, getActiveSSEConnections, markSSEClientAlive } from "../sse.js";

class MockSocket extends EventEmitter {
  destroyed = false;
  setKeepAlive = vi.fn();
  destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  });
}

class MockResponse extends EventEmitter {
  headers = new Map<string, string>();
  writableEnded = false;
  destroyed = false;
  write = vi.fn();
  flushHeaders = vi.fn();
  end = vi.fn(() => {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit("close");
  });

  constructor(readonly socket: MockSocket) {
    super();
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

function createMockStore(): TaskStore {
  return {
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function openSseConnection(clientId: string, projectId?: string) {
  const store = createMockStore();
  const socket = new MockSocket();
  const req = new EventEmitter() as Request & { query: Record<string, string>; socket: MockSocket };
  req.query = projectId ? { clientId, projectId } : { clientId };
  req.socket = socket;
  const res = new MockResponse(socket);

  createSSE(
    store,
    undefined,
    undefined,
    undefined,
    projectId ? { projectId } : undefined,
  )(req, res as unknown as Response);

  return { req, res, socket, store };
}

function createMockAutomationStore(): AutomationStore {
  return {
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as AutomationStore;
}

function openSseConnectionWithAutomation(clientId: string, projectId?: string) {
  const store = createMockStore();
  const automationStore = createMockAutomationStore();
  const socket = new MockSocket();
  const req = new EventEmitter() as Request & { query: Record<string, string>; socket: MockSocket };
  req.query = projectId ? { clientId, projectId } : { clientId };
  req.socket = socket;
  const res = new MockResponse(socket);

  createSSE(
    store,
    undefined,
    undefined,
    undefined,
    projectId ? { projectId } : undefined,
    undefined,
    undefined,
    undefined,
    automationStore,
  )(req, res as unknown as Response);

  return { req, res, socket, store, automationStore };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("automation store SSE events", () => {
  it("subscribes to all automation store events", () => {
    const connection = openSseConnectionWithAutomation("automation-subscribe");

    expect(connection.automationStore.on).toHaveBeenCalledWith("schedule:created", expect.any(Function));
    expect(connection.automationStore.on).toHaveBeenCalledWith("schedule:updated", expect.any(Function));
    expect(connection.automationStore.on).toHaveBeenCalledWith("schedule:deleted", expect.any(Function));
    expect(connection.automationStore.on).toHaveBeenCalledWith("schedule:run", expect.any(Function));

    connection.req.emit("close");
  });

  it("relays schedule:created events", () => {
    const connection = openSseConnectionWithAutomation("automation-created");
    const handler = vi.mocked(connection.automationStore.on).mock.calls.find(
      ([eventName]) => eventName === "schedule:created",
    )?.[1] as ((schedule: unknown) => void) | undefined;

    const schedule = { id: "sch-1", name: "Nightly" };
    handler?.(schedule);

    expect(connection.res.write).toHaveBeenCalledWith(
      `event: schedule:created\ndata: ${JSON.stringify(schedule)}\n\n`,
    );

    connection.req.emit("close");
  });

  it("relays schedule:updated events", () => {
    const connection = openSseConnectionWithAutomation("automation-updated");
    const handler = vi.mocked(connection.automationStore.on).mock.calls.find(
      ([eventName]) => eventName === "schedule:updated",
    )?.[1] as ((schedule: unknown) => void) | undefined;

    const schedule = { id: "sch-2", name: "Weekly" };
    handler?.(schedule);

    expect(connection.res.write).toHaveBeenCalledWith(
      `event: schedule:updated\ndata: ${JSON.stringify(schedule)}\n\n`,
    );

    connection.req.emit("close");
  });

  it("relays schedule:deleted events", () => {
    const connection = openSseConnectionWithAutomation("automation-deleted");
    const handler = vi.mocked(connection.automationStore.on).mock.calls.find(
      ([eventName]) => eventName === "schedule:deleted",
    )?.[1] as ((schedule: unknown) => void) | undefined;

    const schedule = { id: "sch-3", name: "Cleanup" };
    handler?.(schedule);

    expect(connection.res.write).toHaveBeenCalledWith(
      `event: schedule:deleted\ndata: ${JSON.stringify(schedule)}\n\n`,
    );

    connection.req.emit("close");
  });

  it("relays schedule:run events", () => {
    const connection = openSseConnectionWithAutomation("automation-run");
    const handler = vi.mocked(connection.automationStore.on).mock.calls.find(
      ([eventName]) => eventName === "schedule:run",
    )?.[1] as ((data: unknown) => void) | undefined;

    const payload = {
      schedule: { id: "sch-4", name: "Run" },
      result: { status: "success", startedAt: "2026-04-27T00:00:00.000Z" },
    };
    handler?.(payload);

    expect(connection.res.write).toHaveBeenCalledWith(
      `event: schedule:run\ndata: ${JSON.stringify(payload)}\n\n`,
    );

    connection.req.emit("close");
  });

  it("cleans up automation store listeners on disconnect", () => {
    const connection = openSseConnectionWithAutomation("automation-cleanup");

    connection.req.emit("close");

    expect(connection.automationStore.off).toHaveBeenCalledWith("schedule:created", expect.any(Function));
    expect(connection.automationStore.off).toHaveBeenCalledWith("schedule:updated", expect.any(Function));
    expect(connection.automationStore.off).toHaveBeenCalledWith("schedule:deleted", expect.any(Function));
    expect(connection.automationStore.off).toHaveBeenCalledWith("schedule:run", expect.any(Function));
  });

  it("works without automationStore (graceful degradation)", () => {
    const connection = openSseConnection("automation-none");

    expect(connection.res.write).toHaveBeenCalledWith(": connected\n\n");

    connection.req.emit("close");
  });
});

describe("createSSE client cleanup", () => {
  it("disconnectSSEClient closes and unregisters the matching stream", () => {
    const baseline = getActiveSSEConnections();
    const connection = openSseConnection("client-one");

    expect(getActiveSSEConnections()).toBe(baseline + 1);

    expect(disconnectSSEClient("client-one")).toBe(1);

    expect(connection.res.end).toHaveBeenCalledTimes(1);
    expect(connection.socket.destroy).toHaveBeenCalledTimes(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });

  it("a new stream supersedes an older stream from the same client and project", () => {
    const baseline = getActiveSSEConnections();
    const first = openSseConnection("client-two", "project-a");
    const second = openSseConnection("client-two", "project-a");

    expect(first.res.end).toHaveBeenCalledTimes(1);
    expect(first.socket.destroy).toHaveBeenCalledTimes(1);
    expect(second.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 1);

    expect(disconnectSSEClient("client-two", "project-a")).toBe(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });

  it("keeps streams from the same client isolated by project scope", () => {
    const baseline = getActiveSSEConnections();
    const first = openSseConnection("client-three", "project-a");
    const second = openSseConnection("client-three", "project-b");

    expect(first.res.end).not.toHaveBeenCalled();
    expect(second.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 2);

    expect(disconnectSSEClient("client-three", "project-a")).toBe(1);
    expect(first.res.end).toHaveBeenCalledTimes(1);
    expect(second.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 1);

    expect(disconnectSSEClient("client-three", "project-b")).toBe(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });

  it("closes a client stream when keepalives stop", () => {
    vi.useFakeTimers();
    const baseline = getActiveSSEConnections();
    const connection = openSseConnection("client-four");

    expect(getActiveSSEConnections()).toBe(baseline + 1);

    vi.advanceTimersByTime(4_999);
    expect(connection.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 1);

    vi.advanceTimersByTime(1);
    expect(connection.res.end).toHaveBeenCalledTimes(1);
    expect(connection.socket.destroy).toHaveBeenCalledTimes(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });

  it("extends a client stream while keepalives arrive", () => {
    vi.useFakeTimers();
    const baseline = getActiveSSEConnections();
    const connection = openSseConnection("client-five");

    vi.advanceTimersByTime(4_000);
    expect(markSSEClientAlive("client-five")).toBe(1);

    vi.advanceTimersByTime(4_000);
    expect(connection.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 1);

    vi.advanceTimersByTime(1_000);
    expect(connection.res.end).toHaveBeenCalledTimes(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });

  it("closes the connection when the outbound buffer exceeds the backpressure threshold", () => {
    // Capture the task:created listener so we can fire a send after the
    // socket buffer has been bloated past the threshold.
    let onCreated: ((task: unknown) => void) | undefined;
    const store = {
      on: vi.fn((event: string, handler: (task: unknown) => void) => {
        if (event === "task:created") onCreated = handler;
      }),
      off: vi.fn(),
    } as unknown as TaskStore;

    const baseline = getActiveSSEConnections();
    const socket = new MockSocket();
    const req = new EventEmitter() as Request & { query: Record<string, string>; socket: MockSocket };
    req.query = { clientId: "backpressure-client" };
    req.socket = socket;
    const res = new MockResponse(socket) as MockResponse & { writableLength: number };
    res.writableLength = 0;

    createSSE(store)(req, res as unknown as Response);
    expect(getActiveSSEConnections()).toBe(baseline + 1);
    expect(typeof onCreated).toBe("function");

    // Simulate a stuck client: kernel + Node buffers full beyond 4 MB.
    res.writableLength = 5 * 1024 * 1024;
    const writeCountBefore = res.write.mock.calls.length;

    onCreated?.({ id: "task-1" });

    // Backpressure was detected before the write, so res.write must NOT have
    // been called for this event, and the connection should be torn down.
    expect(res.write.mock.calls.length).toBe(writeCountBefore);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });
});
