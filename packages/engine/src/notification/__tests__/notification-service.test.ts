import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationPayload, NotificationProvider, Settings, Task } from "@fusion/core";
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

  it("FN-5627: suppresses notification for transient lease-handoff-target-not-queued failures", async () => {
    const { store, service, sendNotification } = await setup();
    store.setTask(task({
      id: "FN-5628",
      status: "failed",
      error: "Merge handoff refused (lease-handoff-failed): target-not-queued",
    }));
    store.emit("task:updated", task({
      id: "FN-5628",
      status: "failed",
      error: "Merge handoff refused (lease-handoff-failed): target-not-queued",
    }));

    await vi.advanceTimersByTimeAsync(500);

    expect(sendNotification).not.toHaveBeenCalled();
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    await service.stop();
  });

  it("FN-5627: suppresses notification for transient same-SHA spurious-concurrent-advance failures", async () => {
    const { store, service, sendNotification } = await setup();
    const transientError = "Integration branch main advanced concurrently (expected 694970b2f186fac31c1819d55ef30a2ad207b5c3, observed 694970b2f186fac31c1819d55ef30a2ad207b5c3) while applying b26f8fe1ee2d3dc36acf3571d42507b24bd8066b for FN-5626";
    store.setTask(task({ id: "FN-5626", status: "failed", error: transientError }));
    store.emit("task:updated", task({ id: "FN-5626", status: "failed", error: transientError }));

    await vi.advanceTimersByTimeAsync(500);

    expect(sendNotification).not.toHaveBeenCalled();
    expect(service.getMetrics().failureNotificationSuppressedCount).toBe(1);
    await service.stop();
  });

  it("FN-5627: still dispatches notification for genuine concurrent-advance failures (different SHAs)", async () => {
    const { store, service, sendNotification } = await setup();
    const genuineError = "Integration branch main advanced concurrently (expected aaa1111aaa1111aaa1111aaa1111aaa1111aaaa, observed bbb2222bbb2222bbb2222bbb2222bbb2222bbbb) while applying ccc3333ccc3333ccc3333ccc3333ccc3333cccc for FN-genuine";
    store.setTask(task({ id: "FN-genuine", status: "failed", error: genuineError }));
    store.emit("task:updated", task({ id: "FN-genuine", status: "failed", error: genuineError }));

    await vi.advanceTimersByTimeAsync(500);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith("failed", expect.objectContaining({ taskId: "FN-genuine" }));
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
    await Promise.resolve();

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

    await Promise.resolve();

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
      log: [{ timestamp: new Date().toISOString(), action: "Workflow graph failed at node 'review' with incomplete steps - moved back to todo for execution resume" }],
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
          notificationDedupeKey: "workflow-transition:FN-7203:recovery-requeue",
          notificationKind: "workflow_recovery_requeue",
        }),
      }),
    );
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
});
