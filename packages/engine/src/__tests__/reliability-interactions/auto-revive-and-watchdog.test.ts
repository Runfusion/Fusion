import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { RestartRecoveryCoordinator } from "../../healing/restart-recovery-coordinator.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: "FN-4361-W",
    title: "t",
    description: "t",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "impl", status: "done" } as any],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("reliability interactions: auto-revive + watchdog", () => {
  it("Case 2: completed-step failure message is requeued safely only when no progress", async () => {
    const tasks = [
      task({ id: "FN-1", error: "Agent finished without calling fn_task_done", status: "failed", steps: [] as any[] }),
      task({ id: "FN-2", error: "Agent finished without calling fn_task_done", status: "failed", steps: [{ name: "impl", status: "done" } as any] }),
    ];
    const store: any = {
      listTasks: vi.fn(async () => tasks),
      updateTask: vi.fn(async () => undefined),
      logEntry: vi.fn(async () => undefined),
      moveTask: vi.fn(async () => undefined),
    };
    const executor: any = { resumeOrphaned: vi.fn(async () => undefined) };
    const rc = new RestartRecoveryCoordinator(store, executor);
    await rc.recoverInterruptedRuns();
    /*
    FNXC:LifecycleContainment 2026-09-22-13:50:
    Restart recovery clears only stale execution metadata. It is not a review or
    verification revision, so the shared lifecycle owner retains the card's current
    role rather than authorizing an implicit backward move to `todo`.
    */
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      status: "stuck-killed",
      worktree: null,
      branch: null,
      sessionFile: null,
      error: null,
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-1",
      expect.stringContaining("has no backward-move authority"),
    );
  });

  it("Case 8: recovery coordinator skips resume when no in-progress candidates", async () => {
    const store: any = { listTasks: vi.fn(async () => []), updateTask: vi.fn(), logEntry: vi.fn(), moveTask: vi.fn() };
    const executor: any = { resumeOrphaned: vi.fn(async () => undefined) };
    const rc = new RestartRecoveryCoordinator(store, executor);
    await rc.recoverInterruptedRuns();
    expect(executor.resumeOrphaned).toHaveBeenCalledTimes(0);
  });

  it("Case 12: new commits are orthogonal to restart classification", async () => {
    const store: any = { listTasks: vi.fn(async () => [task({ id: "FN-3", status: "failed", error: "Agent finished without calling fn_task_done", steps: [] as any[] })]), updateTask: vi.fn(async () => undefined), logEntry: vi.fn(async () => undefined), moveTask: vi.fn(async () => undefined) };
    const executor: any = { resumeOrphaned: vi.fn(async () => undefined) };
    const rc = new RestartRecoveryCoordinator(store, executor);
    await rc.recoverInterruptedRuns();
    expect(store.updateTask).toHaveBeenCalledWith("FN-3", expect.objectContaining({
      status: "stuck-killed",
      worktree: null,
      branch: null,
      sessionFile: null,
      error: null,
    }));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-3",
      expect.stringContaining("has no backward-move authority"),
    );
  });
});
