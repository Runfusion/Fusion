import { describe, expect, it, vi } from "vitest";
import { SelfHealingManager } from "../self-healing.js";
import { TaskNotFoundError } from "@fusion/core";

it("removes a missing dependency once without touching paused tasks", async () => {
  const task = { id: "FN-073", dependencies: ["FN-9999"], column: "todo", autoMerge: true };
  const store = {
    listTasks: vi.fn().mockResolvedValue([task]),
    getTask: vi.fn((id: string) => id === "FN-9999"
      ? Promise.reject(new TaskNotFoundError("FN-9999"))
      : Promise.resolve(task)),
    updateTaskDependencies: vi.fn().mockResolvedValue({ ...task, dependencies: [] }),
    logEntry: vi.fn().mockResolvedValue(undefined),
  };
  const manager = new SelfHealingManager(store as any, { rootDir: "/repo", getExecutingTaskIds: () => new Set() });
  await expect(manager.reconcileMissingDependencies()).resolves.toBe(1);
  expect(store.updateTaskDependencies).toHaveBeenCalledWith("FN-073", { operation: "remove", dependency: "FN-9999" });
});

describe("missing dependency reconciliation guards", () => {
  it("leaves user-paused tasks unchanged", async () => {
    const store = { listTasks: vi.fn().mockResolvedValue([{ id: "FN-073", dependencies: ["FN-9999"], userPaused: true }]) };
    const manager = new SelfHealingManager(store as any, { rootDir: "/repo", getExecutingTaskIds: () => new Set() });
    await expect(manager.reconcileMissingDependencies()).resolves.toBe(0);
  });

  it("does not overwrite a dependency list refreshed by another writer", async () => {
    const snapshot = { id: "FN-073", dependencies: ["FN-9999"], column: "todo", autoMerge: true };
    const current = { ...snapshot, dependencies: ["FN-1234"] };
    const store = {
      listTasks: vi.fn().mockResolvedValue([snapshot]),
      getTask: vi.fn((id: string) => id === "FN-9999"
        ? Promise.reject(new TaskNotFoundError("FN-9999"))
        : Promise.resolve(current)),
      updateTaskDependencies: vi.fn(),
      logEntry: vi.fn(),
    };
    const manager = new SelfHealingManager(store as any, { rootDir: "/repo", getExecutingTaskIds: () => new Set() });
    await expect(manager.reconcileMissingDependencies()).resolves.toBe(0);
    expect(store.updateTaskDependencies).not.toHaveBeenCalled();
  });

  it("respects a live checkout before repairing residue", async () => {
    const task = { id: "FN-073", dependencies: ["FN-9999"], checkedOutBy: "agent", autoMerge: true };
    const store = { listTasks: vi.fn().mockResolvedValue([task]), getTask: vi.fn(), updateTaskDependencies: vi.fn() };
    const manager = new SelfHealingManager(store as any, { rootDir: "/repo", getExecutingTaskIds: () => new Set() });
    await expect(manager.reconcileMissingDependencies()).resolves.toBe(0);
    expect(store.getTask).not.toHaveBeenCalled();
    expect(store.updateTaskDependencies).not.toHaveBeenCalled();
  });

  it("respects executor ownership before repairing residue", async () => {
    const task = { id: "FN-073", dependencies: ["FN-9999"], autoMerge: true };
    const store = { listTasks: vi.fn().mockResolvedValue([task]), getTask: vi.fn(), updateTaskDependencies: vi.fn() };
    const manager = new SelfHealingManager(store as any, {
      rootDir: "/repo",
      getExecutingTaskIds: () => new Set(["FN-073"]),
    });
    await expect(manager.reconcileMissingDependencies()).resolves.toBe(0);
    expect(store.getTask).not.toHaveBeenCalled();
    expect(store.updateTaskDependencies).not.toHaveBeenCalled();
  });
});
