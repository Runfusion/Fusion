import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task } from "@fusion/core";
import {
  TODO_AGING_THRESHOLDS_MS,
  getTodoAgeBucket,
  getTodoAgeMs,
  summarizeTodoAging,
} from "../todoAging";

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "FN-001",
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    columnMovedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }) as Task;

describe("todoAging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { ageMs: 0, expected: "fresh" },
    { ageMs: TODO_AGING_THRESHOLDS_MS.aging - 1, expected: "fresh" },
    { ageMs: TODO_AGING_THRESHOLDS_MS.aging, expected: "fresh" },
    { ageMs: TODO_AGING_THRESHOLDS_MS.aging + 1, expected: "aging" },
    { ageMs: TODO_AGING_THRESHOLDS_MS.stale, expected: "aging" },
    { ageMs: TODO_AGING_THRESHOLDS_MS.stale + 1, expected: "stale" },
    { ageMs: 90 * 24 * 60 * 60 * 1000, expected: "stale" },
  ])("maps age $ageMs to $expected", ({ ageMs, expected }) => {
    const task = createTask({ columnMovedAt: new Date(Date.now() - ageMs).toISOString() });
    expect(getTodoAgeBucket(task)).toBe(expected);
  });

  it("returns undefined for non-todo tasks", () => {
    expect(getTodoAgeBucket(createTask({ column: "in-progress" }))).toBeUndefined();
  });

  it("falls back from columnMovedAt to createdAt to updatedAt", () => {
    const createdFallback = createTask({
      columnMovedAt: undefined,
      createdAt: new Date(Date.now() - (TODO_AGING_THRESHOLDS_MS.aging + 1)).toISOString(),
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(getTodoAgeBucket(createdFallback)).toBe("aging");

    const updatedFallback = createTask({
      columnMovedAt: undefined,
      createdAt: "",
      updatedAt: new Date(Date.now() - (TODO_AGING_THRESHOLDS_MS.stale + 1)).toISOString(),
    });
    expect(getTodoAgeBucket(updatedFallback)).toBe("stale");

    const missingAll = createTask({ columnMovedAt: undefined, createdAt: "", updatedAt: "" });
    expect(getTodoAgeBucket(missingAll)).toBeUndefined();
  });

  it("summarizeTodoAging counts only todo tasks and returns total", () => {
    const tasks = [
      createTask({ id: "FN-1", columnMovedAt: new Date(Date.now() - 1000).toISOString() }),
      createTask({ id: "FN-2", columnMovedAt: new Date(Date.now() - (TODO_AGING_THRESHOLDS_MS.aging + 1)).toISOString() }),
      createTask({ id: "FN-3", columnMovedAt: new Date(Date.now() - (TODO_AGING_THRESHOLDS_MS.stale + 1)).toISOString() }),
      createTask({ id: "FN-4", column: "done" }),
    ];

    expect(summarizeTodoAging(tasks)).toEqual({
      fresh: 1,
      aging: 1,
      stale: 1,
      total: 3,
    });
  });

  it("uses dataAsOfMs for freshness-aware age calculation", () => {
    vi.setSystemTime(new Date(1000));
    const task = createTask({ columnMovedAt: new Date(-8 * 24 * 60 * 60 * 1000).toISOString() });
    const dataAsOfMs = -2 * 24 * 60 * 60 * 1000;

    expect(getTodoAgeMs(task, dataAsOfMs)).toBe(6 * 24 * 60 * 60 * 1000);
    expect(getTodoAgeBucket(task, dataAsOfMs)).toBe("fresh");
    expect(getTodoAgeBucket(task)).toBe("aging");
  });

  it("returns undefined for malformed timestamps", () => {
    const task = createTask({ columnMovedAt: "not-a-date", createdAt: "also-not-a-date", updatedAt: "" });
    expect(getTodoAgeMs(task)).toBeUndefined();
    expect(getTodoAgeBucket(task)).toBeUndefined();
  });
});
