import { describe, expect, it, vi } from "vitest";
import type { NotificationProvider, Settings, Task } from "@fusion/core";
import { NotificationService } from "../notification/notification-service.js";
import { NtfyNotificationProvider } from "../notification/ntfy-provider.js";

type Listener = (...args: any[]) => void | Promise<void>;

function createStore(settings: Partial<Settings> = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const getBucket = (event: string) => listeners.get(event) ?? new Set<Listener>();

  return {
    getSettings: vi.fn(async () => ({ ntfyEnabled: false, ...settings }) as Settings),
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

  it("deduplicates same task+event but not different event types", async () => {
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
    store.emit("task:moved", { task: task(), from: "todo", to: "in-review" });
    store.emit("task:updated", task({ status: "failed" }));
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
      expect.objectContaining({ topic: "demo", projectId: "p1", ntfyBaseUrl: "https://n" }),
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
});
