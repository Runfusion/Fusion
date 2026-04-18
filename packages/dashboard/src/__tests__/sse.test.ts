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

/**
 * Extract and parse the JSON data from an SSE message chunk.
 * SSE format: "event: event-name\ndata: {...json...}\n\n"
 * The regex needs to handle multiline JSON (e.g., with \n in strings).
 */
function extractSSEPayload(sseMsg: string): any {
  // Match everything between "data: " and the final "\n\n"
  const dataMatch = sseMsg.match(/data: ([\s\S]*?)\n\n/);
  if (!dataMatch) {
    return {};
  }
  return JSON.parse(dataMatch[1]);
}

/** Sample plugin installation for testing */
function createMockPlugin(overrides: Partial<{
  id: string;
  enabled: boolean;
  state: string;
  error?: string;
  settings: Record<string, unknown>;
}> = {}) {
  return {
    id: overrides.id ?? "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    description: "A test plugin",
    author: "Test Author",
    homepage: "https://example.com",
    path: "/path/to/plugin",
    enabled: overrides.enabled ?? true,
    state: overrides.state ?? "installed",
    settings: overrides.settings ?? {},
    settingsSchema: undefined,
    error: overrides.error,
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createMockMessage(overrides: Partial<{
  id: string;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  content: string;
  type: string;
  read: boolean;
}> = {}) {
  return {
    id: overrides.id ?? "msg-123",
    fromId: overrides.fromId ?? "dashboard",
    fromType: overrides.fromType ?? "user",
    toId: overrides.toId ?? "agent-1",
    toType: overrides.toType ?? "agent",
    content: overrides.content ?? "hello",
    type: overrides.type ?? "user-to-agent",
    read: overrides.read ?? false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
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

  it("strips heavy task logs from task event payloads", () => {
    const req = createMockRequest();
    const { res, chunks } = createMockResponse();
    createSSE(store)(req, res);

    store.emit("task:updated", {
      id: "FN-001",
      title: "Updated",
      log: [{ action: "very large log entry", timestamp: new Date().toISOString() }],
    });
    store.emit("task:moved", {
      task: {
        id: "FN-001",
        log: [{ action: "another large log entry", timestamp: new Date().toISOString() }],
      },
      from: "todo",
      to: "in-progress",
    });

    const updatedMsg = chunks.find((c) => c.includes("task:updated"))!;
    const movedMsg = chunks.find((c) => c.includes("task:moved"))!;

    expect(extractSSEPayload(updatedMsg).log).toEqual([]);
    expect(extractSSEPayload(movedMsg).task.log).toEqual([]);
    expect(updatedMsg).not.toContain("very large log entry");
    expect(movedMsg).not.toContain("another large log entry");
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

  it("relays mission:event events as SSE messages when missionStore is provided", () => {
    const missionStore = createMockStore();
    const req = createMockRequest();
    const { res, chunks } = createMockResponse();
    createSSE(store, missionStore)(req, res);

    const missionEvent = {
      id: "ME-001",
      missionId: "M-001",
      eventType: "mission_started",
      description: "Mission started",
      metadata: null,
      timestamp: new Date().toISOString(),
    };

    missionStore.emit("mission:event", missionEvent);

    const sseMsg = chunks.find((c) => c.includes("mission:event"));
    expect(sseMsg).toBeDefined();
    expect(sseMsg).toContain(JSON.stringify(missionEvent));
  });

  it("cleans up mission:event listener when client disconnects", () => {
    const missionStore = createMockStore();
    const req = createMockRequest();
    const { res } = createMockResponse();
    createSSE(store, missionStore)(req, res);

    expect(missionStore.listenerCount("mission:event")).toBe(1);

    req.emit("close");

    expect(missionStore.listenerCount("mission:event")).toBe(0);
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

  describe("message events", () => {
    it("relays message lifecycle events when messageStore is provided", () => {
      const messageStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, undefined, undefined, undefined, messageStore)(req, res);

      const sentMessage = createMockMessage();
      messageStore.emit("message:sent", sentMessage);
      messageStore.emit("message:received", sentMessage);
      messageStore.emit("message:read", { ...sentMessage, read: true });
      messageStore.emit("message:deleted", sentMessage.id);

      const sentEvent = chunks.find((c) => c.includes("event: message:sent"));
      const receivedEvent = chunks.find((c) => c.includes("event: message:received"));
      const readEvent = chunks.find((c) => c.includes("event: message:read"));
      const deletedEvent = chunks.find((c) => c.includes("event: message:deleted"));

      expect(sentEvent).toBeDefined();
      expect(receivedEvent).toBeDefined();
      expect(readEvent).toBeDefined();
      expect(deletedEvent).toBeDefined();

      expect(extractSSEPayload(sentEvent!).id).toBe(sentMessage.id);
      expect(extractSSEPayload(receivedEvent!).id).toBe(sentMessage.id);
      expect(extractSSEPayload(readEvent!).read).toBe(true);
      expect(extractSSEPayload(deletedEvent!).id).toBe(sentMessage.id);
    });

    it("cleans up message listeners on disconnect", () => {
      const messageStore = createMockStore();
      const req = createMockRequest();
      const { res } = createMockResponse();
      createSSE(store, undefined, undefined, undefined, undefined, undefined, messageStore)(req, res);

      expect(messageStore.listenerCount("message:sent")).toBe(1);
      expect(messageStore.listenerCount("message:received")).toBe(1);
      expect(messageStore.listenerCount("message:read")).toBe(1);
      expect(messageStore.listenerCount("message:deleted")).toBe(1);

      req.emit("close");

      expect(messageStore.listenerCount("message:sent")).toBe(0);
      expect(messageStore.listenerCount("message:received")).toBe(0);
      expect(messageStore.listenerCount("message:read")).toBe(0);
      expect(messageStore.listenerCount("message:deleted")).toBe(0);
    });
  });

  // ── Plugin Lifecycle Event Tests ─────────────────────────────────────────────

  describe("chat store events", () => {
    it("relays chat:session:created events when chatStore is provided", () => {
      const chatStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, undefined, undefined, undefined, undefined, chatStore)(req, res);

      const session = {
        id: "chat-abc123",
        agentId: "agent-001",
        title: "Test Session",
        status: "active",
        projectId: null,
        modelProvider: null,
        modelId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      chatStore.emit("chat:session:created", session);

      const sseMsg = chunks.find((c) => c.includes("event: chat:session:created"));
      expect(sseMsg).toBeDefined();
      expect(extractSSEPayload(sseMsg!).id).toBe("chat-abc123");
    });

    it("relays chat:session:updated events", () => {
      const chatStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, undefined, undefined, undefined, undefined, chatStore)(req, res);

      const session = {
        id: "chat-abc123",
        agentId: "agent-001",
        title: "Updated Title",
        status: "active",
        projectId: null,
        modelProvider: null,
        modelId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      };
      chatStore.emit("chat:session:updated", session);

      const sseMsg = chunks.find((c) => c.includes("event: chat:session:updated"));
      expect(sseMsg).toBeDefined();
      const payload = extractSSEPayload(sseMsg!);
      expect(payload.id).toBe("chat-abc123");
      expect(payload.title).toBe("Updated Title");
    });

    it("relays chat:session:deleted events with session ID", () => {
      const chatStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, undefined, undefined, undefined, undefined, chatStore)(req, res);

      chatStore.emit("chat:session:deleted", "chat-abc123");

      const sseMsg = chunks.find((c) => c.includes("event: chat:session:deleted"));
      expect(sseMsg).toBeDefined();
      expect(extractSSEPayload(sseMsg!).id).toBe("chat-abc123");
    });

    it("relays chat:message:added events with full message", () => {
      const chatStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, undefined, undefined, undefined, undefined, chatStore)(req, res);

      const message = {
        id: "msg-xyz789",
        sessionId: "chat-abc123",
        role: "user",
        content: "Hello, how are you?",
        thinkingOutput: null,
        metadata: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      chatStore.emit("chat:message:added", message);

      const sseMsg = chunks.find((c) => c.includes("event: chat:message:added"));
      expect(sseMsg).toBeDefined();
      const payload = extractSSEPayload(sseMsg!);
      expect(payload.id).toBe("msg-xyz789");
      expect(payload.sessionId).toBe("chat-abc123");
      expect(payload.content).toBe("Hello, how are you?");
    });

    it("relays chat:message:deleted events with message ID", () => {
      const chatStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, undefined, undefined, undefined, undefined, chatStore)(req, res);

      chatStore.emit("chat:message:deleted", "msg-xyz789");

      const sseMsg = chunks.find((c) => c.includes("event: chat:message:deleted"));
      expect(sseMsg).toBeDefined();
      expect(extractSSEPayload(sseMsg!).id).toBe("msg-xyz789");
    });

    it("cleans up chat store listeners on disconnect", () => {
      const chatStore = createMockStore();
      const req = createMockRequest();
      const { res } = createMockResponse();
      createSSE(store, undefined, undefined, undefined, undefined, undefined, undefined, chatStore)(req, res);

      expect(chatStore.listenerCount("chat:session:created")).toBe(1);
      expect(chatStore.listenerCount("chat:session:updated")).toBe(1);
      expect(chatStore.listenerCount("chat:session:deleted")).toBe(1);
      expect(chatStore.listenerCount("chat:message:added")).toBe(1);
      expect(chatStore.listenerCount("chat:message:deleted")).toBe(1);

      req.emit("close");

      expect(chatStore.listenerCount("chat:session:created")).toBe(0);
      expect(chatStore.listenerCount("chat:session:updated")).toBe(0);
      expect(chatStore.listenerCount("chat:session:deleted")).toBe(0);
      expect(chatStore.listenerCount("chat:message:added")).toBe(0);
      expect(chatStore.listenerCount("chat:message:deleted")).toBe(0);
    });
  });

  // ── Plugin Lifecycle Event Tests ─────────────────────────────────────────────

  describe("plugin lifecycle events", () => {
    it("emits plugin:lifecycle event for plugin:registered (installing transition)", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore)(req, res);

      const plugin = createMockPlugin({ id: "my-plugin", state: "installed" });
      pluginStore.emit("plugin:registered", plugin);

      const sseMsg = chunks.find((c) => c.includes("event: plugin:lifecycle"));
      expect(sseMsg).toBeDefined();
      expect(sseMsg).toContain("plugin:lifecycle");

      // Parse the payload
      const payload = extractSSEPayload(sseMsg!);
      expect(payload.pluginId).toBe("my-plugin");
      expect(payload.transition).toBe("installing");
      expect(payload.sourceEvent).toBe("plugin:registered");
      expect(payload.timestamp).toBeDefined();
      expect(payload.enabled).toBe(true);
      expect(payload.state).toBe("installed");
      expect(payload.version).toBe("1.0.0");
      expect(payload.settings).toEqual({});
    });

    it("emits plugin:lifecycle event for plugin:enabled (enabled transition)", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore)(req, res);

      const plugin = createMockPlugin({ id: "enabled-plugin", enabled: true, state: "started" });
      pluginStore.emit("plugin:enabled", plugin);

      const sseMsg = chunks.find((c) => c.includes("event: plugin:lifecycle"));
      expect(sseMsg).toBeDefined();

      const payload = extractSSEPayload(sseMsg!);
      expect(payload.pluginId).toBe("enabled-plugin");
      expect(payload.transition).toBe("enabled");
      expect(payload.sourceEvent).toBe("plugin:enabled");
      expect(payload.enabled).toBe(true);
    });

    it("emits plugin:lifecycle event for plugin:disabled (disabled transition)", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore)(req, res);

      const plugin = createMockPlugin({ id: "disabled-plugin", enabled: false, state: "stopped" });
      pluginStore.emit("plugin:disabled", plugin);

      const sseMsg = chunks.find((c) => c.includes("event: plugin:lifecycle"));
      expect(sseMsg).toBeDefined();

      const payload = extractSSEPayload(sseMsg!);
      expect(payload.pluginId).toBe("disabled-plugin");
      expect(payload.transition).toBe("disabled");
      expect(payload.sourceEvent).toBe("plugin:disabled");
      expect(payload.enabled).toBe(false);
    });

    it("emits plugin:lifecycle event for plugin:stateChanged with error state (error transition)", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore)(req, res);

      const plugin = createMockPlugin({
        id: "error-plugin",
        state: "error",
        error: "Failed to load: missing dependency",
      });
      pluginStore.emit("plugin:stateChanged", plugin);

      const sseMsg = chunks.find((c) => c.includes("event: plugin:lifecycle"));
      expect(sseMsg).toBeDefined();

      const payload = extractSSEPayload(sseMsg!);
      expect(payload.pluginId).toBe("error-plugin");
      expect(payload.transition).toBe("error");
      expect(payload.sourceEvent).toBe("plugin:stateChanged");
      expect(payload.state).toBe("error");
      expect(payload.error).toBe("Failed to load: missing dependency");
    });

    it("emits plugin:lifecycle event for plugin:unregistered (uninstalled transition)", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore)(req, res);

      const plugin = createMockPlugin({ id: "uninstalled-plugin" });
      pluginStore.emit("plugin:unregistered", plugin);

      const sseMsg = chunks.find((c) => c.includes("event: plugin:lifecycle"));
      expect(sseMsg).toBeDefined();

      const payload = extractSSEPayload(sseMsg!);
      expect(payload.pluginId).toBe("uninstalled-plugin");
      expect(payload.transition).toBe("uninstalled");
      expect(payload.sourceEvent).toBe("plugin:unregistered");
    });

    it("emits plugin:lifecycle event for plugin:updated (settings-updated transition)", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore)(req, res);

      const plugin = createMockPlugin({
        id: "settings-plugin",
        settings: { apiKey: "secret123", debugMode: true },
      });
      pluginStore.emit("plugin:updated", plugin);

      const sseMsg = chunks.find((c) => c.includes("event: plugin:lifecycle"));
      expect(sseMsg).toBeDefined();

      const payload = extractSSEPayload(sseMsg!);
      expect(payload.pluginId).toBe("settings-plugin");
      expect(payload.transition).toBe("settings-updated");
      expect(payload.sourceEvent).toBe("plugin:updated");
      expect(payload.settings).toEqual({ apiKey: "secret123", debugMode: true });
    });

    it("includes projectId in payload when options.projectId is provided", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore, { projectId: "proj_abc123" })(req, res);

      const plugin = createMockPlugin({ id: "scoped-plugin" });
      pluginStore.emit("plugin:registered", plugin);

      const sseMsg = chunks.find((c) => c.includes("event: plugin:lifecycle"));
      expect(sseMsg).toBeDefined();

      const payload = extractSSEPayload(sseMsg!);
      expect(payload.projectId).toBe("proj_abc123");
    });

    it("does not include projectId in payload for default streams", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore)(req, res);

      const plugin = createMockPlugin({ id: "default-plugin" });
      pluginStore.emit("plugin:registered", plugin);

      const sseMsg = chunks.find((c) => c.includes("event: plugin:lifecycle"));
      expect(sseMsg).toBeDefined();

      const payload = extractSSEPayload(sseMsg!);
      expect(payload.projectId).toBeUndefined();
    });

    it("cleans up plugin listeners when client disconnects", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore)(req, res);

      // Verify listeners are attached
      expect(pluginStore.listenerCount("plugin:registered")).toBe(1);
      expect(pluginStore.listenerCount("plugin:unregistered")).toBe(1);
      expect(pluginStore.listenerCount("plugin:updated")).toBe(1);
      expect(pluginStore.listenerCount("plugin:enabled")).toBe(1);
      expect(pluginStore.listenerCount("plugin:disabled")).toBe(1);
      expect(pluginStore.listenerCount("plugin:stateChanged")).toBe(1);

      req.emit("close");

      // All plugin listeners should be removed
      expect(pluginStore.listenerCount("plugin:registered")).toBe(0);
      expect(pluginStore.listenerCount("plugin:unregistered")).toBe(0);
      expect(pluginStore.listenerCount("plugin:updated")).toBe(0);
      expect(pluginStore.listenerCount("plugin:enabled")).toBe(0);
      expect(pluginStore.listenerCount("plugin:disabled")).toBe(0);
      expect(pluginStore.listenerCount("plugin:stateChanged")).toBe(0);
    });

    it("stops writing and cleans up plugin listeners when res.write throws", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore)(req, res);

      // Make write throw on next call
      (res.write as any).mockImplementation(() => {
        throw new Error("Socket closed");
      });

      // Emit a plugin event — should not throw
      const plugin = createMockPlugin({ id: "cleanup-plugin" });
      expect(() => pluginStore.emit("plugin:registered", plugin)).not.toThrow();

      // All plugin listeners should be removed
      expect(pluginStore.listenerCount("plugin:registered")).toBe(0);
      expect(pluginStore.listenerCount("plugin:enabled")).toBe(0);
    });

    it("handles multiple plugin lifecycle events in sequence", () => {
      const pluginStore = createMockStore();
      const req = createMockRequest();
      const { res, chunks } = createMockResponse();
      createSSE(store, undefined, undefined, pluginStore)(req, res);

      // Simulate a plugin lifecycle: install → enable → update settings
      const plugin1 = createMockPlugin({ id: "multi-plugin", state: "installed" });
      pluginStore.emit("plugin:registered", plugin1);

      const plugin2 = createMockPlugin({ id: "multi-plugin", enabled: true, state: "started" });
      pluginStore.emit("plugin:enabled", plugin2);

      const plugin3 = createMockPlugin({ id: "multi-plugin", settings: { key: "value" } });
      pluginStore.emit("plugin:updated", plugin3);

      const lifecycleEvents = chunks.filter((c) => c.includes("event: plugin:lifecycle"));
      expect(lifecycleEvents.length).toBe(3);

      const payload1 = extractSSEPayload(lifecycleEvents[0]);
      expect(payload1.transition).toBe("installing");

      const payload2 = extractSSEPayload(lifecycleEvents[1]);
      expect(payload2.transition).toBe("enabled");

      const payload3 = extractSSEPayload(lifecycleEvents[2]);
      expect(payload3.transition).toBe("settings-updated");
    });
  });
});
