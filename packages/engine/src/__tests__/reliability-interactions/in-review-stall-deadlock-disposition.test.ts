import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function createStore(task: Task, settings: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  const auditEvents: any[] = [];

  (emitter as any).__auditEvents = auditEvents;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    taskStuckTimeoutMs: 60_000,
    inReviewStallDeadlockThreshold: 3,
    ...settings,
  });
  (emitter as any).listTasks = vi.fn().mockImplementation(async () => [task]);
  (emitter as any).logEntry = vi.fn().mockImplementation(async (_taskId: string, action: string) => {
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date(Date.now()).toISOString(), action });
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
    Object.assign(task, updates);
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => {
    auditEvents.push(event);
  });
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);

  return emitter;
}

describe("reliability interactions: in-review stall deadlock disposition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("FN-4885: auto-disposes repeated merge-blocker stalls once, then no-ops", async () => {
    const task = {
      id: "FN-4860",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: "Failed to create worktree after 3 attempts: Branch fusion/fn-4860 conflict could not be auto-resolved",
      branch: "fusion/fn-4860",
      worktree: "/tmp/missing-fn-4860",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.status).toBe("failed");

    const disposedEntries = task.log.filter((entry: { action: string }) =>
      entry.action.startsWith("In-review stall auto-disposed [merge-blocker]:"),
    );
    expect(disposedEntries).toHaveLength(1);

    const auditEvents = (store as any).__auditEvents as any[];
    const disposeAuditEvents = auditEvents.filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed");
    expect(disposeAuditEvents).toHaveLength(1);

    expect(disposeAuditEvents[0]).toMatchObject({
      domain: "database",
      taskId: "FN-4860",
      target: "FN-4860",
      metadata: expect.objectContaining({
        code: "merge-blocker",
        repetitionCount: 3,
        threshold: 3,
        branch: "fusion/fn-4860",
        worktree: "/tmp/missing-fn-4860",
      }),
    });

    const logCountBeforeFourth = task.log.length;
    const auditCountBeforeFourth = disposeAuditEvents.length;
    const updateCallsBeforeFourth = (store.updateTask as any).mock.calls.length;

    vi.setSystemTime(new Date("2026-01-01T00:16:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);

    expect(task.log).toHaveLength(logCountBeforeFourth);
    expect((store.updateTask as any).mock.calls.length).toBe(updateCallsBeforeFourth);
    const disposeAuditsAfterFourth = ((store as any).__auditEvents as any[]).filter(
      (event) => event.mutationType === "task:in-review-stall-deadlock-disposed",
    );
    expect(disposeAuditsAfterFourth).toHaveLength(auditCountBeforeFourth);

    manager.stop();
  });

  it("does not auto-dispose userPaused tasks with repeated identical stalls", async () => {
    const task = {
      id: "FN-4860-PAUSED",
      column: "in-review",
      paused: false,
      userPaused: true,
      status: "failed",
      error: "Failed to create worktree after 3 attempts: Branch fusion/fn-4860 conflict could not be auto-resolved",
      branch: "fusion/fn-4860-paused",
      worktree: "/tmp/missing-fn-4860-paused",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    await manager.surfaceInReviewStalls();
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    await manager.surfaceInReviewStalls();
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    await manager.surfaceInReviewStalls();

    expect(task.pausedReason).not.toBe("in-review-stall-deadlock");
    expect((store.updateTask as any).mock.calls.length).toBe(0);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed ["))).toBe(false);
    expect(((store as any).__auditEvents as any[]).some((event) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toBe(false);

    manager.stop();
  });
});
