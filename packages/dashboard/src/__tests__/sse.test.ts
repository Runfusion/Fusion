import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { TaskStore, AutomationStore, ChatStore } from "@fusion/core";
import {
  createSSE,
  disconnectSSEClient,
  emitApprovalSseEvent,
  emitPluginCustomSseEvent,
  getActiveSSEConnections,
  markSSEClientAlive,
} from "../sse.js";

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

function createMockStore(settings: Record<string, unknown> = {}): TaskStore {
  const researchStore = {
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    on: vi.fn(),
    off: vi.fn(),
    getResearchStore: vi.fn(() => researchStore),
    getSettings: vi.fn(async () => settings),
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

function createMockChatStore(sessions: Record<string, { id: string; agentId: string; projectId?: string | null }>): ChatStore {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSession: vi.fn((id: string) => sessions[id]),
  }) as unknown as ChatStore;
}

function openSseConnectionWithChatStore(
  clientId: string,
  chatStore: ChatStore,
  projectId?: string,
  settings: Record<string, unknown> = {},
) {
  const store = createMockStore(settings);
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
    chatStore,
  )(req, res as unknown as Response);

  return { req, res, socket, store, chatStore };
}

function parseSsePayload(writeCall: unknown[]): Record<string, unknown> {
  const frame = String(writeCall[0]);
  const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`No SSE data line in frame: ${frame}`);
  return JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("approval SSE events", () => {
  it("relays approval events to connected clients", () => {
    const connection = openSseConnection("approval-relay");

    emitApprovalSseEvent("approval:requested", { id: "apr-1", status: "pending" });
    emitApprovalSseEvent("approval:updated", { id: "apr-1", status: "pending" });
    emitApprovalSseEvent("approval:decided", { id: "apr-1", status: "approved" });

    expect(connection.res.write).toHaveBeenCalledWith(
      `event: approval:requested\ndata: ${JSON.stringify({ id: "apr-1", status: "pending" })}\n\n`,
    );
    expect(connection.res.write).toHaveBeenCalledWith(
      `event: approval:updated\ndata: ${JSON.stringify({ id: "apr-1", status: "pending" })}\n\n`,
    );
    expect(connection.res.write).toHaveBeenCalledWith(
      `event: approval:decided\ndata: ${JSON.stringify({ id: "apr-1", status: "approved" })}\n\n`,
    );

    connection.req.emit("close");
  });

  it("filters project-scoped approval events to matching project connections", () => {
    const projectA = openSseConnection("approval-project", "project-a");
    const projectB = openSseConnection("approval-project", "project-b");

    emitApprovalSseEvent("approval:requested", { id: "apr-a" }, "project-a");

    expect(projectA.res.write).toHaveBeenCalledWith(
      `event: approval:requested\ndata: ${JSON.stringify({ id: "apr-a" })}\n\n`,
    );
    expect(projectB.res.write).not.toHaveBeenCalledWith(
      `event: approval:requested\ndata: ${JSON.stringify({ id: "apr-a" })}\n\n`,
    );

    projectA.req.emit("close");
    projectB.req.emit("close");
  });
});

describe("plugin custom SSE events", () => {
  it("relays a plugin's custom event to connected clients as plugin:custom", () => {
    const connection = openSseConnection("plugin-custom-relay");

    emitPluginCustomSseEvent("fusion-plugin-compound-engineering", "ce:session-question", {
      sessionId: "s1",
      questionId: "q1",
    });

    expect(connection.res.write).toHaveBeenCalledWith(
      `event: plugin:custom\ndata: ${JSON.stringify({
        pluginId: "fusion-plugin-compound-engineering",
        event: "ce:session-question",
        payload: { sessionId: "s1", questionId: "q1" },
      })}\n\n`,
    );

    connection.req.emit("close");
  });

  it("scopes project-tagged plugin events to the matching project connection", () => {
    const projectA = openSseConnection("plugin-custom-project", "project-a");
    const projectB = openSseConnection("plugin-custom-project", "project-b");

    emitPluginCustomSseEvent("p", "evt", { sessionId: "s1" }, "project-a");

    const expected = `event: plugin:custom\ndata: ${JSON.stringify({
      pluginId: "p",
      event: "evt",
      payload: { sessionId: "s1" },
    })}\n\n`;
    expect(projectA.res.write).toHaveBeenCalledWith(expected);
    expect(projectB.res.write).not.toHaveBeenCalledWith(expected);

    projectA.req.emit("close");
    projectB.req.emit("close");
  });
});

