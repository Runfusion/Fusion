import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { hasPendingAutomaticRecovery, isTaskManuallyRetryable } from "../taskRecovery";

const nowMs = Date.parse("2026-07-16T12:00:00.000Z");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8167",
    title: "Recovery fixture",
    description: "",
    column: "todo",
    steps: [],
    dependencies: [],
    status: undefined,
    ...overrides,
  } as Task;
}

describe("task recovery presentation", () => {
  it("recognizes only finite strictly-future recovery schedules as pending", () => {
    expect(hasPendingAutomaticRecovery(makeTask({ nextRecoveryAt: new Date(nowMs + 1).toISOString() }), nowMs)).toBe(true);
    expect(hasPendingAutomaticRecovery(makeTask({ nextRecoveryAt: new Date(nowMs).toISOString() }), nowMs)).toBe(false);
    expect(hasPendingAutomaticRecovery(makeTask({ nextRecoveryAt: new Date(nowMs - 1).toISOString() }), nowMs)).toBe(false);
    expect(hasPendingAutomaticRecovery(makeTask({ nextRecoveryAt: "not-a-date" }), nowMs)).toBe(false);
    expect(hasPendingAutomaticRecovery(makeTask({ nextRecoveryAt: null }), nowMs)).toBe(false);
  });

  it("suppresses manual retry for future automatic recovery in active columns", () => {
    for (const column of ["todo", "in-progress"] as const) {
      const task = makeTask({
        column,
        recoveryRetryCount: 1,
        nextRecoveryAt: new Date(nowMs + 60_000).toISOString(),
      });
      expect(hasPendingAutomaticRecovery(task, nowMs), column).toBe(true);
      expect(isTaskManuallyRetryable(task, nowMs), column).toBe(false);
    }
  });

  it("lets a future schedule win over a defensive stale failed status", () => {
    const task = makeTask({
      status: "failed",
      recoveryRetryCount: 1,
      nextRecoveryAt: new Date(nowMs + 60_000).toISOString(),
    });

    expect(hasPendingAutomaticRecovery(task, nowMs)).toBe(true);
    expect(isTaskManuallyRetryable(task, nowMs)).toBe(false);
  });

  it("falls back to terminal retry states after recovery is elapsed or unscheduled", () => {
    expect(isTaskManuallyRetryable(makeTask({
      status: "failed",
      recoveryRetryCount: 1,
      nextRecoveryAt: new Date(nowMs - 60_000).toISOString(),
    }), nowMs)).toBe(true);
    expect(isTaskManuallyRetryable(makeTask({ status: "failed", recoveryRetryCount: 1 }), nowMs)).toBe(true);
    expect(isTaskManuallyRetryable(makeTask({ status: "failed", recoveryRetryCount: null, nextRecoveryAt: null }), nowMs)).toBe(true);
  });

  it("keeps established terminal retry states retryable without a pending schedule", () => {
    for (const task of [
      makeTask({ status: "stuck-killed" }),
      makeTask({ status: "needs-replan" }),
      makeTask({ status: "planning" }),
      makeTask({ stuckKillCount: 1 }),
    ]) {
      expect(isTaskManuallyRetryable(task, nowMs)).toBe(true);
    }
  });

  it("never infers retryability for done or archived tasks without terminal state", () => {
    expect(isTaskManuallyRetryable(makeTask({ column: "done" }), nowMs)).toBe(false);
    expect(isTaskManuallyRetryable(makeTask({ column: "archived" }), nowMs)).toBe(false);
  });
});
