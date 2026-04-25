import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isTaskStuck, countStuckTasks } from "../taskStuck";
import type { Task } from "@fusion/core";

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "FN-001",
    description: "Test task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    columnMovedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }) as Task;

describe("isTaskStuck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when timeout is undefined (disabled)", () => {
    const task = createTask({ updatedAt: "2026-04-04T06:00:00Z" });
    expect(isTaskStuck(task, undefined)).toBe(false);
  });

  it("returns false when timeout is 0", () => {
    const task = createTask({ updatedAt: "2026-04-04T06:00:00Z" });
    expect(isTaskStuck(task, 0)).toBe(false);
  });

  it("returns false when timeout is negative", () => {
    const task = createTask({ updatedAt: "2026-04-04T06:00:00Z" });
    expect(isTaskStuck(task, -1)).toBe(false);
  });

  it("returns false for non-in-progress tasks", () => {
    const task = createTask({ column: "todo", updatedAt: "2026-04-04T06:00:00Z" });
    expect(isTaskStuck(task, 600000)).toBe(false);
  });

  it("returns false for failed in-progress tasks", () => {
    const stale = new Date(Date.now() - 600001).toISOString();
    const task = createTask({ status: "failed", updatedAt: stale });
    expect(isTaskStuck(task, 600000)).toBe(false);
  });

  it("returns false for stuck-killed in-progress tasks", () => {
    const stale = new Date(Date.now() - 600001).toISOString();
    const task = createTask({ status: "stuck-killed", updatedAt: stale });
    expect(isTaskStuck(task, 600000)).toBe(false);
  });

  it("returns false for recent in-progress tasks within timeout", () => {
    const recent = new Date(Date.now() - 300000).toISOString(); // 5 minutes ago
    const task = createTask({ updatedAt: recent });
    expect(isTaskStuck(task, 600000)).toBe(false); // 10 minute timeout
  });

  it("returns true for stale in-progress tasks exceeding timeout", () => {
    const stale = new Date(Date.now() - 600001).toISOString(); // just over 10 minutes
    const task = createTask({ updatedAt: stale });
    expect(isTaskStuck(task, 600000)).toBe(true);
  });

  it("returns false for malformed updatedAt", () => {
    const task = createTask({ updatedAt: "not-a-date" });
    expect(isTaskStuck(task, 600000)).toBe(false);
  });

  it("returns false for empty updatedAt", () => {
    const task = createTask({ updatedAt: "" });
    expect(isTaskStuck(task, 600000)).toBe(false);
  });

  it("handles tasks in triage column", () => {
    const stale = new Date(Date.now() - 600001).toISOString();
    const task = createTask({ column: "triage", updatedAt: stale });
    expect(isTaskStuck(task, 600000)).toBe(false);
  });

  it("handles tasks in done column", () => {
    const stale = new Date(Date.now() - 600001).toISOString();
    const task = createTask({ column: "done", updatedAt: stale });
    expect(isTaskStuck(task, 600000)).toBe(false);
  });

  it("returns true exactly at timeout boundary (greater than)", () => {
    const boundary = new Date(Date.now() - 600001).toISOString();
    const task = createTask({ updatedAt: boundary });
    expect(isTaskStuck(task, 600000)).toBe(true);
  });

  it("returns false exactly at timeout boundary (equal)", () => {
    const boundary = new Date(Date.now() - 600000).toISOString();
    const task = createTask({ updatedAt: boundary });
    expect(isTaskStuck(task, 600000)).toBe(false);
  });

  describe("dataAsOfMs parameter (freshness-aware stuck detection)", () => {
    it("uses dataAsOfMs instead of Date.now() when provided", () => {
      // Task updatedAt is 11 minutes ago
      const taskUpdatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const task = createTask({ updatedAt: taskUpdatedAt });

      // dataAsOfMs is 5 minutes ago (task was fresh 5 minutes ago)
      const dataAsOfMs = Date.now() - 5 * 60 * 1000;

      // 10 minute timeout
      // With dataAsOfMs: 5 min - 11 min = -6 min < 10 min → NOT stuck
      // Without dataAsOfMs: 0 min - 11 min = -11 min > 10 min → stuck
      expect(isTaskStuck(task, 600000, dataAsOfMs)).toBe(false);
    });

    it("falls back to Date.now() when dataAsOfMs is undefined", () => {
      // Task updatedAt is 5 minutes ago
      const taskUpdatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const task = createTask({ updatedAt: taskUpdatedAt });

      // Without dataAsOfMs, should use Date.now() → NOT stuck (within 10 min timeout)
      expect(isTaskStuck(task, 600000)).toBe(false);
    });

    it("correctly identifies a task that would be stuck with Date.now() but not with dataAsOfMs", () => {
      // Scenario: Tab was in background for 20 minutes
      // Task was updated 10 minutes ago (relative to dataAsOfMs)
      // dataAsOfMs represents "10 minutes ago" (when we fetched fresh data)
      // Date.now() is "now" (20 minutes after the fetch)
      //
      // This simulates the background tab scenario:
      // - User opened tab at T=0, fetched tasks
      // - Tab went to background at T=0
      // - User came back at T=20
      // - dataAsOfMs = T=0 (when we last had fresh data)
      // - Task was updated at T=-10 (10 minutes before fetch)
      // - task.updatedAt represents T=-10
      //
      // Check: dataAsOfMs - updatedAt = 0 - (-10) = 10 min < 10 min timeout → NOT stuck
      // Without dataAsOfMs: Date.now() - updatedAt = 20 - (-10) = 30 min > 10 min → STUCK (false positive!)

      // In fake timers, we set Date.now() to a fixed point
      // Let's say Date.now() = 1000 (representing "now")
      // dataAsOfMs = 0 (representing 20 minutes before "now" in fake time)
      // task.updatedAt = -600 (representing 10 minutes before dataAsOfMs)

      vi.setSystemTime(new Date(1000)); // Date.now() = 1000
      const dataAsOfMs = 0; // 20 minutes before Date.now() in this scenario
      const taskUpdatedAt = new Date(-600000).toISOString(); // 10 minutes before dataAsOfMs
      const task = createTask({ updatedAt: taskUpdatedAt });

      // With dataAsOfMs: 0 - (-600000) = 600000ms = 10 min = timeout → NOT stuck (boundary)
      // Without dataAsOfMs: 1000 - (-600000) = 601000ms > 10 min → STUCK
      // The key test: with dataAsOfMs it should NOT be stuck even though Date.now() would say it is
      expect(isTaskStuck(task, 600000, dataAsOfMs)).toBe(false);
    });

    it("prevents false positive when tab was in background", () => {
      // Simulate: Tab in background, data fetched 15 min ago
      // Task.updatedAt is 12 min ago (stale from server perspective)
      // taskStuckTimeoutMs = 10 min
      // With fresh data (15 min ago): 15 - 12 = 3 min < 10 min → NOT stuck
      // With stale Date.now(): 0 - 12 = 12 min > 10 min → STUCK (FALSE POSITIVE)

      vi.setSystemTime(new Date(0)); // Date.now() = 0
      const dataAsOfMs = -900000; // 15 minutes ago (in fake time)
      const taskUpdatedAt = new Date(-720000).toISOString(); // 12 minutes ago (in fake time)
      const task = createTask({ updatedAt: taskUpdatedAt });

      // With dataAsOfMs: -900000 - (-720000) = -180000ms = -3 min < 10 min → NOT stuck
      // Without dataAsOfMs: 0 - (-720000) = 720000ms = 12 min > 10 min → STUCK
      expect(isTaskStuck(task, 600000, dataAsOfMs)).toBe(false);
    });

    it("correctly identifies genuinely stuck tasks even with dataAsOfMs", () => {
      // Task really is stuck: updatedAt is 15 min ago, timeout is 10 min
      // With dataAsOfMs of 2 min ago: 2 - 15 = -13 min < 10 min → NOT stuck (hmm, this is a problem)

      // Actually, dataAsOfMs should represent when we last got FRESH data from the server
      // If dataAsOfMs = 2 min ago and task.updatedAt = 15 min ago, the task was stale
      // even when we fetched it, because 2 - 15 = -13 min > 10 min timeout

      vi.setSystemTime(new Date(0));
      const dataAsOfMs = -120000; // 2 minutes ago
      const taskUpdatedAt = new Date(-900000).toISOString(); // 15 minutes ago
      const task = createTask({ updatedAt: taskUpdatedAt });

      // With dataAsOfMs: -120000 - (-900000) = 780000ms = 13 min > 10 min → STUCK
      expect(isTaskStuck(task, 600000, dataAsOfMs)).toBe(true);
    });
  });
});

