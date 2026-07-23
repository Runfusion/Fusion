import { describe, expect, it, vi } from "vitest";
import type { NotificationProvider, Settings, Task } from "@fusion/core";
import { NotificationService } from "../notification-service.js";
import { describeSelfHealingNoActionWedge, describeTaskWedge } from "../task-wedge-notification.js";

type Listener = (task: Task) => void;
function fixture() {
  const listeners = new Set<Listener>();
  let wedge: Task["wedgeNotification"];
  const store = {
    getSettings: async () => ({ ntfyEnabled: true, ntfyTopic: "test" }) as Settings,
    on: (event: string, listener: Listener) => { if (event === "task:updated") listeners.add(listener); },
    off: () => undefined,
    emit: (task: Task) => listeners.forEach((listener) => listener(task)),
    claimTaskWedgeNotificationEpisode: async (taskId: string, reasonKey: string | null) => {
      if (reasonKey === null) {
        if (wedge?.status === "active") wedge = { ...wedge, status: "resolved" };
        return { claimed: false };
      }
      if (wedge?.status === "active" && wedge.reasonKey === reasonKey) return { claimed: false };
      wedge = { reasonKey, episodeId: `${taskId}-${reasonKey}-${Date.now()}`, status: "active", transitionedAt: new Date().toISOString() };
      return { claimed: true, episodeId: wedge.episodeId };
    },
  };
  const sendMessageOnce = vi.fn(async (_input: unknown, _key: string) => ({ message: {} as any, inserted: true }));
  const service = new NotificationService(store as any, { messageStore: { on: () => undefined, sendMessageOnce } as any, failedNotificationGraceMs: 60_000 });
  const sendNotification = vi.fn(async () => ({ success: true, providerId: "test" }));
  const provider: NotificationProvider = { getProviderId: () => "test", isEventSupported: () => true, sendNotification };
  service.registerProvider(provider);
  const task = (overrides: Partial<Task> = {}): Task => ({ id: "FN-8501", title: "Fix changeset", description: "", column: "in-review", status: "failed", error: "merge verification failed: check:changeset-format", dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-07-22T12:00:00.000Z", updatedAt: "2026-07-22T12:00:00.000Z", ...overrides } as Task);
  return { store, service, sendMessageOnce, sendNotification, task, getWedge: () => wedge };
}

describe("task wedge notifications", () => {
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

  it("does not re-deliver an unchanged durable episode after service restart", async () => {
    const { store, service, sendNotification, sendMessageOnce, task } = fixture();
    await service.start();
    store.emit(task());
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    await service.stop();

    const restarted = new NotificationService(store as any, { messageStore: { on: () => undefined, sendMessageOnce } as any });
    restarted.registerProvider({ getProviderId: () => "restarted", isEventSupported: () => true, sendNotification });
    await restarted.start();
    store.emit(task({ updatedAt: "2026-07-22T12:01:00.000Z" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await restarted.stop();
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
});
