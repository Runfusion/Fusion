import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationProvider, Settings, Task } from "@fusion/core";
import { NotificationService } from "../notification-service.js";
import { schedulerLog } from "../../logger.js";

vi.mock("../../logger.js", () => ({
  schedulerLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Listener = (...args: any[]) => void | Promise<void>;

function createStore(settings: Partial<Settings> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const tasks = new Map<string, Task>();
  let currentSettings: Settings = {
    ntfyEnabled: true,
    ntfyTopic: "topic",
    ...settings,
  } as Settings;

  const getBucket = (event: string) => listeners.get(event) ?? new Set<Listener>();

  return {
    on(event: string, listener: Listener) {
      const bucket = getBucket(event);
      bucket.add(listener);
      listeners.set(event, bucket);
    },
    off(event: string, listener: Listener) {
      getBucket(event).delete(listener);
    },
    emit(event: string, payload: unknown) {
      for (const listener of getBucket(event)) {
        void listener(payload);
      }
    },
    getSettings: vi.fn(async () => currentSettings),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    setTask(task: Task) {
      tasks.set(task.id, task);
    },
    setSettings(next: Partial<Settings>) {
      currentSettings = { ...currentSettings, ...next } as Settings;
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

describe("NotificationService deferred failure notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function setup(settings: Partial<Settings> = {}) {
    const store = createStore(settings);
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    const provider: NotificationProvider = {
      getProviderId: () => "mock",
      isEventSupported: () => true,
      sendNotification,
    };
    const service = new NotificationService(store as any, { failedNotificationGraceMs: 100 });
    service.registerProvider(provider);
    await service.start();
    return { store, service, sendNotification };
  }

  it("Failure that persists past grace dispatches exactly once", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({ id: "FN-1", status: "failed" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    await vi.advanceTimersByTimeAsync(100);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("failed", expect.objectContaining({ taskId: "FN-1" }));
    await service.stop();
  });

  it("Transient failure with Auto-recovered status clear is suppressed", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({ id: "FN-1", status: "failed" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    store.setTask(task({ id: "FN-1", status: "in-review", log: [{ timestamp: new Date().toISOString(), action: "Auto-recovered: merge deadlock resolved" }] }));
    store.emit("task:updated", task({ id: "FN-1", status: "in-review" }));
    await vi.advanceTimersByTimeAsync(100);

    expect(sendNotification).not.toHaveBeenCalledWith("failed", expect.anything());
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    expect(schedulerLog.log).toHaveBeenCalledWith(expect.stringContaining("suppressed transient failed"));
    await service.stop();
  });

  it("Recovery via task:moved to done suppresses failed notification", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({ id: "FN-1", status: "failed", column: "in-review" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed", column: "in-review" }));

    store.setTask(task({ id: "FN-1", status: undefined, column: "done" }));
    store.emit("task:moved", { task: task({ id: "FN-1", status: undefined, column: "done" }), from: "in-review", to: "done" });
    await vi.advanceTimersByTimeAsync(100);

    expect(sendNotification).not.toHaveBeenCalledWith("failed", expect.anything());
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    await service.stop();
  });

  it("terminal-only suppresses non-terminal failures after grace", async () => {
    const { store, service, sendNotification } = await setup({
      failureNotificationMode: "terminal-only",
      failureNotificationDelayMs: 50,
    });
    store.setTask(task({ id: "FN-1", status: "failed", paused: false, column: "in-progress" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed", paused: false, column: "in-progress" }));

    await vi.advanceTimersByTimeAsync(50);

    expect(sendNotification).not.toHaveBeenCalledWith("failed", expect.anything());
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    expect(schedulerLog.log).toHaveBeenCalledWith("[notify] FN-1 non-terminal failure — suppressed (mode=terminal-only)");
    await service.stop();
  });

  it("terminal-only dispatches when failed task is paused", async () => {
    const { store, service, sendNotification } = await setup({
      failureNotificationMode: "terminal-only",
      failureNotificationDelayMs: 50,
    });
    store.setTask(task({ id: "FN-1", status: "failed", paused: true, column: "in-progress" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed", paused: false, column: "in-progress" }));

    await vi.advanceTimersByTimeAsync(50);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("failed", expect.objectContaining({ taskId: "FN-1" }));
    await service.stop();
  });

  it("terminal-only dispatches when failed task is in-review", async () => {
    const { store, service, sendNotification } = await setup({
      failureNotificationMode: "terminal-only",
      failureNotificationDelayMs: 50,
    });
    store.setTask(task({ id: "FN-1", status: "failed", paused: false, column: "in-review" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed", paused: false, column: "todo" }));

    await vi.advanceTimersByTimeAsync(50);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("failed", expect.objectContaining({ taskId: "FN-1" }));
    await service.stop();
  });

  it("terminal-only still uses recovery suppression when task self-recovers before grace", async () => {
    const { store, service, sendNotification } = await setup({
      failureNotificationMode: "terminal-only",
      failureNotificationDelayMs: 50,
    });
    store.setTask(task({ id: "FN-1", status: "failed", paused: false, column: "in-progress" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed", paused: false, column: "in-progress" }));

    store.setTask(task({ id: "FN-1", status: undefined, column: "done" }));
    store.emit("task:moved", { task: task({ id: "FN-1", status: undefined, column: "done" }), from: "in-progress", to: "done" });
    await vi.advanceTimersByTimeAsync(50);

    expect(sendNotification).not.toHaveBeenCalledWith("failed", expect.anything());
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    await service.stop();
  });

  it("sticky-only still notifies persistent failed tasks", async () => {
    const { store, service, sendNotification } = await setup({
      failureNotificationMode: "sticky-only",
      failureNotificationDelayMs: 50,
    });
    store.setTask(task({ id: "FN-1", status: "failed", paused: false, column: "in-progress" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed", paused: false, column: "in-progress" }));

    await vi.advanceTimersByTimeAsync(50);

    expect(sendNotification).toHaveBeenCalledWith("failed", expect.objectContaining({ taskId: "FN-1" }));
    await service.stop();
  });

  it("terminal-only with delay 0 still uses deferred path and suppresses non-terminal", async () => {
    const { store, service, sendNotification } = await setup({
      failureNotificationMode: "terminal-only",
      failureNotificationDelayMs: 0,
    });
    store.setTask(task({ id: "FN-1", status: "failed", paused: false, column: "in-progress" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed", paused: false, column: "in-progress" }));

    expect(sendNotification).not.toHaveBeenCalled();
    expect(service.getPendingFailureCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendNotification).not.toHaveBeenCalledWith("failed", expect.anything());
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    await service.stop();
  });

  it("stop clears pending timers without firing", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({ id: "FN-1", status: "failed" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    await service.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(sendNotification).not.toHaveBeenCalled();
  });
});
