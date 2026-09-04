import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { TaskStore } from "@fusion/core";
import { createSSE } from "../sse";

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
  write = vi.fn();
  flushHeaders = vi.fn();
  end = vi.fn(() => {
    this.writableEnded = true;
    this.emit("close");
  });
  setHeader = vi.fn();

  constructor(readonly socket: MockSocket) {
    super();
  }
}

function openConnection(streamProjectId?: string, storeProjectId?: string) {
  const store = {
    on: vi.fn(),
    off: vi.fn(),
    getProjectId: vi.fn(() => storeProjectId),
    getResearchStore: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
    getAsyncLayer: vi.fn(() => null),
  } as unknown as TaskStore;
  const socket = new MockSocket();
  const req = new EventEmitter() as Request & { query: Record<string, string>; socket: MockSocket };
  req.query = streamProjectId ? { clientId: "task-project-scope", projectId: streamProjectId } : { clientId: "task-project-scope" };
  req.socket = socket;
  const res = new MockResponse(socket);
  createSSE(store, undefined, undefined, undefined, streamProjectId ? { projectId: streamProjectId } : undefined)(
    req,
    res as unknown as Response,
  );
  return { req, res, store };
}

function handlerFor(connection: ReturnType<typeof openConnection>, event: string): (payload: unknown) => void {
  const handler = vi.mocked(connection.store.on).mock.calls.find(([registeredEvent]) => registeredEvent === event)?.[1];
  if (typeof handler !== "function") throw new Error(`Missing ${event} handler`);
  return handler as (payload: unknown) => void;
}

function framesFor(connection: ReturnType<typeof openConnection>, event: string): Record<string, unknown>[] {
  return vi.mocked(connection.res.write).mock.calls
    .map(([frame]) => String(frame))
    .filter((frame) => frame.startsWith(`event: ${event}\n`))
    .map((frame) => JSON.parse(frame.split("\n")[1]!.slice("data: ".length)) as Record<string, unknown>);
}

afterEach(() => vi.useRealTimers());

describe("task SSE project scope", () => {
  it("stamps every registered task lifecycle handler on a scoped connection", () => {
    const connection = openConnection("proj-a", "proj-a");
    const events: Array<[string, unknown]> = [
      ["task:created", { id: "KB-001" }],
      ["task:moved", { task: { id: "KB-001" }, from: "todo", to: "in-progress" }],
      ["task:updated", { id: "KB-001" }],
      ["task:deleted", { id: "KB-001" }],
      ["task:merged", { task: { id: "KB-001" }, from: "in-review", to: "done" }],
      ["agent:log", { taskId: "KB-001", timestamp: "2026-01-01T00:00:00Z", type: "text", agent: "agent-1" }],
    ];

    for (const [event, payload] of events) handlerFor(connection, event)(payload);

    for (const [event] of events) {
      const [frame] = framesFor(connection, event);
      expect(frame).toMatchObject({ projectId: "proj-a" });
    }
    for (const event of ["task:moved", "task:merged"]) {
      expect(framesFor(connection, event)[0]).toMatchObject({ task: { projectId: "proj-a" } });
    }
    connection.req.emit("close");
  });

  it("leaves an unscoped stream's task payload byte-compatible", () => {
    const connection = openConnection();
    handlerFor(connection, "task:moved")({ task: { id: "KB-001" }, from: "todo", to: "done" });

    expect(framesFor(connection, "task:moved")).toEqual([{ task: { id: "KB-001" }, from: "todo", to: "done" }]);
    connection.req.emit("close");
  });

  it("drops all task lifecycle frames when its store disagrees with stream scope", () => {
    const connection = openConnection("proj-a", "proj-b");
    for (const [event, payload] of [
      ["task:created", { id: "KB-001" }],
      ["task:moved", { task: { id: "KB-001" } }],
      ["task:updated", { id: "KB-001" }],
      ["task:deleted", { id: "KB-001" }],
      ["task:merged", { task: { id: "KB-001" } }],
      ["agent:log", { taskId: "KB-001", timestamp: "2026-01-01T00:00:00Z", type: "text", agent: "agent-1" }],
    ] as const) {
      handlerFor(connection, event)(payload);
    }

    expect(vi.mocked(connection.res.write).mock.calls.filter(([frame]) => String(frame).startsWith("event: task:") || String(frame).startsWith("event: agent:log"))).toEqual([]);
    connection.req.emit("close");
  });
});
