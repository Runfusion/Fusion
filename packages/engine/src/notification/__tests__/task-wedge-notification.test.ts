import { describe, expect, it, vi } from "vitest";
import { TaskNotFoundError, WEDGE_RENOTIFY_COOLDOWN_MS, type NotificationProvider, type Settings, type Task } from "@fusion/core";
import { NotificationService } from "../notification-service.js";
import { MAX_AUTO_MERGE_TRANSIENT_RETRIES } from "../../errors/transient-merge-error-classifier.js";
import { describeSelfHealingNoActionWedge, describeTaskRecoveryOwner, describeTaskWedge, isTaskProgressing } from "../task-wedge-notification.js";

type Listener = (task: Task) => void;

/*
FNXC:WorkflowResolvedColumns 2026-07-31-21:35:
A board whose lanes carry no legacy id: hold `drafting`, wip `building`, review `checking`,
complete `shipped`. Supplied through `listWorkflowDefinitions`, the only store read
`resolveProjectColumnsForRoles` makes and one that is answerable under PostgreSQL.
*/
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "drafting", name: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

function fixture(workflowIr?: unknown, settleMs = 0, maintenanceIntervalMs?: number) {
  const listeners = new Set<Listener>();
  const movedListeners = new Set<(data: { task: Task; from: string; to: string }) => void>();
  let wedge: Task["wedgeNotification"];
  let liveTask: Task | undefined;
  let liveReadError: Error | undefined;
  const claimTaskWedgeNotificationEpisode = vi.fn(async (taskId: string, reasonKey: string | null) => {
    if (reasonKey === null) {
      if (wedge?.status === "active") wedge = { ...wedge, status: "resolved" };
      return { claimed: false };
    }
    if (wedge?.status === "active" && wedge.reasonKey === reasonKey) return { claimed: false };
    wedge = { reasonKey, episodeId: `${taskId}-${reasonKey}-${Date.now()}`, status: "active", transitionedAt: new Date().toISOString() };
    return { claimed: true, episodeId: wedge.episodeId };
  });
  const store = {
    getSettings: async () => ({ ntfyEnabled: true, ntfyTopic: "test", ...(maintenanceIntervalMs === undefined ? {} : { maintenanceIntervalMs }) }) as Settings,
    getTask: async () => {
      if (liveReadError) throw liveReadError;
      return liveTask;
    },
    on: (event: string, listener: Listener | ((data: { task: Task; from: string; to: string }) => void)) => {
      if (event === "task:updated") listeners.add(listener as Listener);
      if (event === "task:moved") movedListeners.add(listener as (data: { task: Task; from: string; to: string }) => void);
    },
    off: () => undefined,
    emit: (task: Task) => listeners.forEach((listener) => listener(task)),
    emitMoved: (task: Task, from: string, to: string) => movedListeners.forEach((listener) => listener({ task, from, to })),
    setLiveTask: (next: Task | undefined) => { liveTask = next; },
    setLiveReadError: (next: Error | undefined) => { liveReadError = next; },
    claimTaskWedgeNotificationEpisode,
    markTaskWedgeNotificationPending: vi.fn(async (_taskId: string, descriptor: any, options?: { staleAfterMs?: number }) => {
      const now = new Date().toISOString();
      const pending = wedge?.pending;
      const stale = pending !== undefined && pending.reasonKey === descriptor.reasonKey && typeof options?.staleAfterMs === "number" && Date.now() - Date.parse(pending.since) > options.staleAfterMs;
      if (wedge?.status === "active" && wedge.reasonKey === descriptor.reasonKey) return { since: pending?.since ?? now, armed: false, restamped: false };
      if (pending !== undefined && pending.reasonKey === descriptor.reasonKey && !stale) return { since: pending.since, armed: false, restamped: false };
      wedge = wedge ? { ...wedge, pending: { since: now, ...descriptor } } : { reasonKey: descriptor.reasonKey, episodeId: "", status: "resolved", transitionedAt: now, pending: { since: now, ...descriptor } };
      if (liveTask) liveTask = { ...liveTask, wedgeNotification: wedge };
      return { since: now, armed: true, restamped: pending != null };
    }),
    clearTaskWedgeNotificationPending: vi.fn(async () => {
      if (!wedge?.pending) return false;
      const { pending: _pending, ...rest } = wedge;
      wedge = rest;
      if (liveTask) liveTask = { ...liveTask, wedgeNotification: wedge };
      return true;
    }),
    /* Absent → the helper keeps the legacy ids, which is every pre-existing case in this file. */
    ...(workflowIr ? { listWorkflowDefinitions: async () => [{ ir: workflowIr }] } : {}),
  };
  const sendMessageOnce = vi.fn(async (_input: unknown, _key: string) => ({ message: {} as any, inserted: true }));
  const service = new NotificationService(store as any, { messageStore: { on: () => undefined, sendMessageOnce } as any, failedNotificationGraceMs: 60_000, wedgeNotificationSettleMs: settleMs });
  const sendNotification = vi.fn(async () => ({ success: true, providerId: "test" }));
  const provider: NotificationProvider = { getProviderId: () => "test", isEventSupported: () => true, sendNotification };
  service.registerProvider(provider);
  const task = (overrides: Partial<Task> = {}): Task => ({ id: "FN-8501", title: "Fix changeset", description: "", column: "in-review", status: "failed", error: "merge verification failed: check:changeset-format", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-07-22T12:00:00.000Z", updatedAt: "2026-07-22T12:00:00.000Z", ...overrides } as Task);
  return { store, service, sendMessageOnce, sendNotification, task, getWedge: () => wedge, setWedge: (next: Task["wedgeNotification"]) => { wedge = next; }, claimTaskWedgeNotificationEpisode };
}

/* Creates a restart-safe claim fake so NotificationService tests exercise delivery policy, not storage implementation. */
function cooldownFixture({ durable = true, settleMs = 0 }: { durable?: boolean; settleMs?: number } = {}) {
  const listeners = new Set<Listener>();
  let wedge: Task["wedgeNotification"];
  const stamps = new Map<string, number>();
  const store = {
    getSettings: async () => ({ ntfyEnabled: true, ntfyTopic: "test" }) as Settings,
    on: (event: string, listener: Listener) => { if (event === "task:updated") listeners.add(listener); },
    off: () => undefined,
    emit: (task: Task) => listeners.forEach((listener) => listener(task)),
    ...(durable ? {
      claimTaskWedgeNotificationEpisode: async (taskId: string, reasonKey: string | null) => {
        if (reasonKey === null) {
          if (wedge?.status === "active") wedge = { ...wedge, status: "resolved" };
          return { claimed: false };
        }
        if (wedge?.status === "active" && wedge.reasonKey === reasonKey) return { claimed: false };
        const now = Date.now();
        for (const [key, notifiedAt] of stamps) {
          if (now - notifiedAt >= WEDGE_RENOTIFY_COOLDOWN_MS) stamps.delete(key);
        }
        const episodeId = `${taskId}-${reasonKey}-${now}`;
        wedge = { reasonKey, episodeId, status: "active", transitionedAt: new Date(now).toISOString() };
        if (stamps.has(reasonKey)) return { claimed: false };
        stamps.set(reasonKey, now);
        return { claimed: true, episodeId };
      },
    } : {}),
  };
  const sendMessageOnce = vi.fn(async (_input: unknown, _key: string) => ({ message: {} as any, inserted: true }));
  const service = new NotificationService(store as any, { messageStore: { on: () => undefined, sendMessageOnce } as any, wedgeNotificationSettleMs: settleMs });
  const sendNotification = vi.fn(async () => ({ success: true, providerId: "test" }));
  service.registerProvider({ getProviderId: () => "test", isEventSupported: () => true, sendNotification });
  const task = (overrides: Partial<Task> = {}): Task => ({ id: "FN-8691", title: "Blocked task", description: "", column: "in-review", status: "failed", error: "BLOCKED: dependency unavailable", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-08-01T12:00:00.000Z", updatedAt: new Date().toISOString(), ...overrides } as Task);
  return { store, service, sendMessageOnce, sendNotification, task };
}

async function flushWedgeHandling() {
  // FNXC:TaskWedgeNotifications 2026-08-10-04:35: Wedge delivery resolves lifecycle roles before its claim, so drain both the per-task chain and role-resolution promise turns without real timers.
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("task wedge notifications", () => {
  it("withholds terminal alerts when the task recovers inside the settle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    const { store, service, sendMessageOnce, sendNotification, task, getWedge } = fixture(undefined, 1_000);
    await service.start();
    store.setLiveTask(task({ error: "BLOCKED: upstream", column: "in-review" }));
    store.emit(task({ error: "BLOCKED: upstream", column: "in-review" }));
    await flushWedgeHandling();
    expect(getWedge()?.pending).toBeDefined();
    const recovered = task({ status: "in-progress", error: undefined, column: "in-progress", log: [{ action: "Auto-recovered: retry succeeded" }] as any });
    store.setLiveTask(recovered);
    store.emit(recovered);
    await flushWedgeHandling();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(getWedge()?.pending).toBeUndefined();
    await service.stop();
    vi.useRealTimers();
  });

  it("re-arms an early timer completion on durable and compatibility stores", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));

    const durable = fixture(undefined, 1_000);
    await durable.service.start();
    const durableFailed = durable.task({ error: "BLOCKED: upstream" });
    durable.store.setLiveTask(durableFailed);
    durable.store.emit(durableFailed);
    await flushWedgeHandling();
    await vi.advanceTimersByTimeAsync(500);
    (durable.service as any).wedgeNotificationSettleMs = 2_000;
    await vi.advanceTimersByTimeAsync(500);
    expect(durable.sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(durable.sendNotification).toHaveBeenCalledTimes(1);
    await durable.service.stop();

    const compatibility = cooldownFixture({ durable: false, settleMs: 1_000 });
    await compatibility.service.start();
    const compatibilityFailed = compatibility.task({ error: "BLOCKED: upstream" });
    compatibility.store.emit(compatibilityFailed);
    await flushWedgeHandling();
    await vi.advanceTimersByTimeAsync(500);
    (compatibility.service as any).wedgeNotificationSettleMs = 2_000;
    await vi.advanceTimersByTimeAsync(500);
    expect(compatibility.sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compatibility.sendNotification).toHaveBeenCalledTimes(1);
    await compatibility.service.stop();
    vi.useRealTimers();
  });

  it("re-arms stale timer completions before delivering on durable and compatibility stores", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));

    const durable = fixture(undefined, 1_000);
    await durable.service.start();
    const durableFailed = durable.task({ error: "BLOCKED: upstream" });
    durable.store.setLiveTask(durableFailed);
    durable.store.emit(durableFailed);
    await flushWedgeHandling();
    vi.setSystemTime(new Date("2026-08-11T14:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(durable.sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(durable.sendNotification).toHaveBeenCalledTimes(1);
    await durable.service.stop();

    const compatibility = cooldownFixture({ durable: false, settleMs: 1_000 });
    await compatibility.service.start();
    const compatibilityFailed = compatibility.task({ error: "BLOCKED: upstream" });
    compatibility.store.emit(compatibilityFailed);
    await flushWedgeHandling();
    vi.setSystemTime(new Date("2026-08-11T16:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compatibility.sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compatibility.sendNotification).toHaveBeenCalledTimes(1);
    await compatibility.service.stop();
    vi.useRealTimers();
  });

  it("completes against a compatibility snapshot and fails quiet without one", async () => {
    vi.useFakeTimers();
    const compatibility = cooldownFixture({ durable: false, settleMs: 1_000 });
    await compatibility.service.start();
    const failed = compatibility.task({ error: "BLOCKED: upstream" });
    compatibility.store.emit(failed);
    await flushWedgeHandling();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(compatibility.sendNotification).toHaveBeenCalledTimes(1);
    await compatibility.service.stop();

    const unreadable = cooldownFixture({ durable: false, settleMs: 1_000 });
    await unreadable.service.start();
    await expect(unreadable.service.completePendingWedgeNotification("FN-missing")).resolves.toEqual({ outcome: "unreadable" });
    expect(unreadable.sendNotification).not.toHaveBeenCalled();
    await unreadable.service.stop();
    vi.useRealTimers();
  });

  it("uses a configured maintenance interval to keep stale holds deliverable after a restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    const { store, service, sendNotification, task, setWedge } = fixture(undefined, 1_000, 1_800_000);
    await service.start();
    const since = new Date(Date.now() - 1_000_000).toISOString();
    const pending = {
      reasonKey: "terminal-failed", episodeId: "", status: "resolved" as const, transitionedAt: since,
      pending: { since, reasonKey: "terminal-failed", source: "auto" as const, reason: "The task entered a terminal failed state and needs operator intervention.", action: "Inspect the task failure and retry or replan it." },
    };
    setWedge(pending);
    store.setLiveTask(task({ error: "boom", wedgeNotification: pending }));

    // The age exceeds the old hard-coded 15-minute horizon but not maintenance + window.
    expect((service as any).resolveStaleHoldHorizonMs()).toBe(1_801_000);
    await expect(service.completePendingWedgeNotification("FN-8501")).resolves.toMatchObject({ outcome: "delivered" });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await service.stop();
    vi.useRealTimers();
  });

  it("clears an outstanding hold when the settle window switches to zero without a duplicate dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    const { store, service, sendMessageOnce, sendNotification, task, getWedge } = fixture(undefined, 1_000);
    await service.start();
    const failed = task({ error: "BLOCKED: upstream", column: "in-review" });
    store.setLiveTask(failed);
    store.emit(failed);
    await flushWedgeHandling();
    expect(getWedge()?.pending).toBeDefined();

    // This models a settings refresh after an operator restores legacy immediate delivery.
    (service as any).wedgeNotificationSettleMs = 0;
    await expect(service.completePendingWedgeNotification(failed.id)).resolves.toEqual({ outcome: "cleared" });
    expect(getWedge()?.pending).toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();

    store.emit(failed);
    await flushWedgeHandling();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await service.stop();
    vi.useRealTimers();
  });

  it("clears a pending hold from the subscribed task:moved recovery path", async () => {
    vi.useFakeTimers();
    const { store, service, sendMessageOnce, sendNotification, task, getWedge } = fixture(RENAMED_IR, 1_000);
    await service.start();
    const failed = task({ error: "BLOCKED: upstream", column: "checking" });
    store.setLiveTask(failed);
    store.emit(failed);
    await flushWedgeHandling();
    expect(getWedge()?.pending).toBeDefined();

    const recovered = task({ column: "shipped", status: "done", error: undefined });
    store.setLiveTask(recovered);
    store.emitMoved(recovered, "checking", "shipped");
    await flushWedgeHandling();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(getWedge()?.pending).toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(sendMessageOnce).not.toHaveBeenCalled();
    await service.stop();
    vi.useRealTimers();
  });

  it("revalidates an auto hold and restarts it when the live reason changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    const { store, service, sendMessageOnce, task } = fixture(undefined, 1_000);
    await service.start();
    store.setLiveTask(task({ error: "BLOCKED: upstream", column: "in-review" }));
    store.emit(task({ error: "BLOCKED: upstream", column: "in-review" }));
    await flushWedgeHandling();
    store.setLiveTask(task({ error: "Tool failure retries exhausted", column: "in-review" }));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(sendMessageOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect((sendMessageOnce.mock.calls[0]?.[0] as any).content).toContain("tool-failure retries");
    await service.stop();
    vi.useRealTimers();
  });

  it("clears a supplied hold when the live task becomes user-paused", async () => {
    vi.useFakeTimers();
    const { service, store, sendMessageOnce, task } = fixture(undefined, 1_000);
    const stalled = task({ status: "in-review", error: undefined, paused: false, userPaused: false });
    const descriptor = describeSelfHealingNoActionWedge(stalled, "reconcile-in-review-unmet-dependencies", { taskActive: false })!;
    await service.start();
    store.setLiveTask(stalled);
    await service.notifyTaskWedge(stalled, descriptor);
    store.setLiveTask({ ...stalled, userPaused: true });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(sendMessageOnce).not.toHaveBeenCalled();
    await service.stop();
    vi.useRealTimers();
  });

  it("keeps the void queue live after an in-chain pending completion", async () => {
    vi.useFakeTimers();
    const { store, service, sendMessageOnce, task } = fixture(undefined, 1_000);
    await service.start();
    store.setLiveTask(task({ error: "BLOCKED: upstream", column: "in-review" }));
    store.emit(task({ error: "BLOCKED: upstream", column: "in-review" }));
    await flushWedgeHandling();
    store.emit(task({ error: "BLOCKED: upstream", column: "in-review", updatedAt: "2026-08-11T12:00:01.000Z" }));
    await flushWedgeHandling();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    await service.stop();
    vi.useRealTimers();
  });

  /*
  FNXC:TaskWedgeNotifications 2026-08-01-15:35:
  A BLOCKED task can resolve and re-wedge as scheduler/self-healing touch it. A
  fresh episode id previously defeated sendMessageOnce; both delivery lanes now
  notify once per reason cooldown and re-open only after that window expires.
  */
  it("suppresses five resolve/re-wedge execution-blocked flaps until the cooldown expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const { store, service, sendMessageOnce, sendNotification, task } = cooldownFixture();
    await service.start();

    for (let index = 0; index < 5; index += 1) {
      store.emit(task({ updatedAt: new Date().toISOString() }));
      await flushWedgeHandling();
      store.emit(task({ status: "in-progress", error: undefined, column: "in-progress", updatedAt: new Date().toISOString() }));
      await flushWedgeHandling();
    }
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(WEDGE_RENOTIFY_COOLDOWN_MS);
    store.emit(task({ updatedAt: new Date().toISOString() }));
    await flushWedgeHandling();
    expect(sendMessageOnce).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    await service.stop();
    vi.useRealTimers();
  });

  it("retains X cooldown across Y, preserves distinct gates, and covers self-healing entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const { store, service, sendMessageOnce, task } = cooldownFixture();
    await service.start();
    const executionBlocked = describeTaskWedge(task())!;
    const lint = describeTaskWedge(task({ error: "merge verification failed: check:lint" }))!;
    const changeset = describeTaskWedge(task({ error: "merge verification failed: check:changeset-format" }))!;

    await service.notifyTaskWedge(task(), executionBlocked);
    await service.notifyTaskWedge(task(), lint);
    await service.notifyTaskWedge(task(), executionBlocked);
    await service.notifyTaskWedge(task(), changeset);
    expect(sendMessageOnce).toHaveBeenCalledTimes(3);

    const noAction = describeSelfHealingNoActionWedge(task({ status: "in-review", error: undefined }), "reconcile-in-review-unmet-dependencies", { taskActive: false });
    await service.notifyTaskWedge(task({ status: "in-review", error: undefined }), noAction!);
    store.emit(task({ status: "in-progress", error: undefined, column: "in-progress" }));
    await flushWedgeHandling();
    await service.notifyTaskWedge(task({ status: "in-review", error: undefined }), noAction!);
    expect(sendMessageOnce).toHaveBeenCalledTimes(4);
    await service.stop();
    vi.useRealTimers();
  });

  it("gives the in-memory fallback the same resolve/re-wedge cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const { store, service, sendMessageOnce, sendNotification, task } = cooldownFixture({ durable: false });
    await service.start();
    for (let index = 0; index < 5; index += 1) {
      store.emit(task());
      await flushWedgeHandling();
      store.emit(task({ status: "in-progress", error: undefined, column: "in-progress" }));
      await flushWedgeHandling();
    }
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await service.stop();
    vi.useRealTimers();
  });

  it("sends one actionable push and mailbox message per active terminal episode", async () => {
    const { store, service, sendMessageOnce, sendNotification, task } = fixture();
    await service.start();
    store.emit(task());
    store.emit(task({ updatedAt: "2026-07-22T12:01:00.000Z" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    expect(sendNotification).toHaveBeenCalledWith("task-wedged", expect.objectContaining({ taskId: "FN-8501", metadata: expect.objectContaining({ gate: "check:changeset-format" }) }));
    const firstMessage = sendMessageOnce.mock.calls[0]?.[0] as { content: string } | undefined;
    expect(firstMessage?.content).toContain("Fix changeset");
    expect(firstMessage?.content).toContain("Recommended action");
    store.emit(task({ status: "queued", error: undefined, column: "todo", updatedAt: "2026-07-22T12:02:00.000Z" }));
    store.emit(task({ updatedAt: "2026-07-22T12:03:00.000Z" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    await service.stop();
  });

  /*
  FNXC:TaskWedgeNotifications 2026-08-09-06:30:
  The event can race a completed resume. Delivery must ignore its stale failed
  descriptor, re-read the executing row, and resolve the previously active episode.
  */
  it("does not alert from a failed snapshot after the live task resumes", async () => {
    const { store, service, sendMessageOnce, sendNotification, task, setWedge, claimTaskWedgeNotificationEpisode } = fixture();
    const active = { reasonKey: "merge-blocked:changeset-format", episodeId: "active-episode", status: "active" as const, transitionedAt: "2026-07-22T12:00:00.000Z" };
    setWedge(active);
    store.setLiveTask(task({ status: "in-progress", column: "in-progress", error: undefined, wedgeNotification: active }));
    await service.start();

    store.emit(task({ status: "failed", wedgeNotification: active }));
    await flushWedgeHandling();

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(claimTaskWedgeNotificationEpisode).toHaveBeenCalledWith("FN-8501", null);
    await service.stop();
  });

  it("does not alert repeatedly for a live executing task with a stale pause reason", async () => {
    const { store, service, sendMessageOnce, sendNotification, task } = fixture();
    const resumed = task({ status: "in-progress", column: "in-progress", paused: false, pausedReason: "completed-blocked", error: undefined });
    store.setLiveTask(resumed);
    await service.start();

    store.emit(task({ paused: true, pausedReason: "completed-blocked", status: "queued" }));
    store.emit(task({ paused: true, pausedReason: "completed-blocked", status: "queued", updatedAt: "2026-07-22T12:01:00.000Z" }));
    await flushWedgeHandling();

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  it("does not deliver a self-healing descriptor after the live task progresses", async () => {
    const { store, service, sendMessageOnce, sendNotification, task } = fixture();
    const stalled = task({ status: "in-review", error: undefined, paused: false, userPaused: false });
    const descriptor = describeSelfHealingNoActionWedge(stalled, "reconcile-in-review-unmet-dependencies", { taskActive: false })!;
    store.setLiveTask(task({ status: "in-progress", column: "in-progress", error: undefined }));
    await service.start();

    await service.notifyTaskWedge(stalled, descriptor);

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  it("does not deliver self-healing descriptors when the live row is held or reviewing", async () => {
    const { store, service, sendMessageOnce, sendNotification, task } = fixture();
    const stalled = task({ status: "in-review", error: undefined, paused: false, userPaused: false });
    const descriptor = describeSelfHealingNoActionWedge(stalled, "reconcile-in-review-unmet-dependencies", { taskActive: false })!;
    await service.start();

    for (const live of [
      task({ status: "in-review", paused: true, error: undefined }),
      task({ status: "in-review", userPaused: true, error: undefined }),
      task({ status: "in-review", autoMerge: false, error: undefined }),
      task({ status: "reviewing", error: undefined }),
    ]) {
      store.setLiveTask(live);
      await service.notifyTaskWedge(stalled, descriptor);
    }

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  it("quietly handles a typed not-found live read without rejecting the wedge chain", async () => {
    const { store, service, sendMessageOnce, sendNotification, task } = fixture();
    store.setLiveReadError(new TaskNotFoundError("FN-8501"));
    await service.start();

    await expect(service.notifyTaskWedge(task(), describeTaskWedge(task())!)).resolves.toBe("unavailable");
    store.emit(task());
    await flushWedgeHandling();

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  it("resolves an active episode for an archived failed live row", async () => {
    const { store, service, sendMessageOnce, sendNotification, task, setWedge, claimTaskWedgeNotificationEpisode } = fixture();
    const active = { reasonKey: "merge-blocked:changeset-format", episodeId: "archived-episode", status: "active" as const, transitionedAt: "2026-07-22T12:00:00.000Z" };
    setWedge(active);
    store.setLiveTask(task({ column: "archived", status: "failed", wedgeNotification: active }));
    await service.start();

    await service.notifyTaskWedge(task({ wedgeNotification: active }), describeTaskWedge(task())!);

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(claimTaskWedgeNotificationEpisode).toHaveBeenCalledWith("FN-8501", null);
    await service.stop();
  });

  /*
  FNXC:TaskWedgeNotifications 2026-08-01-07:44:
  A recovery and re-wedge can be emitted back-to-back by synchronous task lifecycle writers. The
  per-task chain must run the recovery's resolve before the second wedge's claim; otherwise the old
  active episode rejects the claim and drops the second operator alert.
  */
  it("serializes back-to-back recovery and re-wedge task updates", async () => {
    const { store, service, sendMessageOnce, task } = fixture();
    await service.start();

    store.emit(task());
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    store.emit(task({ status: "queued", error: undefined, column: "todo", updatedAt: "2026-07-22T12:02:00.000Z" }));
    store.emit(task({ updatedAt: "2026-07-22T12:03:00.000Z" }));

    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    await service.stop();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-18:50 (fleet):
  Clearing a wedge episode asks "has the card moved on?", which was four column literals. On a renamed
  board none matched, so a RECOVERED card never cleared its episode and the operator kept an alert for
  work that had already progressed — and, because the stale episode stays active, the NEXT genuine wedge
  is refused its claim and never announced at all.

  The board below recovers into `backlog` (hold). The assertion is the second message: with the literals
  it never arrives, because the first episode was never resolved.
  */
  it("clears a wedge episode when the card recovers into a RENAMED hold lane", async () => {
    const RENAMED_IR = {
      version: "v2",
      name: "renamed-notify",
      columns: [
        { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
        { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
      nodes: [],
      edges: [],
    };
    const { store, service, sendMessageOnce, task } = fixture();
    /* `resolveProjectColumnsForRoles` unions lanes across the PROJECT's workflows, so the fake needs
       `listWorkflowDefinitions` — the per-task selection readers alone leave it resolving nothing. */
    Object.assign(store, {
      getTaskWorkflowSelection: () => ({ workflowId: "custom:renamed", stepIds: [] }),
      getTaskWorkflowSelectionAsync: async () => ({ workflowId: "custom:renamed", stepIds: [] }),
      getWorkflowDefinition: async () => ({ ir: RENAMED_IR }),
      listWorkflowDefinitions: async () => [{ id: "custom:renamed", ir: RENAMED_IR }],
    });

    await service.start();
    store.emit(task({ column: "signoff" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    // Recovered into the board's own hold lane — the episode must close.
    /* status stays "failed" ON PURPOSE: the status disjunct (`status !== "failed"`) would otherwise
       satisfy hasProgressed on its own and the column term would never decide anything. */
    store.emit(task({ status: "failed", error: undefined, column: "backlog", updatedAt: "2026-07-22T12:02:00.000Z" }));
    // Wedged again: only claimable if the previous episode actually cleared.
    store.emit(task({ column: "signoff", updatedAt: "2026-07-22T12:03:00.000Z" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    await service.stop();
  });

  it("does not re-deliver an unchanged durable episode after service restart", async () => {
    const { store, service, sendNotification, sendMessageOnce, task } = fixture();
    await service.start();
    store.emit(task());
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    await service.stop();

    const restarted = new NotificationService(store as any, { messageStore: { on: () => undefined, sendMessageOnce } as any, wedgeNotificationSettleMs: 0 });
    restarted.registerProvider({ getProviderId: () => "restarted", isEventSupported: () => true, sendNotification });
    await restarted.start();
    store.emit(task({ updatedAt: "2026-07-22T12:01:00.000Z" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await restarted.stop();
  });

  it.each([
    "reclaim-pr-conflict",
    "reclaim-self-owned-branch-conflict",
    "reconcile-in-review-unmet-dependencies",
    "reconcile-dependency-blocking-lease",
    "auto-rebound-paused-scope-decay",
    "stuck-merge-deadlock",
    "missing-worktree-merge-active",
    "missing-worktree-review",
    "finalize-no-op-review",
    "stale-incomplete-review",
    "ghost-review",
    "no-progress-no-task-done",
    "partial-progress-no-task-done",
  ])("preserves ownerless self-healing alerts for %s", (stage) => {
    const { task } = fixture();
    const ownerless = task({ status: "in-review", error: undefined, paused: false, userPaused: false });
    expect(describeSelfHealingNoActionWedge(ownerless, stage, {
      sessionDead: true,
      noRecentActivity: true,
      worktreeUnusable: false,
      taskActive: false,
      hasExecutingTaskLock: false,
      livePaths: [],
    })).toMatchObject({ reasonKey: `self-healing-no-action:${stage}` });
  });

  it("suppresses self-healing declines that prove liveness or intentional holds", () => {
    const { task } = fixture();
    const ownerless = task({ status: "in-review", error: undefined, paused: false, userPaused: false });
    const stage = "reconcile-in-review-unmet-dependencies";
    for (const proof of [
      { sessionDead: false },
      { noRecentActivity: false },
      { taskActive: true },
      { hasExecutingTaskLock: true },
      { mergePending: true },
      { livePaths: ["/live/session"] },
      { reason: "paused-guard" },
      { reason: "auto-merge-processing-disabled" },
    ]) {
      expect(describeSelfHealingNoActionWedge(ownerless, stage, proof)).toBeNull();
    }
    expect(describeSelfHealingNoActionWedge(ownerless, stage, undefined)).toMatchObject({ reasonKey: `self-healing-no-action:${stage}` });
  });

  it("treats reviewing as progressing while preserving pause guards", () => {
    const { task } = fixture();
    expect(isTaskProgressing(task({ status: "reviewing", paused: false }))).toBe(true);
    expect(isTaskProgressing(task({ status: "reviewing", paused: true }))).toBe(false);
    expect(isTaskProgressing(task({ status: "paused", paused: false }))).toBe(false);
  });

  it("delivers one durable episode for an ownerless self-healing no-action escalation", async () => {
    const { service, sendMessageOnce, sendNotification, task } = fixture();
    await service.start();
    const ownerless = task({ status: "in-review", error: undefined, paused: false, userPaused: false });
    const descriptor = describeSelfHealingNoActionWedge(ownerless, "reconcile-in-review-unmet-dependencies", {
      taskActive: false,
      hasExecutingTaskLock: false,
      livePaths: [],
    });
    expect(descriptor).toMatchObject({ reasonKey: "self-healing-no-action:reconcile-in-review-unmet-dependencies" });
    await service.notifyTaskWedge(ownerless, descriptor!);
    await service.notifyTaskWedge(ownerless, descriptor!);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    expect(sendNotification).toHaveBeenCalledWith("task-wedged", expect.objectContaining({ taskId: "FN-8501" }));
    expect(describeSelfHealingNoActionWedge(ownerless, "reconcile-in-review-unmet-dependencies", { taskActive: true })).toBeNull();
    await service.stop();
  });

  it("does not resolve an ownerless no-action episode on an incidental in-review update", async () => {
    const { store, service, sendMessageOnce, task, getWedge } = fixture();
    await service.start();
    const ownerless = task({ status: "in-review", error: undefined, paused: false, userPaused: false });
    const descriptor = describeSelfHealingNoActionWedge(ownerless, "reconcile-in-review-unmet-dependencies", {
      taskActive: false,
      hasExecutingTaskLock: false,
      livePaths: [],
    });
    await service.notifyTaskWedge(ownerless, descriptor!);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    store.emit({ ...ownerless, title: "Unrelated update", wedgeNotification: getWedge() });
    await Promise.resolve();
    await Promise.resolve();
    expect(getWedge()?.status).toBe("active");
    await service.notifyTaskWedge(ownerless, descriptor!);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it.each(["queued", "planning", "in-progress", "reviewing", "merging", "merging-pr", "merging-fix", "merged", "done"])("does not classify a stale pause reason while %s is progressing", (status) => {
    const { task } = fixture();
    expect(describeTaskWedge(task({ status: status as Task["status"], paused: false, pausedReason: "completed-blocked", error: undefined }))).toBeNull();
  });

  it.each([
    ["completed-blocked", "completion-blocked"],
    ["error-retry-exhausted", "heartbeat-retry-exhausted"],
    ["error-unrecoverable", "heartbeat-error-unrecoverable"],
    ["branch-cross-contamination", "branch-cross-contamination"],
    ["branch-conflict-tripwire", "branch-conflict-tripwire"],
    ["branch-conflict-recovery-exhausted", "branch-conflict-recovery-exhausted"],
    ["branch-conflict-unrecoverable", "branch-conflict-unrecoverable"],
    ["stuck-loop-exhausted-manual-intervention-required", "stuck-loop-exhausted"],
    ["non-retryable-provider-error", "non-retryable-provider-error"],
    ["in-review-stall-deadlock", "in-review-stall-deadlock"],
  ])("requires pause proof but preserves terminal pause reason %s as %s", (pausedReason, reasonKey) => {
    const { task } = fixture();
    expect(describeTaskWedge(task({ status: "failed", paused: false, pausedReason }))).not.toMatchObject({ reasonKey });
    expect(describeTaskWedge(task({ status: "paused", paused: false, pausedReason }))).toMatchObject({ reasonKey });
    expect(describeTaskWedge(task({ status: "queued", paused: true, pausedReason }))).toMatchObject({ reasonKey });
  });

  it("keeps the FN-7926 completed-blocked park shape actionable", () => {
    const { task } = fixture();
    expect(describeTaskWedge(task({ status: "queued", paused: true, pausedReason: "completed-blocked", error: undefined }))).toMatchObject({ reasonKey: "completion-blocked" });
  });

  it.each([
    ["branch-cross-contamination", "branch-cross-contamination"],
    ["branch-conflict-tripwire", "branch-conflict-tripwire"],
    ["branch-conflict-recovery-exhausted", "branch-conflict-recovery-exhausted"],
    ["branch-conflict-unrecoverable", "branch-conflict-unrecoverable"],
    ["stuck-loop-exhausted-manual-intervention-required", "stuck-loop-exhausted"],
    ["non-retryable-provider-error", "non-retryable-provider-error"],
    ["in-review-stall-deadlock", "in-review-stall-deadlock"],
  ])("classifies automated terminal pause %s as %s", (pausedReason, reasonKey) => {
    const { task } = fixture();
    expect(describeTaskWedge(task({ status: "failed", paused: true, pausedReason }))).toMatchObject({ reasonKey });
  });

  it.each([
    ["missing error and recovery metadata", { error: undefined }, false, null],
    ["scheduled executor recovery", { error: "opaque failure", recoveryRetryCount: 1, nextRecoveryAt: "2026-08-05T05:00:00.000Z" }, true, null],
    ["persisted transient merge retry", { error: "socket hang up", mergeTransientRetryCount: 1 }, true, null],
    ["exhausted transient merge retry", { error: "socket hang up", mergeTransientRetryCount: MAX_AUTO_MERGE_TRANSIENT_RETRIES }, false, "terminal-failed"],
    ["cleared recovery state", { error: "opaque failure", recoveryRetryCount: null, nextRecoveryAt: null }, false, "terminal-failed"],
  ])("classifies %s without treating raw error text as automatic ownership", (_name, overrides, hasOwner, reasonKey) => {
    const { task } = fixture();
    const failed = task(overrides as Partial<Task>);
    expect(describeTaskRecoveryOwner(failed)).toEqual(hasOwner ? expect.anything() : null);
    expect(describeTaskWedge(failed)).toEqual(reasonKey === null ? null : expect.objectContaining({ reasonKey }));
  });

  it("keeps explicit terminal pause reasons actionable despite stale recovery metadata", () => {
    const { task } = fixture();
    expect(describeTaskWedge(task({
      paused: true,
      pausedReason: "error-retry-exhausted",
      recoveryRetryCount: 1,
      nextRecoveryAt: "2026-08-05T05:00:00.000Z",
    }))).toMatchObject({ reasonKey: "heartbeat-retry-exhausted" });
  });

  it("classifies an otherwise unknown persisted failure with a bounded fallback", () => {
    const { task } = fixture();
    expect(describeTaskWedge(task({ error: "internal stack trace or opaque failure" }))).toMatchObject({ reasonKey: "terminal-failed" });
  });

  it("changes the active reason into a new episode without raw error keys", async () => {
    const { store, service, sendMessageOnce, task } = fixture();
    await service.start();
    store.emit(task({ error: "EXECUTION_DISPATCH_LOOP_EXHAUSTED: details" }));
    store.emit(task({ error: "Tool failure retries exhausted", updatedAt: "2026-07-22T12:01:00.000Z", column: "in-progress" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    expect(sendMessageOnce.mock.calls.map((call) => call[1])).not.toContain(expect.stringContaining("details"));
    await service.stop();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-21:35:
  A RECOVERED CARD ON A RENAMED BOARD MUST CLOSE ITS WEDGE EPISODE.

  The resolve branch tested "has this card moved on" by comparing against `todo`/`in-progress`/
  `done`/`archived`. On a board using none of those ids nothing matched, so the episode stayed
  `active` after the card visibly recovered — the operator kept an open "needs operator action"
  alert for work that had moved on, and (because an active episode suppresses re-claim) the NEXT
  genuine wedge on that task was never delivered either.

  The observable is the second delivery, not the episode record: an episode that resolves but
  delivers nothing new would be a silent regression of the same alert.
  */
  it("resolves an episode when the card recovers into a RENAMED lane, and re-delivers on re-wedge", async () => {
    const { store, service, sendMessageOnce, task } = fixture(RENAMED_IR);
    await service.start();

    const wedged = (updatedAt: string) => task({ column: "checking" as never, updatedAt });
    store.emit(wedged("2026-07-22T12:00:00.000Z"));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    /*
    THE RECOVERY CARRIES NO STATUS, and that is what makes this test about the column at all.
    `hasProgressed` is an OR whose other arm is "status is a non-failed string" — my first version
    recovered with `status: "queued"`, that arm answered true, and the case passed against the
    literals. Measured: the mutation did not fail it. With `status` and `error` both cleared, the
    column membership is the ONLY thing that can resolve this episode.
    */
    store.emit(task({ status: undefined, error: undefined, column: "building" as never, updatedAt: "2026-07-22T12:02:00.000Z" }));
    store.emit(wedged("2026-07-22T12:03:00.000Z"));

    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    await service.stop();
  });

  /*
  The paired negative. The conversion widens membership over four roles, so it must not treat the
  REVIEW lane as progress — a wedged card sitting in review has not moved on, and resolving there
  would clear every episode on the next incidental update and re-alert forever.
  */
  it("does NOT resolve on a status-less update while the card sits in the renamed REVIEW lane", async () => {
    const { store, service, sendMessageOnce, task } = fixture(RENAMED_IR);
    await service.start();

    store.emit(task({ column: "checking" as never, updatedAt: "2026-07-22T12:00:00.000Z" }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));

    /* Same shape as the positive — no status, no error — so only the lane differs. Review is not
       progress: resolving here would clear the episode on any incidental update and re-alert. */
    store.emit(task({ status: undefined, error: undefined, column: "checking" as never, updatedAt: "2026-07-22T12:01:00.000Z" }));
    store.emit(task({ column: "checking" as never, updatedAt: "2026-07-22T12:02:00.000Z" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    await service.stop();
  });
});
