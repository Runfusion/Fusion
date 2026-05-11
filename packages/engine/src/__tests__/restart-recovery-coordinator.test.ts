import { describe, expect, it, vi } from "vitest";
import type { TaskStore, Task } from "@fusion/core";
import {
  RestartRecoveryCoordinator,
  isMissingWorktreeSessionStartFailure,
  isRecoverableMissingWorktreeReviewFailure,
} from "../restart-recovery-coordinator.js";

function createTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-1",
    description: "test",
    column: "in-progress",
    priority: "normal",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
    log: [],
    dependencies: [],
    attachments: [],
    ...overrides,
  } as Task;
}

describe("RestartRecoveryCoordinator", () => {
  it("classifies missing-worktree session-start failures narrowly", () => {
    expect(isMissingWorktreeSessionStartFailure("Refusing to start coding agent in missing worktree: /tmp/wt")).toBe(true);
    expect(isMissingWorktreeSessionStartFailure("Refusing to start coding agent in incomplete worktree: /tmp/wt")).toBe(false);
    expect(isMissingWorktreeSessionStartFailure("Deterministic test verification failed")).toBe(false);
  });

  it("identifies recoverable in-review missing-worktree failures with step progress", () => {
    const task = createTask({
      column: "in-review",
      paused: false,
      status: "failed",
      error: "Refusing to start coding agent in missing worktree: /tmp/wt",
      steps: [{ id: "s1", title: "step", status: "done" }] as any,
    });
    expect(isRecoverableMissingWorktreeReviewFailure(task)).toBe(true);
    expect(isRecoverableMissingWorktreeReviewFailure({ ...task, paused: true })).toBe(false);
    expect(isRecoverableMissingWorktreeReviewFailure({ ...task, error: "other" })).toBe(false);
    expect(isRecoverableMissingWorktreeReviewFailure({ ...task, steps: [{ id: "s2", title: "y", status: "pending" }] as any })).toBe(false);
  });

  it("requeues interrupted failed tasks with no progress, then resumes remaining orphans", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([
        createTask({ id: "FN-1", status: "failed", error: "Agent finished without calling fn_task_done", steps: [] }),
        createTask({ id: "FN-2", steps: [{ id: "s1", title: "x", status: "done" }] as any }),
      ]),
      updateTask: vi.fn().mockResolvedValue({}),
      logEntry: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;

    const executor = {
      resumeOrphaned: vi.fn().mockResolvedValue(undefined),
    } as any;

    const coordinator = new RestartRecoveryCoordinator(store, executor);
    await coordinator.recoverInterruptedRuns();

    expect(store.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({ status: "stuck-killed" }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo");
    expect(executor.resumeOrphaned).toHaveBeenCalledTimes(1);
  });

  it("does not requeue when step progress exists", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([
        createTask({
          id: "FN-9",
          status: "failed",
          error: "Agent finished without calling fn_task_done",
          steps: [{ id: "s1", title: "x", status: "in-progress" }] as any,
        }),
      ]),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      moveTask: vi.fn(),
    } as unknown as TaskStore;

    const executor = { resumeOrphaned: vi.fn().mockResolvedValue(undefined) } as any;
    const coordinator = new RestartRecoveryCoordinator(store, executor);
    await coordinator.recoverInterruptedRuns();

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(executor.resumeOrphaned).toHaveBeenCalledTimes(1);
  });
});
