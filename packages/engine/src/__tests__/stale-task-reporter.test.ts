import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { StaleTaskReporter } from "../stale-task-reporter.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    description: "test",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    paused: false,
    log: [],
    updatedAt: "2026-05-14T00:00:00.000Z",
    createdAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(taskSets: { inProgress?: Task[]; inReview?: Task[] } = {}, settings: Record<string, unknown> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    listTasks: vi.fn().mockImplementation(async ({ column }) => {
      if (column === "in-progress") return taskSets.inProgress ?? [];
      if (column === "in-review") return taskSets.inReview ?? [];
      return [];
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("StaleTaskReporter", () => {
  it("no-ops under threshold", async () => {
    const now = Date.parse("2026-05-14T08:00:00.000Z");
    const store = createStore({
      inProgress: [createTask({ columnMovedAt: new Date(now - 60_000).toISOString() })],
    }, { staleInProgressWarningMs: 4 * 60 * 60_000, staleInProgressCriticalMs: 24 * 60 * 60_000 });
    const reporter = new StaleTaskReporter({ store, now: () => now });
    const result = await reporter.report();
    expect(result.surfaced).toBe(0);
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("emits warning once and rate-limits repeat within window", async () => {
    const now = Date.parse("2026-05-14T08:00:00.000Z");
    const task = createTask({ columnMovedAt: new Date(now - 5 * 60 * 60_000).toISOString() });
    const store = createStore({ inProgress: [task] }, { staleInProgressWarningMs: 4 * 60 * 60_000, staleInProgressCriticalMs: 24 * 60 * 60_000 });
    const reporter = new StaleTaskReporter({ store, now: () => now });

    expect((await reporter.report()).surfaced).toBe(1);
    task.log.push({ timestamp: new Date(now).toISOString(), action: "Stale task age threshold crossed [warning]: column=in-progress paused=false ageMs=1 warningThresholdMs=1 criticalThresholdMs=1" });
    expect((await reporter.report()).surfaced).toBe(0);
  });

  it("emits on warning->critical and critical->warning level changes", async () => {
    const now = Date.parse("2026-05-14T12:00:00.000Z");
    const task = createTask({
      columnMovedAt: new Date(now - 30 * 60 * 60_000).toISOString(),
      log: [{ timestamp: new Date(now - 60_000).toISOString(), action: "Stale task age threshold crossed [warning]: x" }],
    });
    const store = createStore({ inProgress: [task] }, { staleInProgressWarningMs: 4 * 60 * 60_000, staleInProgressCriticalMs: 24 * 60 * 60_000 });
    const reporter = new StaleTaskReporter({ store, now: () => now });
    expect((await reporter.report()).surfaced).toBe(1);

    task.columnMovedAt = new Date(now - 6 * 60 * 60_000).toISOString();
    task.log = [{ timestamp: new Date(now - 60_000).toISOString(), action: "Stale task age threshold crossed [critical]: x" }];
    expect((await reporter.report()).surfaced).toBe(1);
  });

  it("skips merge-confirmed and recently-updated tasks", async () => {
    const now = Date.parse("2026-05-14T12:00:00.000Z");
    const store = createStore({
      inProgress: [createTask({ columnMovedAt: new Date(now - 30 * 60 * 60_000).toISOString(), mergeDetails: { mergeConfirmed: true } })],
      inReview: [createTask({ id: "FN-2", column: "in-review", columnMovedAt: new Date(now - 30 * 60 * 60_000).toISOString(), updatedAt: new Date(now).toISOString() })],
    }, { staleInProgressWarningMs: 4 * 60 * 60_000, staleInProgressCriticalMs: 24 * 60 * 60_000, staleInReviewWarningMs: 24 * 60 * 60_000, staleInReviewCriticalMs: 3 * 24 * 60 * 60_000 });
    const reporter = new StaleTaskReporter({ store, now: () => now });
    expect((await reporter.report()).surfaced).toBe(0);
  });

  it("returns zero and skips scans when all thresholds disabled", async () => {
    const store = createStore({}, { staleInProgressWarningMs: 0, staleInProgressCriticalMs: 0, staleInReviewWarningMs: 0, staleInReviewCriticalMs: 0 });
    const reporter = new StaleTaskReporter({ store });
    const result = await reporter.report();
    expect(result.surfaced).toBe(0);
    expect(store.listTasks).not.toHaveBeenCalled();
  });
});
