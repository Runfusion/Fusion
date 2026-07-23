import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChatRoomMessage, Message, NotificationProvider, Settings, Task } from "@fusion/core";
import { NotificationService } from "../notification/notification-service.js";
import { NtfyNotificationProvider } from "../notification/ntfy-provider.js";
import { DEFAULT_NTFY_EVENTS } from "../util/notifier.js";
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

function mockNtfyFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
  } as Response);
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

      store.emit(
        "task:created",
        task({
          id: "FN-201",
          title: "",
          description: "Investigate the notification payload fallback",
          sourceAgentId: "agent-1",
          sourceType: "agent_heartbeat" as any,
        }),
      );
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith(
          "task-created",
          expect.objectContaining({
            taskId: "FN-201",
            taskDescription: "Investigate the notification payload fallback",
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

  /*
  FNXC:PlanApprovalMailbox 2026-07-16-19:20:
  Awaiting-approval fires BOTH channels: the ntfy push AND a durable, task-linked mailbox
  message (system-typed, idempotent per task). These tests lock the invariant across the
  manual gate and the plan-review-replan-cap escalation, and prove best-effort isolation.
  */
  it("writes a task-linked mailbox message when a plan needs approval", async () => {
    const store = createStore({
      ntfyEnabled: true,
      ntfyTopic: "topic",
      ntfyDashboardHost: "https://dash.example",
    });
    const sendMessageOnce = vi.fn(async (input: any, _key: string) => ({
      message: { ...input, id: "msg-once-x", read: false, createdAt: "", updatedAt: "" },
      inserted: true,
    }));
    const messageStore = Object.assign(new EventEmitter(), { sendMessageOnce });

    const service = new NotificationService(store as any, {
      projectId: "p1",
      messageStore: messageStore as any,
    });
    await service.start();

    store.emit("task:updated", task({ status: "awaiting-approval" }));
    await Promise.resolve();

    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    const [input, key] = sendMessageOnce.mock.calls[0];
    expect(key).toBe("plan-approval:FN-1");
    expect(input.type).toBe("system");
    expect(input.toId).toBe("dashboard");
    expect(input.toType).toBe("user");
    expect(input.metadata).toMatchObject({ taskId: "FN-1", awaitingApprovalReason: "manual" });
    // Deep link to the task is present in the message body.
    expect(input.content).toContain("https://dash.example/?project=p1&task=FN-1");
  });

  it("writes one mailbox message when a triage duplicate needs an operator decision", async () => {
    const store = createStore({ ntfyEnabled: false });
    const idempotencyKeys = new Set<string>();
    let insertedCount = 0;
    const sendMessageOnce = vi.fn(async (input: any, key: string) => {
      const inserted = !idempotencyKeys.has(key);
      idempotencyKeys.add(key);
      if (inserted) insertedCount += 1;
      return { message: { ...input, id: "msg-once-duplicate", read: false, createdAt: "", updatedAt: "" }, inserted };
    });
    const messageStore = Object.assign(new EventEmitter(), { sendMessageOnce });
    const service = new NotificationService(store as any, { projectId: "p1", messageStore: messageStore as any });
    await service.start();

    const duplicate = task({
      paused: true,
      pausedReason: "duplicate-decision-required",
      sourceMetadata: { duplicateSource: "triage-marker", nearDuplicateOf: "FN-7961" },
    });
    store.emit("task:updated", duplicate);
    store.emit("task:updated", duplicate);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    expect(insertedCount).toBe(1);

    for (const [input, key] of sendMessageOnce.mock.calls) {
      expect(key).toBe("triage-duplicate-decision:FN-1");
      expect(input).toMatchObject({
        type: "system",
        toId: "dashboard",
        toType: "user",
        metadata: { taskId: "FN-1", canonicalTaskId: "FN-7961", kind: "triage-duplicate-decision" },
      });
      expect(input.content).toContain("flagged as a duplicate of FN-7961");
    }
  });

  it("labels the replan-cap escalation reason in the approval mailbox message", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const sendMessageOnce = vi.fn(async (input: any, _key: string) => ({
      message: { ...input, id: "msg-once-y", read: false, createdAt: "", updatedAt: "" },
      inserted: true,
    }));
    const messageStore = Object.assign(new EventEmitter(), { sendMessageOnce });

    const service = new NotificationService(store as any, { messageStore: messageStore as any });
    await service.start();

    store.emit(
      "task:updated",
      task({ status: "awaiting-approval", awaitingApprovalReason: "plan-review-replan-cap" }),
    );
    await Promise.resolve();

    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    const [input] = sendMessageOnce.mock.calls[0];
    expect(input.metadata).toMatchObject({ awaitingApprovalReason: "plan-review-replan-cap" });
    expect(input.content).toContain("Plan Review exhausted");
    // No dashboard host configured -> no absolute link line, but the message still sends.
    expect(input.content).not.toContain("http");
  });

  it("does not throw when the message store has no write side", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const messageStore = new EventEmitter(); // no sendMessageOnce
    const service = new NotificationService(store as any, { messageStore: messageStore as any });
    await service.start();

    expect(() => store.emit("task:updated", task({ status: "awaiting-approval" }))).not.toThrow();
  });

  /*
  FNXC:PlanApprovalMailbox 2026-07-16-19:40:
  The durable mailbox message is an in-app channel decoupled from the push-enabled gate: a
  dashboard-only operator with NO ntfy topic and NO webhook (notifications disabled) must still
  get the awaiting-approval record. Regression guard for the FIX A decoupling.
  */
  it("writes the approval mailbox message even when push notifications are disabled", async () => {
    const store = createStore({ ntfyEnabled: false }); // no ntfy, no webhook -> notifications disabled
    const sendMessageOnce = vi.fn(async (input: any, _key: string) => ({
      message: { ...input, id: "msg-once-disabled", read: false, createdAt: "", updatedAt: "" },
      inserted: true,
    }));
    const messageStore = Object.assign(new EventEmitter(), { sendMessageOnce });

    const service = new NotificationService(store as any, { messageStore: messageStore as any });
    await service.start();

    store.emit("task:updated", task({ status: "awaiting-approval" }));
    await Promise.resolve();

    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    const [input, key] = sendMessageOnce.mock.calls[0];
    expect(key).toBe("plan-approval:FN-1");
    expect(input.type).toBe("system");
  });

  it("swallows a sendMessageOnce rejection and logs it without throwing", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const sendMessageOnce = vi.fn(async () => {
      throw new Error("mailbox boom");
    });
    const messageStore = Object.assign(new EventEmitter(), { sendMessageOnce });

    const service = new NotificationService(store as any, { messageStore: messageStore as any });
    await service.start();

    expect(() => store.emit("task:updated", task({ status: "awaiting-approval" }))).not.toThrow();
    // Allow the fire-and-forget mailbox write (and its catch) to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(schedulerLog.log).toHaveBeenCalledWith(
      expect.stringContaining("awaiting-approval mailbox message failed: mailbox boom"),
    );
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

  it("dispatches workflow notify node events through the ntfy provider when enabled", async () => {
    const fetchMock = mockNtfyFetch();
    const sendSpy = vi.spyOn(NtfyNotificationProvider.prototype, "sendNotification");
    const store = createStore({
      ntfyEnabled: true,
      ntfyTopic: "workflow-topic",
      ntfyEvents: ["workflow-notify"] as any,
    });
    const service = new NotificationService(store as any, { ntfyBaseUrl: "https://ntfy.example" });
    await service.start();

    await service.dispatch("workflow-notify", {
      taskId: "FN-306",
      taskTitle: "Workflow task",
      event: "workflow-notify",
      metadata: { title: "Workflow ping", message: "Workflow node emitted a notification" },
    });

    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledWith("workflow-notify", expect.objectContaining({ taskId: "FN-306" }));
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.example/workflow-topic",
        expect.objectContaining({
          method: "POST",
          body: "Workflow node emitted a notification",
          headers: expect.objectContaining({ Title: "Workflow ping" }),
        }),
      );
    });
    sendSpy.mockRestore();
    fetchMock.mockRestore();
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

  describe("terminal merged notifications", () => {
    it("dispatches task:moved to done for PR-merged tasks to ntfy and webhook providers", async () => {
      const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
      const ntfySend = vi.fn(async () => ({ success: true, providerId: "mock-ntfy" }));
      const webhookSend = vi.fn(async () => ({ success: true, providerId: "mock-webhook" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock-ntfy", isEventSupported: (event) => event === "merged", sendNotification: ntfySend });
      service.registerProvider({ getProviderId: () => "mock-webhook", isEventSupported: (event) => event === "merged", sendNotification: webhookSend });
      await service.start();

      store.emit("task:moved", {
        task: task({ id: "FN-301", column: "done", prInfo: { status: "merged", number: 12 } as any }),
        from: "in-review",
        to: "done",
      });

      await vi.waitFor(() => {
        expect(ntfySend).toHaveBeenCalledWith("merged", expect.objectContaining({ taskId: "FN-301", event: "merged" }));
        expect(webhookSend).toHaveBeenCalledWith("merged", expect.objectContaining({ taskId: "FN-301", event: "merged" }));
      });
    });

    it.each([
      ["mergeConfirmed", { mergeConfirmed: true }],
      ["noOpMerge", { noOpMerge: true }],
      ["mergedAt", { mergedAt: "2026-06-08T00:00:00.000Z" }],
    ])("dispatches task:moved to done for merge-backed tasks with %s metadata", async (_name, mergeDetails) => {
      const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      store.emit("task:moved", {
        task: task({ id: `FN-${Object.keys(mergeDetails).join("")}`, column: "done", mergeDetails: mergeDetails as any }),
        from: "in-review",
        to: "done",
      });

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith(
          "merged",
          expect.objectContaining({ event: "merged" }),
        );
      });
    });

    it("does not dispatch task:moved to done for non-merge-backed tasks", async () => {
      const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      store.emit("task:moved", { task: task({ id: "FN-302", column: "done" }), from: "in-review", to: "done" });
      await Promise.resolve();

      expect(sendNotification).not.toHaveBeenCalledWith("merged", expect.anything());
    });

    it("deduplicates task:moved to done plus task:merged for the same merge-backed task", async () => {
      const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      const mergedTask = task({ id: "FN-303", column: "done", mergeDetails: { mergeConfirmed: true } as any });
      store.emit("task:moved", { task: mergedTask, from: "in-review", to: "done" });
      store.emit("task:merged", {
        task: mergedTask,
        branch: "fusion/fn-303",
        merged: true,
        worktreeRemoved: false,
        branchDeleted: false,
      });

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(1);
      });
      expect(sendNotification).toHaveBeenCalledWith("merged", expect.objectContaining({ taskId: "FN-303", event: "merged" }));
    });

    it("dispatches the full merge-backed done plus task:merged sequence through the ntfy provider once", async () => {
      const fetchMock = mockNtfyFetch();
      const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic", ntfyEvents: [] as any });
      const service = new NotificationService(store as any, { ntfyBaseUrl: "https://ntfy.example" });
      await service.start();

      const mergedTask = task({ id: "FN-305", column: "done", mergeDetails: { mergeConfirmed: true } as any });
      store.emit("task:moved", { task: mergedTask, from: "in-review", to: "done" });
      store.emit("task:merged", {
        task: mergedTask,
        branch: "fusion/fn-305",
        merged: true,
        worktreeRemoved: false,
        branchDeleted: false,
      });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.example/topic",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("has been merged to main"),
        }),
      );
      fetchMock.mockRestore();
    });

    it("honors provider event filtering for task:moved to done terminal notifications", async () => {
      const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: (event) => event !== "merged", sendNotification });
      await service.start();

      store.emit("task:moved", {
        task: task({ id: "FN-304", column: "done", mergeDetails: { mergeConfirmed: true } as any }),
        from: "in-review",
        to: "done",
      });
      await Promise.resolve();

      expect(sendNotification).not.toHaveBeenCalled();
    });
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

    it("refreshes stale disabled settings before merge-backed done move notifications", async () => {
      const store = createStaleLifecycleStore();
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      store.emit("task:moved", {
        task: task({ id: "FN-104", column: "done", prInfo: { status: "merged", number: 104 } as any }),
        from: "in-review",
        to: "done",
      });

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith(
          "merged",
          expect.objectContaining({ taskId: "FN-104", event: "merged" }),
        );
      });
      expect(schedulerLog.log).toHaveBeenCalledWith(
        expect.stringContaining("NotificationService refreshed notification state reason=task:moved:done enabled=true"),
      );
    });

    it("refreshes stale disabled settings before in-review move notifications through ntfy", async () => {
      const fetchMock = mockNtfyFetch();
      const store = createStaleLifecycleStore();
      const service = new NotificationService(store as any, { ntfyBaseUrl: "https://ntfy.example" });
      await service.start();

      store.emit("task:moved", { task: task({ id: "FN-108" }), from: "in-progress", to: "in-review" });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "https://ntfy.example/fusion-test",
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining("ready for review"),
          }),
        );
      });
      fetchMock.mockRestore();
    });

    it("does not notify for non-in-review/non-terminal moves even after stale-settings refresh", async () => {
      const store = createStaleLifecycleStore();
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const service = new NotificationService(store as any);
      service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
      await service.start();

      store.emit("task:moved", { task: task({ id: "FN-106" }), from: "todo", to: "in-progress" });
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

    it("registers and initializes ntfy after a late settings:updated enable before task:merged", async () => {
      const fetchMock = mockNtfyFetch();
      const store = createStore({ ntfyEnabled: false, ntfyTopic: "" });
      const service = new NotificationService(store as any, { ntfyBaseUrl: "https://ntfy.example" });
      await service.start();

      store.emit("settings:updated", {
        settings: {
          ntfyEnabled: true,
          ntfyTopic: "fusion-test",
          ntfyEvents: [] as any,
          ntfyDashboardHost: "http://localhost:4040",
        } as Settings,
        previous: {
          ntfyEnabled: false,
          ntfyTopic: "",
        } as Settings,
      });
      store.emit("task:merged", {
        task: task({ id: "FN-107" }),
        branch: "fusion/fn-107",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "https://ntfy.example/fusion-test",
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining("has been merged to main"),
          }),
        );
      });
      fetchMock.mockRestore();
    });

    it("refreshes stale disabled settings for workflow notify dispatch", async () => {
      const fetchMock = mockNtfyFetch();
      let getSettingsCallCount = 0;
      const store = createStore({ ntfyEnabled: false, ntfyTopic: "" });
      store.getSettings.mockImplementation(async () => {
        getSettingsCallCount += 1;
        if (getSettingsCallCount === 1) {
          return { ntfyEnabled: false, ntfyTopic: "" } as Settings;
        }
        return {
          ntfyEnabled: true,
          ntfyTopic: "workflow-refresh",
          ntfyEvents: ["workflow-notify"] as any,
        } as Settings;
      });
      const service = new NotificationService(store as any, { ntfyBaseUrl: "https://ntfy.example" });
      await service.start();

      await service.dispatch("workflow-notify", {
        taskId: "FN-109",
        taskTitle: "Workflow refresh",
        event: "workflow-notify",
        metadata: { title: "Workflow refresh", message: "settings refreshed before workflow notify" },
      });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "https://ntfy.example/workflow-refresh",
          expect.objectContaining({
            method: "POST",
            body: "settings refreshed before workflow notify",
          }),
        );
      });
      fetchMock.mockRestore();
    });
  });

  it("does not claim a wedge episode for a transient failed merge", async () => {
    const store = createStore({ ntfyEnabled: true, ntfyTopic: "topic" });
    const claimTaskWedgeNotificationEpisode = vi.fn();
    (store as any).claimTaskWedgeNotificationEpisode = claimTaskWedgeNotificationEpisode;
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const service = new NotificationService(store as any);
    service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
    await service.start();

    const failed = task({ id: "FN-5627", status: "failed", column: "in-review", error: "spawn git ENOENT" });
    store.setTask(failed);
    store.emit("task:updated", failed);
    await Promise.resolve();
    await Promise.resolve();

    expect(claimTaskWedgeNotificationEpisode).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalledWith("task-wedged", expect.anything());
    await service.stop();
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
