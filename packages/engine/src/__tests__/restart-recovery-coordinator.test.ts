import { describe, expect, it, vi } from "vitest";
import type { TaskStore, Task } from "@fusion/core";
import {
  RestartRecoveryCoordinator,
  extractMissingWorktreePathFromSessionStartFailure,
  isMissingWorktreeSessionStartFailure,
  isMergeActiveMissingWorktreeSessionStartFailure,
  isRecoverableMissingWorktreeReviewFailure,
  isRecoverableMissingWorktreeReviewFailureNoProgress,
  isRecoverableMissingWorktreeReviewFailureWithProgress,
} from "../healing/restart-recovery-coordinator.js";

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
  it("classifies missing-worktree session-start failures across all assertValidWorktreeSession variants", () => {
    expect(isMissingWorktreeSessionStartFailure("Refusing to start coding agent in missing worktree: /tmp/wt")).toBe(true);
    expect(isMissingWorktreeSessionStartFailure("Refusing to start coding agent in incomplete worktree: /tmp/wt")).toBe(true);
    expect(isMissingWorktreeSessionStartFailure("Refusing to start coding agent in unregistered git worktree: /tmp/wt")).toBe(true);

    expect(isMissingWorktreeSessionStartFailure("Deterministic test verification failed")).toBe(false);
    expect(isMissingWorktreeSessionStartFailure("")).toBe(false);
    expect(isMissingWorktreeSessionStartFailure(null)).toBe(false);
    expect(isMissingWorktreeSessionStartFailure(undefined)).toBe(false);
    expect(isMissingWorktreeSessionStartFailure({ message: "Refusing to start coding agent in missing worktree: /tmp/wt" })).toBe(false);
  });

  it("extracts missing-worktree path from every session-start failure variant", () => {
    expect(extractMissingWorktreePathFromSessionStartFailure("Refusing to start coding agent in missing worktree: /tmp/wt")).toBe("/tmp/wt");
    expect(extractMissingWorktreePathFromSessionStartFailure("Refusing to start coding agent in incomplete worktree: /tmp/wt")).toBe("/tmp/wt");
    expect(extractMissingWorktreePathFromSessionStartFailure("Refusing to start coding agent in unregistered git worktree: /tmp/wt")).toBe("/tmp/wt");
    expect(extractMissingWorktreePathFromSessionStartFailure("other error")).toBeNull();
    expect(extractMissingWorktreePathFromSessionStartFailure("Refusing to start coding agent in incomplete worktree:")).toBeNull();
  });

  it("identifies recoverable in-review missing-worktree failures with and without step progress", () => {
    const baseTask = createTask({
      column: "in-review",
      paused: false,
      status: "failed",
      steps: [{ id: "s1", title: "step", status: "done" }] as any,
    });

    expect(isRecoverableMissingWorktreeReviewFailure({ ...baseTask, error: "Refusing to start coding agent in missing worktree: /tmp/wt" })).toBe(true);
    expect(isRecoverableMissingWorktreeReviewFailure({ ...baseTask, error: "Refusing to start coding agent in incomplete worktree: /tmp/wt" })).toBe(true);
    expect(isRecoverableMissingWorktreeReviewFailure({ ...baseTask, error: "Refusing to start coding agent in unregistered git worktree: /tmp/wt" })).toBe(true);

    expect(isRecoverableMissingWorktreeReviewFailureWithProgress({ ...baseTask, paused: true, error: "Refusing to start coding agent in missing worktree: /tmp/wt" })).toBe(false);
    expect(isRecoverableMissingWorktreeReviewFailureWithProgress({ ...baseTask, error: "other" })).toBe(false);
    expect(isRecoverableMissingWorktreeReviewFailureWithProgress({ ...baseTask, steps: [{ id: "s2", title: "y", status: "pending" }] as any, error: "Refusing to start coding agent in missing worktree: /tmp/wt" })).toBe(false);

    const errors = [
      "Refusing to start coding agent in missing worktree: /tmp/wt",
      "Refusing to start coding agent in incomplete worktree: /tmp/wt",
      "Refusing to start coding agent in unregistered git worktree: /tmp/wt",
    ];
    for (const error of errors) {
      const withProgressTask = { ...baseTask, error };
      const noProgressTask = { ...baseTask, steps: [{ id: "s2", title: "y", status: "pending" }] as any, error };
      expect(isRecoverableMissingWorktreeReviewFailureWithProgress(withProgressTask)).toBe(true);
      expect(isRecoverableMissingWorktreeReviewFailureNoProgress(noProgressTask)).toBe(true);
      expect(isRecoverableMissingWorktreeReviewFailure(noProgressTask)).toBe(true);
    }
  });

  it("recognizes missing-worktree failures in every merge-active review status", () => {
    const baseTask = createTask({
      column: "in-review",
      paused: false,
      error: "Refusing to start coding agent in missing worktree: /tmp/wt",
      steps: [{ id: "s1", title: "step", status: "done" }] as any,
    });

    for (const status of ["merging", "merging-pr", "merging-fix"] as const) {
      const task = { ...baseTask, status };
      expect(isMergeActiveMissingWorktreeSessionStartFailure(task)).toBe(true);
      expect(isRecoverableMissingWorktreeReviewFailure(task)).toBe(true);
    }

    expect(isMergeActiveMissingWorktreeSessionStartFailure({ ...baseTask, status: "failed" })).toBe(false);
    expect(isMergeActiveMissingWorktreeSessionStartFailure({ ...baseTask, status: null as any })).toBe(false);
    expect(isMergeActiveMissingWorktreeSessionStartFailure({ ...baseTask, status: "merging", error: "ordinary merge failure" })).toBe(false);
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