describe("countStuckTasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 0 when timeout is undefined", () => {
    const stale = new Date(Date.now() - 600001).toISOString();
    const tasks = [createTask({ updatedAt: stale })];
    expect(countStuckTasks(tasks, undefined)).toBe(0);
  });

  it("returns 0 when timeout is 0", () => {
    const stale = new Date(Date.now() - 600001).toISOString();
    const tasks = [createTask({ updatedAt: stale })];
    expect(countStuckTasks(tasks, 0)).toBe(0);
  });

  it("counts only stuck tasks", () => {
    const stale = new Date(Date.now() - 600001).toISOString();
    const recent = new Date(Date.now() - 300000).toISOString();
    const tasks = [
      createTask({ id: "FN-001", updatedAt: stale }), // stuck
      createTask({ id: "FN-002", updatedAt: recent }), // not stuck
      createTask({ id: "FN-004", status: "failed", updatedAt: stale }), // terminal status
      createTask({ id: "FN-003", column: "todo", updatedAt: stale }), // not in-progress
    ];
    expect(countStuckTasks(tasks, 600000)).toBe(1);
  });

  it("returns 0 for empty task list", () => {
    expect(countStuckTasks([], 600000)).toBe(0);
  });

  it("counts multiple stuck tasks", () => {
    const stale = new Date(Date.now() - 600001).toISOString();
    const tasks = [
      createTask({ id: "FN-001", updatedAt: stale }),
      createTask({ id: "FN-002", updatedAt: stale }),
    ];
    expect(countStuckTasks(tasks, 600000)).toBe(2);
  });

  describe("dataAsOfMs parameter (freshness-aware stuck detection)", () => {
    it("passes dataAsOfMs through to isTaskStuck", () => {
      // Task would be stuck with Date.now() but not with dataAsOfMs
      vi.setSystemTime(new Date(0));
      const dataAsOfMs = -900000; // 15 minutes ago
      const taskUpdatedAt = new Date(-720000).toISOString(); // 12 minutes ago
      const tasks = [createTask({ updatedAt: taskUpdatedAt })];

      // With dataAsOfMs: -900000 - (-720000) = -180000ms = -3 min < 10 min → NOT stuck
      expect(countStuckTasks(tasks, 600000, dataAsOfMs)).toBe(0);
    });

    it("counts tasks that are genuinely stuck even with dataAsOfMs", () => {
      vi.setSystemTime(new Date(0));
      const dataAsOfMs = -120000; // 2 minutes ago
      const taskUpdatedAt = new Date(-900000).toISOString(); // 15 minutes ago
      const tasks = [createTask({ updatedAt: taskUpdatedAt })];

      // With dataAsOfMs: -120000 - (-900000) = 780000ms = 13 min > 10 min → STUCK
      expect(countStuckTasks(tasks, 600000, dataAsOfMs)).toBe(1);
    });
  });
});
