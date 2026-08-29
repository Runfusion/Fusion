import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationPayload, NotificationProvider, Settings, Task } from "@fusion/core";
import { NotificationService } from "../notification-service.js";
import { schedulerLog } from "../../logger.js";
import { flushAsyncHandlers } from "../../__tests__/_flush-async-handlers.js";

vi.mock("../../logger.js", () => ({
  /*
  FNXC:NotificationTestHarness 2026-07-30-23:50 (fix-forward: this file was asserting nothing):
  `debug` MUST be in this mock. Production moved its suppression traces from `schedulerLog.log` to
  `schedulerLog.debug`, and the mock was not updated — so `NotificationService.start()` threw
  `schedulerLog.debug is not a function` and ALL 26 cases in this file died in setup. They were reported
  as failures on main, which is the only reason it was visible at all; a suite that dies in `start()`
  asserts nothing about notifications.

  The two `.log` assertions below moved to `.debug` for the same reason — the messages they name are
  emitted by `debug` now, so asserting `log` could only ever have passed against the old production code.
  */
  schedulerLog: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  it("does not dispatch a stale source-tagged terminal escalation after the live budget advances", async () => {
    const store = createStore();
    const episode = vi.fn(async () => ({ claimed: true, episodeId: "should-not-claim" }));
    Object.assign(store, { claimTaskWedgeNotificationEpisode: episode });
    const service = new NotificationService(store as any);
    await service.start();
    const stale = task({
      id: "FN-stale-escalation",
      status: "failed",
      error: "opaque terminal failure",
      wedgeNotification: {
        reasonKey: "terminal-failed",
        episodeId: "stale-escalation",
        status: "active",
        transitionedAt: "2026-08-10T20:00:00.000Z",
        autoRecovery: { attempts: 1, lastAttemptAt: "2026-08-10T20:00:00.000Z" },
      },
    });
    store.setTask(stale);

    await expect(service.notifyTaskWedge(stale, {
      reasonKey: "terminal-failed",
      reason: "The task entered a terminal failed state and needs operator intervention.",
      action: "Retry the task.",
    }, { source: "auto-recovery-escalation" })).resolves.toBe("unavailable");

    expect(episode).not.toHaveBeenCalled();
  });

  it("stamps a durable suppressed exhaustion at the shared service seam", async () => {
    const store = createStore();
    const marker = vi.fn(async () => "already-stamped" as const);
    const stamp = vi.fn(async () => "stamped" as const);
    const episode = vi.fn(async () => ({ claimed: false }));
    Object.assign(store, {
      claimTaskWedgeNotificationEpisode: episode,
      markTerminalFailureAutoRecoveryBudgetExhausted: marker,
      markTerminalFailureAutoRecoveryEscalationDelivered: stamp,
    });
    const service = new NotificationService(store as any, { wedgeNotificationSettleMs: 0 });
    await service.start();
    const exhausted = task({
      id: "FN-suppressed-exhaustion",
      status: "failed",
      error: "opaque terminal failure",
      wedgeNotification: {
        reasonKey: "terminal-failed",
        episodeId: "active",
        status: "active",
        transitionedAt: "2026-08-10T20:00:00.000Z",
        lastNotifiedAtByReason: { "terminal-failed": "2026-08-10T20:01:00.000Z" },
        autoRecovery: {
          attempts: 3,
          lastAttemptAt: "2026-08-10T20:00:00.000Z",
          budgetStartedAt: "2026-08-10T20:00:00.000Z",
          exhaustedAt: "2026-08-10T20:01:00.000Z",
          lastBudgetWriteAt: "2026-08-10T20:01:00.000Z",
        },
      },
    });
    store.setTask(exhausted);
    store.emit("task:updated", exhausted);
    await flushAsyncHandlers();

    expect(marker).toHaveBeenCalledWith(exhausted.id, { maxAttempts: 3 });
    expect(episode).toHaveBeenCalledWith(exhausted.id, "terminal-failed");
    expect(stamp).toHaveBeenCalledWith(exhausted.id, {
      dispatchOutcome: "suppressed",
      escalationReason: "budget-exhausted",
    });
    expect(marker.mock.invocationCallOrder[0]).toBeLessThan(episode.mock.invocationCallOrder[0]);
    expect(episode.mock.invocationCallOrder[0]).toBeLessThan(stamp.mock.invocationCallOrder[0]);
  });

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
    const service = new NotificationService(store as any, { failedNotificationGraceMs: 100, wedgeNotificationSettleMs: 0 });
    service.registerProvider(provider);
    await service.start();
    return { store, service, sendNotification };
  }

  /*
  FNXC:TaskWedgeNotifications 2026-08-05-04:53:
  The reported sequence persists a failed snapshot while scheduler recovery owns
  it. No delivery or durable wedge claim is allowed until the writer clears that
  ownership at exhaustion, when the existing once-per-episode seam must alert.
  */
  it("suppresses recovery-owned failed snapshots and alerts once after exhaustion", async () => {
    const store = createStore();
    const sendMessageOnce = vi.fn(async () => ({ message: {} as any, inserted: true }));
    const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
    let activeReason: string | undefined;
    const claimTaskWedgeNotificationEpisode = vi.fn(async (_taskId: string, reasonKey: string | null) => {
      if (reasonKey === null) {
        activeReason = undefined;
        return { claimed: false };
      }
      if (activeReason === reasonKey) return { claimed: false };
      activeReason = reasonKey;
      return { claimed: true, episodeId: `episode:${reasonKey}` };
    });
    Object.assign(store, { claimTaskWedgeNotificationEpisode });
    const service = new NotificationService(store as any, {
      messageStore: { on: () => undefined, sendMessageOnce } as any,
      failedNotificationGraceMs: 100,
      wedgeNotificationSettleMs: 0,
    });
    service.registerProvider({ getProviderId: () => "mock", isEventSupported: () => true, sendNotification });
    await service.start();

    const recovering = task({
      id: "FN-recovering",
      status: "failed",
      error: "opaque executor failure",
      recoveryRetryCount: 1,
      nextRecoveryAt: "2026-08-05T05:00:00.000Z",
    });
    store.setTask(recovering);
    store.emit("task:updated", recovering);
    await flushAsyncHandlers();

    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(claimTaskWedgeNotificationEpisode).not.toHaveBeenCalled();
    expect(service.getPendingFailureCount()).toBe(0);

    const exhausted = task({
      ...recovering,
      recoveryRetryCount: undefined,
      nextRecoveryAt: undefined,
      updatedAt: "2026-08-05T05:01:00.000Z",
      wedgeNotification: {
        reasonKey: "terminal-failed", episodeId: "budget", status: "active", transitionedAt: "2026-08-05T05:00:00.000Z",
        autoRecovery: { attempts: 3, lastAttemptAt: "2026-08-05T05:00:00.000Z" },
      },
    });
    store.setTask(exhausted);
    store.emit("task:updated", exhausted);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    expect(sendNotification).toHaveBeenCalledWith("task-wedged", expect.objectContaining({ taskId: "FN-recovering" }));
    expect(claimTaskWedgeNotificationEpisode).toHaveBeenCalledTimes(1);

    store.emit("task:updated", exhausted);
    await flushAsyncHandlers();
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    await service.stop();
    const restarted = new NotificationService(store as any, { messageStore: { on: () => undefined, sendMessageOnce } as any, wedgeNotificationSettleMs: 0 });
    restarted.registerProvider({ getProviderId: () => "restarted", isEventSupported: () => true, sendNotification });
    await restarted.start();
    store.emit("task:updated", exhausted);
    await flushAsyncHandlers();
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await restarted.stop();
  });

  it("deduplicates durable awaiting-approval messages across policy re-parks and restart", async () => {
    const store = createStore();
    const messageKeys = new Set<string>();
    let insertedCount = 0;
    const sendMessageOnce = vi.fn(async (_input: unknown, idempotencyKey: string) => {
      const inserted = !messageKeys.has(idempotencyKey);
      messageKeys.add(idempotencyKey);
      if (inserted) insertedCount += 1;
      return { message: {} as any, inserted };
    });
    const service = new NotificationService(store as any, {
      messageStore: { on: () => undefined, sendMessageOnce } as any,
    });
    await service.start();
    const policyHold = task({
      id: "FN-policy-hold",
      column: "in-review",
      status: "awaiting-approval",
      error: "Pull request is blocked by branch protection.",
      awaitingApprovalReason: "merge-blocked-by-policy",
    });

    store.emit("task:updated", policyHold);
    store.emit("task:updated", policyHold);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    expect(insertedCount).toBe(1);
    expect(sendMessageOnce).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("pull-request merge is blocked"),
        metadata: expect.objectContaining({
          taskId: "FN-policy-hold",
          awaitingApprovalReason: "merge-blocked-by-policy",
        }),
      }),
      "merge-policy-block:FN-policy-hold",
    );

    await service.stop();
    const restarted = new NotificationService(store as any, {
      messageStore: { on: () => undefined, sendMessageOnce } as any,
    });
    await restarted.start();
    store.emit("task:updated", policyHold);
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(3));
    expect(insertedCount).toBe(1);
    await restarted.stop();
  });

  it("Failure that persists past grace dispatches exactly once", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({ id: "FN-1", status: "failed" }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    await vi.advanceTimersByTimeAsync(100);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("failed", expect.objectContaining({ taskId: "FN-1" }));
    await service.stop();
  });

  it("delivers only the live wedge cause when a snapshot is superseded", async () => {
    const { store, service, sendNotification } = await setup();
    const genericFailure = task({ id: "FN-wedge", status: "failed", error: "unexpected failure" });
    store.setTask(genericFailure);
    store.emit("task:updated", genericFailure);

    const wedge = task({
      id: "FN-wedge",
      status: "failed",
      column: "in-review",
      error: "merge verification failed: check:changeset-format",
    });
    store.setTask(wedge);
    store.emit("task:updated", wedge);
    await vi.advanceTimersByTimeAsync(100);

    // FNXC:TaskWedgeNotifications 2026-08-09-06:30: A superseded snapshot must not claim an obsolete episode.
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("task-wedged", expect.objectContaining({
      taskId: "FN-wedge",
      metadata: expect.objectContaining({ wedgeReason: "merge-blocked:changeset-format" }),
    }));
    expect(service.getPendingFailureCount()).toBe(0);
    await service.stop();
  });

  it("FN-5627: suppresses notification for transient lease-handoff-target-not-queued failures", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({
      id: "FN-5628",
      status: "failed",
      error: "Merge handoff refused (lease-handoff-failed): target-not-queued",
      mergeTransientRetryCount: 1,
    }));
    store.emit("task:updated", task({
      id: "FN-5628",
      status: "failed",
      error: "Merge handoff refused (lease-handoff-failed): target-not-queued",
      mergeTransientRetryCount: 1,
    }));

    await vi.advanceTimersByTimeAsync(500);

    expect(sendNotification).not.toHaveBeenCalled();
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    await service.stop();
  });

  it("FN-5627: suppresses notification for transient same-SHA spurious-concurrent-advance failures", async () => {
    const { store, service, sendNotification } = await setup();
    const transientError = "Integration branch main advanced concurrently (expected 694970b2f186fac31c1819d55ef30a2ad207b5c3, observed 694970b2f186fac31c1819d55ef30a2ad207b5c3) while applying b26f8fe1ee2d3dc36acf3571d42507b24bd8066b for FN-5626";
    store.setTask(task({ id: "FN-5626", status: "failed", error: transientError, mergeTransientRetryCount: 1 }));
    store.emit("task:updated", task({ id: "FN-5626", status: "failed", error: transientError, mergeTransientRetryCount: 1 }));

    await vi.advanceTimersByTimeAsync(500);

    expect(sendNotification).not.toHaveBeenCalled();
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    await service.stop();
  });

  it("FN-5627: generic concurrent-advance failures are withheld for terminal auto-recovery", async () => {
    const { store, service, sendNotification } = await setup();
    const genuineError = "Integration branch main advanced concurrently (expected aaa1111aaa1111aaa1111aaa1111aaa1111aaaa, observed bbb2222bbb2222bbb2222bbb2222bbb2222bbbb) while applying ccc3333ccc3333ccc3333ccc3333ccc3333cccc for FN-genuine";
    store.setTask(task({ id: "FN-genuine", status: "failed", error: genuineError }));
    store.emit("task:updated", task({ id: "FN-genuine", status: "failed", error: genuineError }));

    await vi.advanceTimersByTimeAsync(500);

    expect(sendNotification).not.toHaveBeenCalled();
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
    expect(schedulerLog.debug).toHaveBeenCalledWith(expect.stringContaining("suppressed transient failed"));
    await service.stop();
  });

  it("suppresses transient missing task.json failure after Auto-recovered clear", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({
      id: "FN-1",
      status: "failed",
      error: "ENOENT: no such file or directory, open '/tmp/worktrees/fn-1/.fusion/tasks/FN-1/task.json'",
    }));
    store.emit("task:updated", task({ id: "FN-1", status: "failed" }));

    const recoveredTask = task({
      id: "FN-1",
      status: undefined,
      error: undefined,
      column: "todo",
      log: [{ timestamp: new Date().toISOString(), action: "Auto-recovered: retry/verification session targeted unusable worktree" }],
    });
    store.setTask(recoveredTask);
    store.emit("task:moved", { task: recoveredTask, from: "in-progress", to: "todo" });
    await vi.advanceTimersByTimeAsync(100);

    expect(sendNotification).not.toHaveBeenCalledWith("failed", expect.anything());
    expect((await store.getTask("FN-1"))?.status).not.toBe("failed");
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
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
    expect(schedulerLog.debug).toHaveBeenCalledWith("[notify] FN-1 non-terminal failure — suppressed (mode=terminal-only)");
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

