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
    failureNotificationDelayMs: 30000,
    failureNotificationMode: "sticky-only",
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
    settings() {
      return currentSettings;
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
    const service = new NotificationService(store as any);
    service.registerProvider(provider);
    await service.start();
    return { store, service, sendNotification };
  }

  it("Persistent failure dispatches once after delay", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({ id: "FN-1", status: "failed" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    await vi.advanceTimersByTimeAsync(30000);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({ taskId: "FN-1" }),
    );
    await service.stop();
  });

  it("Self-recovery suppresses notification (status cleared)", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({ id: "FN-1", status: "failed" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));
    await vi.advanceTimersByTimeAsync(5000);

    store.setTask(task({ id: "FN-1", status: "in-review" }));
    store.emit("task:updated", task({ id: "FN-1", status: "in-review" }));
    await vi.advanceTimersByTimeAsync(30000);

    expect(sendNotification).not.toHaveBeenCalled();
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    expect(schedulerLog.log).toHaveBeenCalledWith(expect.stringContaining("suppressed notification"));
    await service.stop();
  });

  it("Self-recovery via column move suppresses", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({ id: "FN-1", status: "failed" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));
    store.emit("task:moved", { task: task({ id: "FN-1" }), from: "in-progress", to: "in-review" });

    await vi.advanceTimersByTimeAsync(30000);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      "in-review",
      expect.objectContaining({ event: "in-review" }),
    );
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    await service.stop();
  });

  it('failureNotificationMode: "all" dispatches immediately', async () => {
    const { store, service, sendNotification } = await setup({ failureNotificationMode: "all" });
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    expect(sendNotification).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("failureNotificationDelayMs: 0 dispatches immediately", async () => {
    const { store, service, sendNotification } = await setup({ failureNotificationDelayMs: 0 });
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    expect(sendNotification).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("Coalescing: two rapid failed events keep one pending timer and one dispatch", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({ id: "FN-1", status: "failed" }));

    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    expect(service.getPendingFailureCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(30000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("Fresh re-read at fire time", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({ id: "FN-1", status: "failed", title: "Old" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed", title: "Old" }));

    store.setTask(task({ id: "FN-1", status: "failed", title: "New Title" }));
    await vi.advanceTimersByTimeAsync(30000);

    expect(sendNotification).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({ taskTitle: "New Title" }),
    );
    await service.stop();
  });

  it("Setting change refreshes cached knobs", async () => {
    const { store, service, sendNotification } = await setup();
    const nextSettings = { ...store.settings(), failureNotificationMode: "all" as const };

    store.emit("settings:updated", { settings: nextSettings, previous: store.settings() });
    store.setSettings({ failureNotificationMode: "all" });
    await Promise.resolve();

    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    expect(sendNotification).toHaveBeenCalledTimes(1);
    await service.stop();
  });
});
