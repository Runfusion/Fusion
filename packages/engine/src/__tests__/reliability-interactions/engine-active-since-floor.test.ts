import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import { StuckTaskDetector } from "../../healing/stuck-task-detector.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5223-RI",
    title: "t",
    description: "d",
    column: "in-review",
    paused: false,
    status: undefined,
    steps: [{ name: "s", status: "done" as const }],
    workflowStepResults: [],
    dependencies: [],
    log: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(tasks: Task[], settingsOverrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    inReviewStalledThresholdMs: 60_000,
    stalePausedReviewThresholdMs: 60_000,
    stalePausedTodoThresholdMs: 60_000,
    taskStuckTimeoutMs: 60_000,
    engineActivationGraceMs: 300_000,
    ...settingsOverrides,
  });
  (emitter as any).updateSettings = vi.fn().mockImplementation(async (patch: Record<string, unknown>) => {
    const current = await (emitter as any).getSettings();
    (emitter as any).getSettings = vi.fn().mockResolvedValue({ ...current, ...patch });
  });
  (emitter as any).listTasks = vi.fn().mockImplementation(async ({ column }: { column?: string } = {}) => {
    if (!column) return tasks;
    return tasks.filter((t) => t.column === column);
  });
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).updateTask = vi.fn().mockImplementation(async (taskId: string, updates: Partial<Task>) => {
    const task = tasks.find((t) => t.id === taskId);
    if (task) Object.assign(task, updates);
    return task;
  });
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

describe("FN-5223 reliability interactions: engineActiveSince floor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("FN-5223 suppresses in-review stalled signal immediately after activation and restores after grace+threshold", async () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    vi.setSystemTime(now);
    const task = makeTask({ id: "FN-5223-Q1" });
    const store = createStore([task], { engineActiveSinceMs: now.getTime() });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.surfaceInReviewStalled()).toBe(0);

    vi.setSystemTime(new Date(now.getTime() + 7 * 60_000));
    expect(await manager.surfaceInReviewStalled()).toBe(1);
    manager.stop();
  });

  it("FN-5223 pause/unpause stamping prevents immediate stale paused review surfacing", async () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    vi.setSystemTime(now);
    const task = makeTask({ id: "FN-5223-Q2", paused: true });
    const store = createStore([task], { engineActiveSinceMs: now.getTime() });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    await (store as any).updateSettings({ globalPause: true });
    await (store as any).updateSettings({ globalPause: false, engineActiveSinceMs: Date.now() });

    expect(await manager.surfaceStalePausedReviews()).toBe(0);
    manager.stop();
  });

  it("FN-5223 composes with globalPause/enginePaused cycle gate", async () => {
    vi.setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
    const task = makeTask({ id: "FN-5223-Q3" });
    const store = createStore([task], { globalPause: true, engineActiveSinceMs: Date.now() - 60_000 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.surfaceInReviewStalled()).toBe(0);
    manager.stop();
  });

  it("FN-5223 grace 0 disables warmup", async () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    vi.setSystemTime(now);
    const task = makeTask({ id: "FN-5223-Q4" });
    const store = createStore([task], {
      inReviewStalledThresholdMs: 1,
      engineActivationGraceMs: 0,
      engineActiveSinceMs: now.getTime() - 10_000,
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.surfaceInReviewStalled()).toBe(1);
    manager.stop();
  });

  it("FN-5223 stuck detector resume hook refreshes tracked timestamps independent of persisted clock", async () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    vi.setSystemTime(now);
    const store = createStore([]);
    const detector = new StuckTaskDetector(store);
    const session = { dispose: vi.fn() };

    detector.trackTask("FN-5223-Q5", session);
    const trackedBeforePause = (detector as any).tracked.get("FN-5223-Q5");
    expect(trackedBeforePause.lastActivity).toBe(now.getTime());

    detector.pause();
    vi.setSystemTime(new Date(now.getTime() + 2 * 60_000));
    detector.resume();

    const trackedAfterResume = (detector as any).tracked.get("FN-5223-Q5");
    expect(trackedAfterResume.lastActivity).toBe(now.getTime() + 2 * 60_000);
    expect(trackedAfterResume.lastProgressAt).toBe(now.getTime() + 2 * 60_000);
    expect(trackedAfterResume.activitySinceProgress).toBe(0);
  });
});
