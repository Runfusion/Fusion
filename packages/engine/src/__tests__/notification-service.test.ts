import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChatRoomMessage, Message, NotificationProvider, Settings, Task } from "@fusion/core";
import { NotificationService } from "../notification/notification-service.js";
import { NtfyNotificationProvider } from "../notification/ntfy-provider.js";
import { DEFAULT_NTFY_EVENTS } from "../notifier.js";
import { schedulerLog } from "../logger.js";

vi.mock("../logger.js", () => ({
  schedulerLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
type Listener = (...args: any[]) => void | Promise<void>;

function createStore(settings: Partial<Settings> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const tasks = new Map<string, Task>();
  const getBucket = (event: string) => listeners.get(event) ?? new Set<Listener>();

  return {
    getSettings: vi.fn(async () => ({ ntfyEnabled: false, ...settings }) as Settings),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    on: vi.fn((event: string, listener: Listener) => {
      const bucket = getBucket(event);
      bucket.add(listener);
      listeners.set(event, bucket);
    }),
    off: vi.fn((event: string, listener: Listener) => {
      getBucket(event).delete(listener);
    }),
    emit(event: string, payload: unknown) {
      for (const listener of getBucket(event)) {
        void listener(payload);
      }
    },
    setTask(task: Task) {
      tasks.set(task.id, task);
    },
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "Task title",
    description: "Task desc",
    status: "todo",
    column: "todo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    ...overrides,
  } as Task;
}

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    fromId: "agent-1",
    fromType: "agent",
    toId: "user:dashboard",
    toType: "user",
    content: "hello from agent",
    type: "agent-to-user",
    read: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Message;
}

function createRoomMessage(overrides: Partial<ChatRoomMessage> = {}): ChatRoomMessage {
  return {
    id: "rmsg-1",
    roomId: "room-1",
    role: "assistant",
    content: "hello from room agent",
    thinkingOutput: null,
    metadata: null,
    attachments: [],
    senderAgentId: "agent-1",
    mentions: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("NotificationService", () => {
  it("dispatches in-review event to registered provider", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any);
    service.registerProvider(provider);
    await service.start();

    store.emit("task:moved", { task: task(), from: "todo", to: "in-review" });
    await Promise.resolve();

    expect(sendNotification).toHaveBeenCalledWith(
      "in-review",
      expect.objectContaining({ taskId: "FN-1", event: "in-review" }),
    );
  });

  describe("task-created notifications", () => {
    it("dispatches exactly once for agent-created tasks when enabled", async () => {
      const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic", ntfyEvents: ["task-created"] as any });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const provider: NotificationProvider = {
        getProviderId: () => "mock",
        isEventSupported: () => true,
        sendNotification,
      };

      const service = new NotificationService(store as any, {
        agentNameResolver: (agentId) => (agentId === "agent-1" ? "Triage Bot" : null),
      });
      service.registerProvider(provider);
      await service.start();

      store.emit("task:created", task({ id: "FN-201", sourceAgentId: "agent-1", sourceType: "agent_heartbeat" as any }));
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith(
          "task-created",
          expect.objectContaining({
            taskId: "FN-201",
            event: "task-created",
            metadata: expect.objectContaining({ sourceAgentId: "agent-1", agentName: "Triage Bot" }),
          }),
        );
      });
    });

    it("does not dispatch for non-agent task creation", async () => {
      const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic", ntfyEvents: ["task-created"] as any });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      store.emit("task:created", task({ id: "FN-202", sourceAgentId: undefined }));
      await Promise.resolve();

      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("filters task-created when event is disabled", async () => {
      const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic", ntfyEvents: ["in-review"] as any });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: (event) => event !== "task-created", sendNotification });
      await service.start();

      store.emit("task:created", task({ id: "FN-203", sourceAgentId: "agent-1", sourceType: "agent_heartbeat" as any }));
      await Promise.resolve();

      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("deduplicates duplicate task:created events for the same task id", async () => {
      const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic", ntfyEvents: ["task-created"] as any });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      const createdTask = task({ id: "FN-204", sourceAgentId: "agent-1", sourceType: "agent_heartbeat" as any });
      store.emit("task:created", createdTask);
      store.emit("task:created", createdTask);
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("deduplicates same task+event but not different event types", async () => {
    const store = createStore({
      ntfyEnabled: true,
      ntfyTopic: "topic",
      failureNotificationMode: "all",
    });
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, { failedNotificationGraceMs: 0 });
    service.registerProvider(provider);
    await service.start();

    store.emit("task:moved", { task: task(), from: "todo", to: "in-review" });
    store.emit("task:moved", { task: task(), from: "todo", to: "in-review" });
    store.emit("task:updated", task({ status: "awaiting-approval" }));
    await Promise.resolve();

    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("stop unsubscribes listeners", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any);
    service.registerProvider(provider);
    await service.start();
    await service.stop();

    store.emit("task:moved", { task: task(), from: "todo", to: "in-review" });
    await Promise.resolve();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("auto-registers ntfy provider when enabled and topic set", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "demo", ntfyDashboardHost: "http://x" });
    const initSpy = vi.spyOn(NtfyNotificationProvider.prototype, "initialize");

    const service = new NotificationService(store as any, { projectId: "p1", ntfyBaseUrl: "https://n" });
    await service.start();

    expect(initSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "demo",
        projectId: "p1",
        ntfyBaseUrl: "https://n",
        ntfyAccessToken: undefined,
      }),
    );
    initSpy.mockRestore();
  });

  it("skips ntfy provider when disabled", async () => {
    const store = createStore({ ntfyEnabled: false, ntfyTopic: "demo" });
    const initSpy = vi.spyOn(NtfyNotificationProvider.prototype, "initialize");
    const service = new NotificationService(store as any);
    await service.start();
    expect(initSpy).not.toHaveBeenCalled();
    initSpy.mockRestore();
  });

  it("reconfigures the ntfy provider when the access token changes without logging the token", async () => {
    const store = createStore({
      ntfyEnabled: true,
      ntfyTopic: "demo",
      ntfyAccessToken: "old-token",
    });
    const initSpy = vi.spyOn(NtfyNotificationProvider.prototype, "initialize");

    const service = new NotificationService(store as any, { projectId: "p1" });
    await service.start();

    store.emit("settings:updated", {
      settings: {
        ntfyEnabled: true,
        ntfyTopic: "demo",
        ntfyAccessToken: "new-token",
      } as Settings,
      previous: {
        ntfyEnabled: true,
        ntfyTopic: "demo",
        ntfyAccessToken: "old-token",
      } as Settings,
    });

    await vi.waitFor(() => {
      expect(initSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          topic: "demo",
          projectId: "p1",
          ntfyAccessToken: "new-token",
        }),
      );
    });

    await vi.waitFor(() => {
      expect(schedulerLog.log).toHaveBeenCalledWith("NotificationService ntfy access token updated");
    });
    expect(schedulerLog.log).not.toHaveBeenCalledWith(expect.stringContaining("new-token"));
    expect(schedulerLog.log).not.toHaveBeenCalledWith(expect.stringContaining("old-token"));
    initSpy.mockRestore();
  });

  it("dispatches message:agent-to-user from message:sent", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const messageStore = new EventEmitter();
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, { messageStore: messageStore as any });
    service.registerProvider(provider);
    await service.start();

    messageStore.emit("message:sent", createMessage());
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });

    expect(sendNotification).toHaveBeenCalledWith(
      "message:agent-to-user",
      expect.objectContaining({
        event: "message:agent-to-user",
        metadata: expect.objectContaining({
          messageId: "msg-1",
          fromId: "agent-1",
          toId: "user:dashboard",
          preview: "hello from agent",
        }),
      }),
    );
  });

  it("includes resolved agent names in message metadata", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const messageStore = new EventEmitter();
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, {
      messageStore: messageStore as any,
      agentNameResolver: (agentId) => (agentId === "agent-1" ? "Triage Bot" : "Executor Bot"),
    });
    service.registerProvider(provider);
    await service.start();

    messageStore.emit(
      "message:sent",
      createMessage({ type: "agent-to-agent", toId: "agent-2", toType: "agent" }),
    );
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });

    expect(sendNotification).toHaveBeenCalledWith(
      "message:agent-to-agent",
      expect.objectContaining({
        metadata: expect.objectContaining({ fromName: "Triage Bot", toName: "Executor Bot" }),
      }),
    );
  });

  it("dispatches message:room from chat:room:message:added", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const chatStore = new EventEmitter() as EventEmitter & {
      getRoom: (id: string) => { id: string; name: string } | undefined;
    };
    chatStore.getRoom = (id: string) => (id === "room-1" ? { id, name: "Incident Room" } : undefined);
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, {
      chatStore: chatStore as any,
      agentNameResolver: (agentId) => (agentId === "agent-1" ? "Triage Bot" : null),
    });
    service.registerProvider(provider);
    await service.start();

    chatStore.emit("chat:room:message:added", createRoomMessage());
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });

    expect(sendNotification).toHaveBeenCalledWith(
      "message:room",
      expect.objectContaining({
        event: "message:room",
        metadata: expect.objectContaining({
          messageId: "rmsg-1",
          roomId: "room-1",
          roomName: "Incident Room",
          senderAgentId: "agent-1",
          senderName: "Triage Bot",
          preview: "hello from room agent",
          type: "room-assistant",
        }),
      }),
    );
  });

  it("dispatches room notifications when chat store attaches after start", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const chatStore = new EventEmitter() as EventEmitter & {
      getRoom: (id: string) => { id: string; name: string } | undefined;
    };
    chatStore.getRoom = (id: string) => (id === "room-1" ? { id, name: "Incident Room" } : undefined);
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, {
      agentNameResolver: () => "Triage Bot",
    });
    service.registerProvider(provider);
    await service.start();
    service.attachChatStore(chatStore as any);

    chatStore.emit("chat:room:message:added", createRoomMessage());
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledWith(
        "message:room",
        expect.objectContaining({ event: "message:room" }),
      );
    });
  });

  it("ignores non-agent or non-assistant room messages", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const chatStore = new EventEmitter();
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, { chatStore: chatStore as any });
    service.registerProvider(provider);
    await service.start();

    chatStore.emit("chat:room:message:added", createRoomMessage({ role: "user" }));
    chatStore.emit("chat:room:message:added", createRoomMessage({ id: "rmsg-2", senderAgentId: null }));
    await Promise.resolve();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("dispatches even when agent name resolution fails", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const messageStore = new EventEmitter();
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, {
      messageStore: messageStore as any,
      agentNameResolver: () => {
        throw new Error("boom");
      },
    });
    service.registerProvider(provider);
    await service.start();

    messageStore.emit("message:sent", createMessage({ type: "agent-to-user" }));
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });

    expect(sendNotification).toHaveBeenCalledWith(
      "message:agent-to-user",
      expect.objectContaining({
        metadata: expect.not.objectContaining({ fromName: expect.any(String), toName: expect.any(String) }),
      }),
    );
    expect(schedulerLog.log).toHaveBeenCalledWith(
      expect.stringContaining("failed to resolve from agent name"),
    );
  });

  it("dispatches message:agent-to-agent with reply metadata", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const messageStore = new EventEmitter();
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, { messageStore: messageStore as any });
    service.registerProvider(provider);
    await service.start();

    messageStore.emit(
      "message:sent",
      createMessage({
        id: "msg-2",
        type: "agent-to-agent",
        toId: "agent-2",
        toType: "agent",
        metadata: { replyTo: { messageId: "msg-1" } },
      }),
    );
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });

    expect(sendNotification).toHaveBeenCalledWith(
      "message:agent-to-agent",
      expect.objectContaining({
        event: "message:agent-to-agent",
        metadata: expect.objectContaining({
          messageId: "msg-2",
          replyToMessageId: "msg-1",
        }),
      }),
    );
  });

  it("ignores user-to-agent message:sent events", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const messageStore = new EventEmitter();
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, { messageStore: messageStore as any });
    service.registerProvider(provider);
    await service.start();

    messageStore.emit("message:sent", createMessage({ type: "user-to-agent", fromType: "user", toType: "agent" }));
    await Promise.resolve();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("refreshes notification settings for message events when startup settings were stale", async () => {
    let calls = 0;
    const store = createStore();
    store.getSettings = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { ntfyEnabled: false, ntfyTopic: "topic" } as Settings;
      }
      return { ntfyEnabled: true, ntfyTopic: "topic" } as Settings;
    });

    const messageStore = new EventEmitter();
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, { messageStore: messageStore as any });
    service.registerProvider(provider);
    await service.start();

    messageStore.emit("message:sent", createMessage());

    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledWith(
        "message:agent-to-user",
        expect.objectContaining({ event: "message:agent-to-user" }),
      );
    });
    expect(schedulerLog.log).toHaveBeenCalledWith(
      expect.stringContaining("NotificationService refreshed notification state reason=message:sent enabled=true"),
    );
  });

  it("does not dispatch mailbox notifications when disabled", async () => {    const store = createStore({ ntfyEnabled: false, webhookEnabled: false });
    const messageStore = new EventEmitter();
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, { messageStore: messageStore as any });
    service.registerProvider(provider);
    await service.start();

    messageStore.emit("message:sent", createMessage());
    await Promise.resolve();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("stop unsubscribes message:sent listener", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const messageStore = new EventEmitter();
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const service = new NotificationService(store as any, { messageStore: messageStore as any });
    service.registerProvider(provider);
    await service.start();

    expect(messageStore.listenerCount("message:sent")).toBeGreaterThan(0);
    await service.stop();
    expect(messageStore.listenerCount("message:sent")).toBe(0);

    messageStore.emit("message:sent", createMessage());
    await Promise.resolve();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("duplicates merged dispatch when multiple NotificationService instances subscribe to the same store", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };

    const first = new NotificationService(store as any);
    const second = new NotificationService(store as any);
    first.registerProvider(provider);
    second.registerProvider(provider);
    await first.start();
    await second.start();

    // Confirms duplication is from duplicate listener graphs, not duplicate task:merged payloads.
    store.emit("task:merged", {
      task: task(),
      branch: "fusion/fn-1",
      merged: true,
      worktreeRemoved: true,
      branchDeleted: true,
    });
    await Promise.resolve();

    expect(sendNotification).toHaveBeenCalledTimes(2);

    await first.stop();
    await second.stop();
  });

  describe("stale-settings refresh for task lifecycle", () => {
    function createStaleLifecycleStore() {
      const listeners = new Map<string, Set<Listener>>();
      let getSettingsCallCount = 0;
      const getBucket = (event: string) => listeners.get(event) ?? new Set<Listener>();

      return {
        getSettings: vi.fn(async () => {
          getSettingsCallCount += 1;
          if (getSettingsCallCount === 1) {
            return { ntfyEnabled: false, ntfyTopic: "" } as Settings;
          }
          return {
            ntfyEnabled: true,
            ntfyTopic: "fusion-test",
            ntfyEvents: [...DEFAULT_NTFY_EVENTS],
            ntfyDashboardHost: "http://localhost:4040",
          } as Settings;
        }),
        getTask: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: Listener) => {
          const bucket = getBucket(event);
          bucket.add(listener);
          listeners.set(event, bucket);
        }),
        off: vi.fn((event: string, listener: Listener) => {
          getBucket(event).delete(listener);
        }),
        emit(event: string, payload: unknown) {
          for (const listener of getBucket(event)) {
            void listener(payload);
          }
        },
      };
    }

    it("refreshes stale disabled settings before in-review and merged notifications", async () => {
      const store = createStaleLifecycleStore();
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      store.emit("task:moved", { task: task({ id: "FN-101" }), from: "in-progress", to: "in-review" });
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith(
          "in-review",
          expect.objectContaining({ taskId: "FN-101", event: "in-review" }),
        );
      });

      store.emit("task:merged", {
        task: task({ id: "FN-102" }),
        branch: "fusion/fn-102",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      });
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith(
          "merged",
          expect.objectContaining({ taskId: "FN-102", event: "merged" }),
        );
      });
    });

    it("does not notify when merge result is not merged", async () => {
      const store = createStaleLifecycleStore();
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      store.emit("task:merged", {
        task: task({ id: "FN-103" }),
        branch: "fusion/fn-103",
        merged: false,
        worktreeRemoved: true,
        branchDeleted: false,
      });
      await Promise.resolve();

      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("does not notify for non-in-review moves even after stale-settings refresh", async () => {
      const store = createStaleLifecycleStore();
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      store.emit("task:moved", { task: task({ id: "FN-104" }), from: "todo", to: "in-progress" });
      await Promise.resolve();

      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("still notifies after a late settings:updated enable event", async () => {
      const store = createStore({ ntfyEnabled: false, ntfyTopic: "" });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      store.emit("settings:updated", {
        settings: {
          ntfyEnabled: true,
          ntfyTopic: "fusion-test",
          ntfyEvents: [...DEFAULT_NTFY_EVENTS],
          ntfyDashboardHost: "http://localhost:4040",
        } as Settings,
        previous: {
          ntfyEnabled: false,
          ntfyTopic: "",
        } as Settings,
      });
      store.emit("task:moved", { task: task({ id: "FN-105" }), from: "in-progress", to: "in-review" });

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith(
          "in-review",
          expect.objectContaining({ taskId: "FN-105", event: "in-review" }),
        );
      });
    });
  });

  it("suppresses transient failed notification after Auto-recovered status clear", async () => {
    vi.useFakeTimers();
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic", failureNotificationMode: "sticky-only", failureNotificationDelayMs: 50 });
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const service = new NotificationService(store as any);
    service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
    await service.start();

    store.setTask(task({ id: "FN-1", status: "failed", column: "in-review" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed", column: "in-review" }));
    store.setTask(task({ id: "FN-1", status: "in-review", column: "in-review", log: [{ timestamp: new Date().toISOString(), action: "Auto-recovered: merge deadlock resolved" }] }));
    store.emit("task:updated", task({ id: "FN-1", status: "in-review" }));

    await vi.advanceTimersByTimeAsync(60);
    expect(sendNotification).not.toHaveBeenCalledWith("failed", expect.anything());
    await service.stop();
    vi.useRealTimers();
  });

  it("dispatches failed once when failure persists beyond grace window", async () => {
    vi.useFakeTimers();
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic", failureNotificationMode: "sticky-only", failureNotificationDelayMs: 50 });
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const service = new NotificationService(store as any);
    service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
    await service.start();

    const failed = task({ id: "FN-1", status: "failed" });
    store.setTask(failed);
    store.emit("task:updated", failed);

    await vi.advanceTimersByTimeAsync(60);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("failed", expect.objectContaining({ taskId: "FN-1" }));
    await service.stop();
    vi.useRealTimers();
  });

  it("suppresses pending failed notification on task:moved to done", async () => {
    vi.useFakeTimers();
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic", failureNotificationMode: "sticky-only", failureNotificationDelayMs: 50 });
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const service = new NotificationService(store as any);
    service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
    await service.start();

    store.setTask(task({ id: "FN-1", status: "failed", column: "in-review" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed", column: "in-review" }));
    store.setTask(task({ id: "FN-1", status: undefined, column: "done" }));
    store.emit("task:moved", { task: task({ id: "FN-1", status: undefined, column: "done" }), from: "in-review", to: "done" });

    await vi.advanceTimersByTimeAsync(60);
    expect(sendNotification).not.toHaveBeenCalledWith("failed", expect.anything());
    await service.stop();
    vi.useRealTimers();
  });

  it("suppresses pending failed notification when mergeConfirmed becomes true", async () => {
    vi.useFakeTimers();
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic", failureNotificationMode: "sticky-only", failureNotificationDelayMs: 50 });
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const service = new NotificationService(store as any);
    service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
    await service.start();

    store.setTask(task({ id: "FN-1", status: "failed" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));
    store.setTask(task({ id: "FN-1", status: "failed", mergeDetails: { mergeConfirmed: true } as any }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    await vi.advanceTimersByTimeAsync(60);
    expect(sendNotification).not.toHaveBeenCalledWith("failed", expect.anything());
    await service.stop();
    vi.useRealTimers();
  });

  it("stop clears pending failed timers without dispatch", async () => {
    vi.useFakeTimers();
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic", failureNotificationMode: "sticky-only", failureNotificationDelayMs: 50 });
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const service = new NotificationService(store as any);
    service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
    await service.start();

    store.setTask(task({ id: "FN-1", status: "failed" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));
    await service.stop();

    await vi.advanceTimersByTimeAsync(60);
    expect(sendNotification).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
