import { describe, expect, it, vi } from "vitest";
import { NotificationDispatcher } from "../notification/dispatcher.js";
import type { NotificationProvider } from "../notification/provider.js";
import { DEFAULT_GLOBAL_SETTINGS } from "../settings-schema.js";
import type { NtfyNotificationEvent, NotificationPayload } from "../types.js";

function createProvider(overrides: Partial<NotificationProvider> = {}): NotificationProvider {
  const providerId = overrides.getProviderId?.() ?? "provider-default";

  return {
    getProviderId: () => providerId,
    isEventSupported: () => true,
    sendNotification: async () => ({ success: true, providerId }),
    ...overrides,
  };
}

describe("NotificationDispatcher", () => {
  it("dispatches notifications to multiple providers and returns all results", async () => {
    const first = createProvider({
      getProviderId: () => "provider-1",
      sendNotification: vi.fn(async () => ({ success: true, providerId: "provider-1" })),
    });
    const second = createProvider({
      getProviderId: () => "provider-2",
      sendNotification: vi.fn(async () => ({ success: true, providerId: "provider-2" })),
    });

    const dispatcher = new NotificationDispatcher();
    dispatcher.registerProvider(first);
    dispatcher.registerProvider(second);

    const payload: NotificationPayload = { taskId: "FN-1", event: "in-review" };
    const results = await dispatcher.dispatch("in-review", payload);

    expect(first.sendNotification).toHaveBeenCalledWith("in-review", payload);
    expect(second.sendNotification).toHaveBeenCalledWith("in-review", payload);
    expect(results).toEqual([
      { success: true, providerId: "provider-1" },
      { success: true, providerId: "provider-2" },
    ]);
  });

  it("isolates provider failures so one exception does not block other providers", async () => {
    const healthy = createProvider({
      getProviderId: () => "healthy",
      sendNotification: vi.fn(async () => ({ success: true, providerId: "healthy" })),
    });
    const broken = createProvider({
      getProviderId: () => "broken",
      sendNotification: vi.fn(async () => {
        throw new Error("provider exploded");
      }),
    });

    const dispatcher = new NotificationDispatcher();
    dispatcher.registerProvider(broken);
    dispatcher.registerProvider(healthy);

    const results = await dispatcher.dispatch("failed", {
      taskId: "FN-2",
      event: "failed",
    });

    expect(healthy.sendNotification).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { success: false, providerId: "broken", error: "provider exploded" },
      { success: true, providerId: "healthy" },
    ]);
  });

  it("supports unregistering providers", async () => {
    const removable = createProvider({
      getProviderId: () => "removable",
      sendNotification: vi.fn(async () => ({ success: true, providerId: "removable" })),
    });

    const dispatcher = new NotificationDispatcher();
    dispatcher.registerProvider(removable);
    dispatcher.unregisterProvider("removable");

    const results = await dispatcher.dispatch("merged", {
      taskId: "FN-3",
      event: "merged",
    });

    expect(removable.sendNotification).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("filters providers by isEventSupported", async () => {
    const supported = createProvider({
      getProviderId: () => "supported",
      sendNotification: vi.fn(async () => ({ success: true, providerId: "supported" })),
      isEventSupported: () => true,
    });
    const skipped = createProvider({
      getProviderId: () => "skipped",
      sendNotification: vi.fn(async () => ({ success: true, providerId: "skipped" })),
      isEventSupported: () => false,
    });

    const dispatcher = new NotificationDispatcher();
    dispatcher.registerProvider(supported);
    dispatcher.registerProvider(skipped);

    const results = await dispatcher.dispatch("awaiting-user-review", {
      taskId: "FN-4",
      event: "awaiting-user-review",
    });

    expect(supported.sendNotification).toHaveBeenCalledTimes(1);
    expect(skipped.sendNotification).not.toHaveBeenCalled();
    expect(results).toEqual([{ success: true, providerId: "supported" }]);
  });

  it("calls initialize and shutdown hooks only when defined", async () => {
    const initialize = vi.fn(async () => {});
    const shutdown = vi.fn(async () => {});
    const lifecycle = createProvider({
      getProviderId: () => "lifecycle",
      initialize,
      shutdown,
    });
    const noLifecycle = createProvider({
      getProviderId: () => "no-lifecycle",
    });

    const dispatcher = new NotificationDispatcher({ maxRetries: 2, retryDelayMs: 10 });
    dispatcher.registerProvider(lifecycle);
    dispatcher.registerProvider(noLifecycle);

    await dispatcher.initializeAll();
    await dispatcher.shutdownAll();

    expect(initialize).toHaveBeenCalledWith({ maxRetries: 2, retryDelayMs: 10 });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("keeps ntfy defaults unchanged and adds notificationProviders default", () => {
    const event: NtfyNotificationEvent = "in-review";
    expect(event).toBe("in-review");

    expect(DEFAULT_GLOBAL_SETTINGS.ntfyEnabled).toBe(false);
    expect(DEFAULT_GLOBAL_SETTINGS.ntfyTopic).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.ntfyBaseUrl).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.ntfyDashboardHost).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.ntfyEvents).toEqual([
      "in-review",
      "merged",
      "failed",
      "awaiting-approval",
      "awaiting-user-review",
      "planning-awaiting-input",
      "gridlock",
    ]);
    expect(DEFAULT_GLOBAL_SETTINGS.notificationProviders).toEqual([]);
  });
});