describe("NotificationService manual dispatch dedupe", () => {
  afterEach(() => {
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
    return { service, sendNotification };
  }

  it("suppresses duplicate CLI permission notifications using a metadata dedupe key", async () => {
    const { service, sendNotification } = await setup();
    const payload: NotificationPayload = {
      taskId: "FN-7109",
      event: "cli-agent-awaiting-input",
      metadata: {
        notificationDedupeKey: "cli-agent:proj-1:session-1:cli-agent-awaiting-input",
        notificationKind: "permission_request",
      },
    };

    await service.dispatch("cli-agent-awaiting-input", payload);
    await service.dispatch("cli-agent-awaiting-input", payload);
    await new Promise((resolve) => setImmediate(resolve));

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("cli-agent-awaiting-input", expect.objectContaining({ taskId: "FN-7109" }));
    await service.stop();
  });

  it("no-ops manual dispatch cleanly when notifications are disabled", async () => {
    const { service, sendNotification } = await setup({ ntfyEnabled: false, ntfyTopic: undefined });

    await service.dispatch("cli-agent-awaiting-input", {
      taskId: "FN-7109",
      event: "cli-agent-awaiting-input",
      metadata: { notificationDedupeKey: "cli-agent:disabled" },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });
});

describe("NotificationService workflow transition notifications", () => {
  afterEach(() => {
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

  it("emits a deduped planning-awaiting-input notification for workflow await-input task updates", async () => {
    const { store, service, sendNotification } = await setup();
    const awaitingInput = task({
      id: "FN-7201",
      status: "awaiting-user-input",
      paused: true,
      pausedReason: "workflow-input:planning@1782751605619: Which files should this plan cover?",
      log: [{ timestamp: new Date().toISOString(), action: "Workflow paused for user input: Which files should this plan cover?" }],
    });

    store.emit("task:updated", awaitingInput);
    store.emit("task:updated", awaitingInput);

    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledTimes(1);
    });
    expect(sendNotification).toHaveBeenCalledWith(
      "planning-awaiting-input",
      expect.objectContaining({
        taskId: "FN-7201",
        metadata: expect.objectContaining({
          notificationDedupeKey: "workflow-transition:FN-7201:awaiting-user-input",
          notificationKind: "workflow-awaiting-user-input",
        }),
      }),
    );
    await service.stop();
  });

  it("suppresses generic awaiting-user-input updates that are not workflow waits", async () => {
    const { store, service, sendNotification } = await setup();

    store.emit("task:updated", task({
      id: "FN-7202",
      status: "awaiting-user-input",
      paused: true,
      pausedReason: "waiting-for-review",
      log: [{ timestamp: new Date().toISOString(), action: "Paused for an unrelated reason" }],
    }));
    await flushAsyncHandlers();

    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  it("emits and dedupes workflow CLI approval notifications", async () => {
    const { store, service, sendNotification } = await setup();
    const awaitingCli = task({
      id: "FN-7205",
      status: "awaiting-cli-approval",
      paused: true,
      pausedReason: "workflow-cli-approval:code-review: pnpm test",
    });

    store.emit("task:updated", awaitingCli);
    store.emit("task:updated", awaitingCli);
    store.emit("task:updated", task({
      id: "FN-7206",
      status: "awaiting-cli-approval",
      paused: true,
      pausedReason: "manual-cli-approval: pnpm test",
    }));

    await flushAsyncHandlers();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      "cli-agent-awaiting-input",
      expect.objectContaining({
        taskId: "FN-7205",
        metadata: expect.objectContaining({
          notificationDedupeKey: "workflow-transition:FN-7205:awaiting-cli-approval",
          notificationKind: "workflow_cli_approval",
          pausedReason: "workflow-cli-approval:code-review: pnpm test",
        }),
      }),
    );
    await service.stop();
  });

  it("emits manual merge hold and later recovery requeue workflow notifications with separate dedupe keys", async () => {
    const { store, service, sendNotification } = await setup();
    const held = task({
      id: "FN-7203",
      column: "in-review",
      paused: true,
      pausedReason: "manual-hold",
      log: [{ timestamp: new Date().toISOString(), action: "Workflow merge-manual-hold reached manual-required" }],
    });

    store.emit("task:updated", held);
    store.emit("task:updated", held);
    store.emit("task:updated", task({
      id: "FN-7203",
      column: "todo",
      paused: false,
      pausedReason: undefined,
      status: undefined,
      workflowTransitionNotification: {
        kind: "recovery-requeue",
        column: "todo",
        transitionId: "recovery-requeue:FN-7203:pause-abort-active-work",
        nodeId: "recovery-router",
        reason: "pause-abort-active-work",
        createdAt: new Date().toISOString(),
      },
    }));

    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledTimes(2);
    });
    expect(sendNotification).toHaveBeenNthCalledWith(
      1,
      "workflow-notify",
      expect.objectContaining({
        taskId: "FN-7203",
        metadata: expect.objectContaining({
          notificationDedupeKey: "workflow-transition:FN-7203:manual-merge-hold",
          notificationKind: "manual_merge_hold",
        }),
      }),
    );
    expect(sendNotification).toHaveBeenNthCalledWith(
      2,
      "workflow-notify",
      expect.objectContaining({
        taskId: "FN-7203",
        metadata: expect.objectContaining({
          notificationDedupeKey: "workflow-transition:FN-7203:recovery-requeue:FN-7203:pause-abort-active-work",
          notificationKind: "workflow_recovery_requeue",
          nodeId: "recovery-router",
          reason: "pause-abort-active-work",
        }),
      }),
    );
    await service.stop();
  });

  it("emits manual merge hold notifications from current typed markers", async () => {
    const { store, service, sendNotification } = await setup();

    store.emit("task:updated", task({
      id: "FN-7209",
      column: "in-review",
      paused: false,
      pausedReason: undefined,
      workflowTransitionNotification: {
        kind: "manual-merge-hold",
        column: "in-review",
        transitionId: "manual-hold:merge-request:FN-7209",
        nodeId: "merge-manual-hold",
        reason: "merge-request-manual-required",
        createdAt: new Date().toISOString(),
      },
    }));

    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledTimes(1);
    });
    expect(sendNotification).toHaveBeenCalledWith(
      "workflow-notify",
      expect.objectContaining({
        taskId: "FN-7209",
        metadata: expect.objectContaining({
          notificationDedupeKey: "workflow-transition:FN-7209:manual-hold:merge-request:FN-7209",
          notificationKind: "manual_merge_hold",
          nodeId: "merge-manual-hold",
          reason: "merge-request-manual-required",
        }),
      }),
    );
    await service.stop();
  });

  it("does not infer workflow recovery notifications from log text or stale typed markers", async () => {
    const { store, service, sendNotification } = await setup();

    store.emit("task:updated", task({
      id: "FN-7207",
      column: "todo",
      status: undefined,
      log: [{ timestamp: new Date().toISOString(), action: "Workflow graph moved back to todo for execution resume" }],
    }));
    store.emit("task:updated", task({
      id: "FN-7208",
      column: "in-progress",
      status: undefined,
      workflowTransitionNotification: {
        kind: "recovery-requeue",
        column: "todo",
        transitionId: "stale-recovery",
        createdAt: new Date().toISOString(),
      },
    }));

    await flushAsyncHandlers();

    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  it("does not infer manual merge hold notifications from log text or stale typed markers", async () => {
    const { store, service, sendNotification } = await setup();

    store.emit("task:updated", task({
      id: "FN-7210",
      column: "in-review",
      paused: false,
      pausedReason: undefined,
      log: [{ timestamp: new Date().toISOString(), action: "Workflow merge-manual-hold reached manual-required" }],
    }));
    store.emit("task:updated", task({
      id: "FN-7211",
      column: "todo",
      workflowTransitionNotification: {
        kind: "manual-merge-hold",
        column: "in-review",
        transitionId: "stale-manual-hold",
        createdAt: new Date().toISOString(),
      },
    }));

    await flushAsyncHandlers();

    expect(sendNotification).not.toHaveBeenCalled();
    await service.stop();
  });

  it("does not add a manual-hold workflow notification when the failed status already represents the task update", async () => {
    const { store, service, sendNotification } = await setup({ failureNotificationMode: "all" });

    store.emit("task:updated", task({
      id: "FN-7204",
      column: "in-review",
      status: "failed",
      paused: true,
      pausedReason: "manual-hold",
      log: [{ timestamp: new Date().toISOString(), action: "Workflow merge-manual-hold reached manual-required" }],
    }));

    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledTimes(1);
    });
    expect(sendNotification).toHaveBeenCalledWith("failed", expect.objectContaining({ taskId: "FN-7204" }));
    expect(sendNotification).not.toHaveBeenCalledWith("workflow-notify", expect.anything());
    await service.stop();
  });

  it("does not add a recovery-requeue workflow notification when the failed status already represents the task update", async () => {
    const { store, service, sendNotification } = await setup({ failureNotificationMode: "all" });

    store.emit("task:updated", task({
      id: "FN-7212",
      column: "todo",
      status: "failed",
      workflowTransitionNotification: {
        kind: "recovery-requeue",
        column: "todo",
        transitionId: "recovery-requeue:FN-7212:pause-abort-active-work",
        nodeId: "pause-abort-recovery-router",
        reason: "pause-abort-active-work",
        createdAt: new Date().toISOString(),
      },
    }));

    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledTimes(1);
    });
    expect(sendNotification).toHaveBeenCalledWith("failed", expect.objectContaining({ taskId: "FN-7212" }));
    expect(sendNotification).not.toHaveBeenCalledWith("workflow-notify", expect.anything());
    await service.stop();
  });
});
