import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

vi.mock("../../worktree/worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../../worktree-pool.js");
  return { ...actual, isUsableTaskWorktree: vi.fn().mockResolvedValue(true) };
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4625",
    title: "FN-4625",
    description: "task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    branch: "fusion/fn-4625",
    worktree: "/tmp/fn-4625",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeStore(tasks: Task[]): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => ({ maintenanceIntervalMs: 0, globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async ({ column, includeArchived }: any = {}) => tasks.filter((task) => {
      if (!includeArchived && task.column === "archived") return false;
      return !column || task.column === column;
    })),
    updateTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    getTask: vi.fn(async () => tasks[0]),
  }) as unknown as TaskStore & EventEmitter;
}

describe("reliability interactions: worktrunk failure", () => {
  it("self-healing skips reclaim for tasks paused by worktrunk failures", async () => {
    const store = makeStore([
      makeTask({ paused: true, pausedReason: "worktrunk_operation_failed" }),
    ]);

    const manager = new SelfHealingManager(store, {
      rootDir: process.cwd(),
      getExecutingTaskIds: () => new Set(),
    });

    const inspectSpy = vi.spyOn(manager as any, "inspectOrphanedBranch");
    const recovered = await manager.reclaimStaleActiveBranches();

    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
