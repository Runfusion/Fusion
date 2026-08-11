import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

const { completePendingWedgeNotificationMock, getActiveNotificationServiceMock, recordRunAuditEventMock } = vi.hoisted(() => ({
  completePendingWedgeNotificationMock: vi.fn(),
  getActiveNotificationServiceMock: vi.fn(),
  recordRunAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("../util/notifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/notifier.js")>();
  return { ...actual, getActiveNotificationService: getActiveNotificationServiceMock };
});
vi.mock("../util/run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/run-audit.js")>();
  return { ...actual, createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock })) };
});

import { SelfHealingManager } from "../self-healing.js";
import { NotificationService } from "../notification/notification-service.js";

function pendingTask(id: string, since: string): Task {
  return {
    id, title: id, description: "", column: "in-review", status: "failed", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: since, updatedAt: since,
    wedgeNotification: { reasonKey: "terminal-failed", episodeId: "", status: "resolved", transitionedAt: since, pending: { since, reasonKey: "terminal-failed", source: "auto", reason: "terminal", action: "repair" } },
  } as Task;
}

/*
FNXC:TaskWedgeNotifications 2026-08-11-18:57:
The restart sweep is only a bounded durable-marker driver. It records the NotificationService's
verbatim outcome rather than reconstructing a descriptor or guessing recovery from a slim row.
*/
describe("reconcile pending wedge notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveNotificationServiceMock.mockReturnValue({ getWedgeNotificationSettleMs: () => 1_000, completePendingWedgeNotification: completePendingWedgeNotificationMock });
  });

  it("selects elapsed markers and audits the completion outcome verbatim", async () => {
    const old = new Date(Date.now() - 1_001).toISOString();
    const young = new Date(Date.now() - 999).toISOString();
    const store = Object.assign(new EventEmitter(), {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
      listTasks: vi.fn(async () => [pendingTask("FN-WEDGE-OLD", old), pendingTask("FN-WEDGE-YOUNG", young)]),
    }) as unknown as TaskStore;
    completePendingWedgeNotificationMock.mockResolvedValue({ outcome: "rearmed" });
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await expect(manager.reconcilePendingWedgeNotifications()).resolves.toBe(1);
    expect(completePendingWedgeNotificationMock).toHaveBeenCalledWith("FN-WEDGE-OLD");
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:reconcile-pending-wedge-notification",
      metadata: expect.objectContaining({ taskId: "FN-WEDGE-OLD", reasonKey: "terminal-failed", outcome: "rearmed" }),
    }));
  });

  it("delivers a durable marker through a fresh service after a simulated restart", async () => {
    const since = new Date(Date.now() - 1_001).toISOString();
    let task = { ...pendingTask("FN-WEDGE-RESTART", since), error: "boom" };
    const dispatch = vi.fn(async () => ({ success: true, providerId: "test" }));
    const sendMessageOnce = vi.fn(async () => ({ message: {} as any, inserted: true }));
    const store = Object.assign(new EventEmitter(), {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ntfyEnabled: true, ntfyTopic: "test", wedgeNotificationSettleMs: 1_000 } as Settings)),
      getTask: vi.fn(async () => task),
      listTasks: vi.fn(async () => [task]),
      claimTaskWedgeNotificationEpisode: vi.fn(async (taskId: string, reasonKey: string | null) => {
        if (reasonKey === null) return { claimed: false };
        task = { ...task, wedgeNotification: { reasonKey, episodeId: `${taskId}:${reasonKey}`, status: "active", transitionedAt: new Date().toISOString() } };
        return { claimed: true, episodeId: `${taskId}:${reasonKey}` };
      }),
      clearTaskWedgeNotificationPending: vi.fn(async () => {
        const { pending: _pending, ...wedge } = task.wedgeNotification!;
        task = { ...task, wedgeNotification: wedge };
        return true;
      }),
      on: vi.fn(), off: vi.fn(),
    }) as unknown as TaskStore;
    const service = new NotificationService(store as any, { messageStore: { on: () => undefined, sendMessageOnce } as any, wedgeNotificationSettleMs: 1_000 });
    service.registerProvider({ getProviderId: () => "test", isEventSupported: () => true, sendNotification: dispatch });
    await service.start();
    getActiveNotificationServiceMock.mockReturnValue(service);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await expect(manager.reconcilePendingWedgeNotifications()).resolves.toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(task.wedgeNotification?.pending).toBeUndefined();
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ outcome: "delivered" }) }));
    await service.stop();
  });

  it("re-stamps an ancient durable hold then delivers it on the following maintenance tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    const since = new Date(Date.now() - 5_000).toISOString();
    let task = { ...pendingTask("FN-WEDGE-STALE", since), error: "boom" };
    const dispatch = vi.fn(async () => ({ success: true, providerId: "test" }));
    const store = Object.assign(new EventEmitter(), {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ntfyEnabled: true, ntfyTopic: "test", wedgeNotificationSettleMs: 1_000, maintenanceIntervalMs: 1_000 } as Settings)),
      getTask: vi.fn(async () => task), listTasks: vi.fn(async () => [task]), on: vi.fn(), off: vi.fn(),
      markTaskWedgeNotificationPending: vi.fn(async (_id: string, descriptor: any) => {
        const restamped = new Date().toISOString();
        task = { ...task, wedgeNotification: { ...task.wedgeNotification!, pending: { since: restamped, ...descriptor } } };
        return { since: restamped, armed: true, restamped: true };
      }),
      clearTaskWedgeNotificationPending: vi.fn(async () => {
        const { pending: _pending, ...wedge } = task.wedgeNotification!;
        task = { ...task, wedgeNotification: wedge };
        return true;
      }),
      claimTaskWedgeNotificationEpisode: vi.fn(async (taskId: string, reasonKey: string | null) => {
        if (reasonKey === null) return { claimed: false };
        task = { ...task, wedgeNotification: { reasonKey, episodeId: `${taskId}:${reasonKey}`, status: "active", transitionedAt: new Date().toISOString() } };
        return { claimed: true, episodeId: `${taskId}:${reasonKey}` };
      }),
    }) as unknown as TaskStore;
    const service = new NotificationService(store as any, { wedgeNotificationSettleMs: 1_000 });
    service.registerProvider({ getProviderId: () => "test", isEventSupported: () => true, sendNotification: dispatch });
    await service.start();
    getActiveNotificationServiceMock.mockReturnValue(service);
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await manager.reconcilePendingWedgeNotifications();
    expect(dispatch).not.toHaveBeenCalled();
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ outcome: "rearmed" }) }));
    await vi.advanceTimersByTimeAsync(1_001);
    await manager.reconcilePendingWedgeNotifications();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ outcome: "delivered" }) }));
    await service.stop();
    vi.useRealTimers();
  });

  it("leaves a marker untouched when no notification service is active", async () => {
    getActiveNotificationServiceMock.mockReturnValue(undefined);
    const since = new Date(Date.now() - 300_001).toISOString();
    const store = Object.assign(new EventEmitter(), {
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
      listTasks: vi.fn(async () => [pendingTask("FN-WEDGE-DEFERRED", since)]),
    }) as unknown as TaskStore;
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    await expect(manager.reconcilePendingWedgeNotifications()).resolves.toBe(1);
    expect(completePendingWedgeNotificationMock).not.toHaveBeenCalled();
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ outcome: "deferred" }) }));
  });
});