describe("chat store SSE events", () => {
  it("enriches direct message payloads with hidden planner session metadata", async () => {
    const chatStore = createMockChatStore({
      "sess-planner": { id: "sess-planner", agentId: "task-planner:FN-7392", projectId: "project-a" },
    });
    const connection = openSseConnectionWithChatStore("chat-planner-metadata", chatStore, "project-a");

    chatStore.emit("chat:message:added", {
      id: "msg-1",
      sessionId: "sess-planner",
      role: "assistant",
      content: "Done",
    });

    await vi.waitFor(() => {
      expect(connection.res.write).toHaveBeenCalledWith(expect.stringContaining("event: chat:message:added"));
    });
    const payload = parseSsePayload(vi.mocked(connection.res.write).mock.calls.at(-1) ?? []);
    expect(payload).toMatchObject({
      id: "msg-1",
      sessionId: "sess-planner",
      role: "assistant",
      content: "Done",
      agentId: "task-planner:FN-7392",
      projectId: "project-a",
      taskChatVisibleInCommonFeed: false,
    });

    connection.req.emit("close");
  });

  it("enriches planner session visibility when project opts into the common feed", async () => {
    const chatStore = createMockChatStore({
      "sess-planner": { id: "sess-planner", agentId: "task-planner:FN-7392", projectId: "project-a" },
    });
    const connection = openSseConnectionWithChatStore("chat-planner-visible", chatStore, "project-a", {
      showTaskChatsInCommonFeed: true,
    });

    chatStore.emit("chat:message:added", {
      id: "msg-visible",
      sessionId: "sess-planner",
      role: "assistant",
      content: "Visible",
    });

    await vi.waitFor(() => {
      expect(connection.res.write).toHaveBeenCalledWith(expect.stringContaining("event: chat:message:added"));
    });
    const payload = parseSsePayload(vi.mocked(connection.res.write).mock.calls.at(-1) ?? []);
    expect(payload).toMatchObject({
      id: "msg-visible",
      sessionId: "sess-planner",
      role: "assistant",
      content: "Visible",
      agentId: "task-planner:FN-7392",
      projectId: "project-a",
      taskChatVisibleInCommonFeed: true,
    });

    connection.req.emit("close");
  });

  it("keeps normal direct message payload fields compatible while adding session metadata", async () => {
    const chatStore = createMockChatStore({
      "sess-direct": { id: "sess-direct", agentId: "agent-123", projectId: null },
    });
    const connection = openSseConnectionWithChatStore("chat-direct-metadata", chatStore);

    chatStore.emit("chat:message:added", {
      id: "msg-2",
      sessionId: "sess-direct",
      role: "assistant",
      content: "Hello",
      projectId: "event-project",
    });

    await vi.waitFor(() => {
      expect(connection.res.write).toHaveBeenCalledWith(expect.stringContaining("event: chat:message:added"));
    });
    const payload = parseSsePayload(vi.mocked(connection.res.write).mock.calls.at(-1) ?? []);
    expect(payload).toMatchObject({
      id: "msg-2",
      sessionId: "sess-direct",
      role: "assistant",
      content: "Hello",
      projectId: "event-project",
      agentId: "agent-123",
    });
    expect(payload).not.toHaveProperty("taskChatVisibleInCommonFeed");

    connection.req.emit("close");
  });
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

    vi.advanceTimersByTime(74_999);
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

    vi.advanceTimersByTime(30_000);
    expect(markSSEClientAlive("client-five")).toBe(1);

    vi.advanceTimersByTime(74_999);
    expect(connection.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 1);

    vi.advanceTimersByTime(1);
    expect(connection.res.end).toHaveBeenCalledTimes(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });

  it("emits task:assigned SSE event from agent assignments", () => {
    let onAssigned: ((agent: unknown, taskId: string) => void) | undefined;
    const store = createMockStore();
    const agentStore = {
      on: vi.fn((event: string, handler: (agent: unknown, taskId: string) => void) => {
        if (event === "agent:assigned") onAssigned = handler;
      }),
      off: vi.fn(),
    };
    const socket = new MockSocket();
    const req = new EventEmitter() as Request & { query: Record<string, string>; socket: MockSocket };
    req.query = { clientId: "assigned-client" };
    req.socket = socket;
    const res = new MockResponse(socket);

    createSSE(store, undefined, undefined, undefined, undefined, agentStore as never)(
      req,
      res as unknown as Response
    );

    onAssigned?.({ id: "agent-1" }, "FN-1");

    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining("event: task:assigned")
    );
    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining('"taskId":"FN-1"')
    );
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
      getResearchStore: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
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

describe("workflow setting value SSE", () => {
  it("forwards authoritative workflow setting mutations and removes the listener on close", () => {
    const { req, res, store } = openSseConnection("workflow-settings-client", "project-1");
    const onCall = vi.mocked(store.on).mock.calls.find(([event]) => event === "workflow:setting-values-updated");
    const handler = onCall?.[1] as ((payload: unknown) => void) | undefined;

    expect(typeof handler).toBe("function");
    handler?.({
      workflowId: "builtin:coding",
      projectId: "project-1",
      settingIds: ["plannerOversightLevel"],
      mutationId: "revision-1",
    });

    expect(res.write).toHaveBeenCalledWith(expect.stringContaining("event: workflow:setting-values-updated"));
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"mutationId":"revision-1"'));

    req.emit("close");
    expect(store.off).toHaveBeenCalledWith("workflow:setting-values-updated", handler);
  });
});
