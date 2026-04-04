import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isTaskStuck, countStuckTasks } from "./taskStuck";
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
});
