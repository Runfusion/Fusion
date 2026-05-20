import { describe, expect, it } from "vitest";
import { DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS, getStalePausedTodoSignal } from "../stale-paused-todo.js";

const NOW = Date.parse("2026-05-14T12:00:00.000Z");

const baseTask = {
  column: "todo" as const,
  paused: true,
  columnMovedAt: new Date(NOW - DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS).toISOString(),
  updatedAt: new Date(NOW - DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS).toISOString(),
  pausedReason: "manual-hold",
  pausedByAgentId: "agent-1",
};

describe("getStalePausedTodoSignal", () => {
  it("returns signal for paused todo older than threshold", () => {
    const signal = getStalePausedTodoSignal({ ...baseTask }, { now: NOW });
    expect(signal?.code).toBe("stale-paused-todo");
    expect(signal?.ageMs).toBe(DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS);
    expect(signal?.thresholdMs).toBe(DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS);
  });

  it("returns undefined when not paused", () => {
    expect(getStalePausedTodoSignal({ ...baseTask, paused: false }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined for non-todo columns", () => {
    expect(getStalePausedTodoSignal({ ...baseTask, column: "in-progress" }, { now: NOW })).toBeUndefined();
    expect(getStalePausedTodoSignal({ ...baseTask, column: "in-review" }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined when age is under threshold", () => {
    const signal = getStalePausedTodoSignal(
      { ...baseTask, columnMovedAt: new Date(NOW - DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS + 1).toISOString() },
      { now: NOW },
    );
    expect(signal).toBeUndefined();
  });

  it("respects custom threshold override", () => {
    const signal = getStalePausedTodoSignal({ ...baseTask }, { now: NOW, thresholdMs: DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS + 1_000 });
    expect(signal).toBeUndefined();
  });

  it("returns undefined when threshold is zero or negative", () => {
    expect(getStalePausedTodoSignal({ ...baseTask }, { now: NOW, thresholdMs: 0 })).toBeUndefined();
    expect(getStalePausedTodoSignal({ ...baseTask }, { now: NOW, thresholdMs: -1 })).toBeUndefined();
  });
});
