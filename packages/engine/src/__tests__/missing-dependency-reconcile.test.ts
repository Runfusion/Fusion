import { describe, expect, it, vi } from "vitest";
import { TaskDeletedError, TaskNotFoundError } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

const deletedAt = "2026-09-05T22:04:00.000Z";

function task(id: string, dependencies: string[], overrides: Record<string, unknown> = {}) {
  return { id, dependencies, column: "todo", autoMerge: true, ...overrides };
}

function createManager(store: Record<string, unknown>) {
  return new SelfHealingManager(store as any, { rootDir: "/repo", getExecutingTaskIds: () => new Set() });
}

it("removes a missing dependency once without touching paused tasks", async () => {
  const dependent = task("FN-073", ["FN-9999"]);
  const store = {
    listTasks: vi.fn().mockResolvedValue([dependent]),
    getTask: vi.fn((id: string) => id === "FN-9999"
      ? Promise.reject(new TaskNotFoundError("FN-9999"))
      : Promise.resolve(dependent)),
    updateTaskDependencies: vi.fn().mockResolvedValue({ ...dependent, dependencies: [] }),
    logEntry: vi.fn().mockResolvedValue(undefined),
  };
  const manager = createManager(store);
  await expect(manager.reconcileMissingDependencies()).resolves.toBe(1);
  expect(store.listTasks).toHaveBeenCalledWith(expect.objectContaining({ slim: true, includeArchived: false }));
  expect(store.updateTaskDependencies).toHaveBeenCalledWith("FN-073", { operation: "remove", dependency: "FN-9999" });
});

describe("missing dependency reconciliation guards", () => {
  it("leaves empty and user-paused tasks unchanged", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([
        task("FN-EMPTY", []),
        task("FN-073", ["FN-9999"], { userPaused: true }),
      ]),
      getTask: vi.fn(),
      updateTaskDependencies: vi.fn(),
    };
    const manager = createManager(store);
    await expect(manager.reconcileMissingDependencies()).resolves.toBe(0);
    expect(store.getTask).not.toHaveBeenCalled();
    expect(store.updateTaskDependencies).not.toHaveBeenCalled();
  });

  it("does not overwrite a dependency list refreshed by another writer", async () => {
    const snapshot = task("FN-073", ["FN-9999"]);
    const current = task("FN-073", ["FN-1234"]);
    const store = {
      listTasks: vi.fn().mockResolvedValue([snapshot]),
      getTask: vi.fn((id: string) => id === "FN-9999"
        ? Promise.reject(new TaskNotFoundError("FN-9999"))
        : Promise.resolve(current)),
      updateTaskDependencies: vi.fn(),
      logEntry: vi.fn(),
    };
    const manager = createManager(store);
    await expect(manager.reconcileMissingDependencies()).resolves.toBe(0);
    expect(store.updateTaskDependencies).not.toHaveBeenCalled();
  });

  it("respects a live checkout before repairing residue", async () => {
    const dependent = task("FN-073", ["FN-9999"], { checkedOutBy: "agent" });
    const store = { listTasks: vi.fn().mockResolvedValue([dependent]), getTask: vi.fn(), updateTaskDependencies: vi.fn() };
    const manager = createManager(store);
    await expect(manager.reconcileMissingDependencies()).resolves.toBe(0);
    expect(store.getTask).not.toHaveBeenCalled();
    expect(store.updateTaskDependencies).not.toHaveBeenCalled();
  });

  it("respects executor ownership before repairing residue", async () => {
    const dependent = task("FN-073", ["FN-9999"]);
    const store = { listTasks: vi.fn().mockResolvedValue([dependent]), getTask: vi.fn(), updateTaskDependencies: vi.fn() };
    const manager = new SelfHealingManager(store as any, {
      rootDir: "/repo",
      getExecutingTaskIds: () => new Set(["FN-073"]),
    });
    await expect(manager.reconcileMissingDependencies()).resolves.toBe(0);
    expect(store.getTask).not.toHaveBeenCalled();
    expect(store.updateTaskDependencies).not.toHaveBeenCalled();
  });
});

describe("archived dependency reconciliation", () => {
  it("skips archived dependents and still repairs a later live missing edge", async () => {
    const archived = task("FN-011", ["FN-010"], { column: "archived", deletedAt });
    const live = task("FN-073", ["FN-9999"]);
    const store = {
      listTasks: vi.fn().mockResolvedValue([archived, live]),
      getTask: vi.fn((id: string) => {
        if (id === "FN-9999") return Promise.reject(new TaskNotFoundError(id));
        if (id === "FN-010") return Promise.resolve(task(id, [], { column: "archived", deletedAt }));
        if (id === "FN-011") return Promise.resolve(archived);
        if (id === "FN-073") return Promise.resolve(live);
        return Promise.resolve(task(id, []));
      }),
      updateTaskDependencies: vi.fn((id: string) => id === "FN-011"
        ? Promise.reject(new TaskDeletedError(id, deletedAt))
        : Promise.resolve(undefined)),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createManager(store).reconcileMissingDependencies()).resolves.toBe(1);
    expect(store.updateTaskDependencies).not.toHaveBeenCalledWith("FN-011", expect.anything());
    expect(store.updateTaskDependencies).toHaveBeenCalledWith("FN-073", { operation: "remove", dependency: "FN-9999" });
    expect(store.logEntry).toHaveBeenCalledTimes(1);
  });

  it("treats an archive-resolved dependency as terminal rather than missing", async () => {
    const live = task("FN-073", ["FN-010"]);
    const archivedDependency = task("FN-010", [], { column: "archived", deletedAt });
    const store = {
      listTasks: vi.fn().mockResolvedValue([live]),
      getTask: vi.fn((id: string) => Promise.resolve(id === "FN-010" ? archivedDependency : live)),
      updateTaskDependencies: vi.fn(),
      logEntry: vi.fn(),
    };

    await expect(createManager(store).reconcileMissingDependencies()).resolves.toBe(0);
    expect(store.updateTaskDependencies).not.toHaveBeenCalled();
  });

  it("still removes a dependency soft-deleted without an archive snapshot", async () => {
    const live = task("FN-073", ["FN-010"]);
    const store = {
      listTasks: vi.fn().mockResolvedValue([live]),
      getTask: vi.fn((id: string) => id === "FN-010"
        ? Promise.reject(new TaskNotFoundError(id))
        : Promise.resolve(live)),
      updateTaskDependencies: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createManager(store).reconcileMissingDependencies()).resolves.toBe(1);
    expect(store.updateTaskDependencies).toHaveBeenCalledWith("FN-073", { operation: "remove", dependency: "FN-010" });
  });
});

describe("missing dependency reconciliation deletion races", () => {
  function twoLiveDependents() {
    const unreadable = task("FN-073", ["FN-9998"]);
    const repairable = task("FN-074", ["FN-9999"]);
    return { unreadable, repairable };
  }

  it("contains a TaskDeletedError from the mutation and repairs later candidates", async () => {
    const { unreadable, repairable } = twoLiveDependents();
    const store = {
      listTasks: vi.fn().mockResolvedValue([unreadable, repairable]),
      getTask: vi.fn((id: string) => ["FN-9998", "FN-9999"].includes(id)
        ? Promise.reject(new TaskNotFoundError(id))
        : Promise.resolve(id === "FN-073" ? unreadable : repairable)),
      updateTaskDependencies: vi.fn((id: string) => id === "FN-073"
        ? Promise.reject(new TaskDeletedError(id, deletedAt))
        : Promise.resolve(undefined)),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createManager(store).reconcileMissingDependencies()).resolves.toBe(1);
    expect(store.updateTaskDependencies).toHaveBeenCalledWith("FN-073", { operation: "remove", dependency: "FN-9998" });
    expect(store.updateTaskDependencies).toHaveBeenCalledWith("FN-074", { operation: "remove", dependency: "FN-9999" });
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith("FN-074", expect.any(String));
  });

  it("contains a duck-typed TaskDeletedError from the mutation", async () => {
    const { unreadable, repairable } = twoLiveDependents();
    const duckTyped = Object.assign(new Error("serialized deletion"), { name: "TaskDeletedError" });
    const store = {
      listTasks: vi.fn().mockResolvedValue([unreadable, repairable]),
      getTask: vi.fn((id: string) => ["FN-9998", "FN-9999"].includes(id)
        ? Promise.reject(new TaskNotFoundError(id))
        : Promise.resolve(id === "FN-073" ? unreadable : repairable)),
      updateTaskDependencies: vi.fn((id: string) => id === "FN-073"
        ? Promise.reject(duckTyped)
        : Promise.resolve(undefined)),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createManager(store).reconcileMissingDependencies()).resolves.toBe(1);
    expect(store.updateTaskDependencies).toHaveBeenCalledTimes(2);
    expect(store.logEntry).toHaveBeenCalledWith("FN-074", expect.any(String));
  });

  it("contains a TaskDeletedError from the pre-mutation re-read", async () => {
    const { unreadable, repairable } = twoLiveDependents();
    const store = {
      listTasks: vi.fn().mockResolvedValue([unreadable, repairable]),
      getTask: vi.fn((id: string) => {
        if (["FN-9998", "FN-9999"].includes(id)) return Promise.reject(new TaskNotFoundError(id));
        if (id === "FN-073") return Promise.reject(new TaskDeletedError(id, deletedAt));
        return Promise.resolve(repairable);
      }),
      updateTaskDependencies: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createManager(store).reconcileMissingDependencies()).resolves.toBe(1);
    expect(store.updateTaskDependencies).not.toHaveBeenCalledWith("FN-073", expect.anything());
    expect(store.updateTaskDependencies).toHaveBeenCalledWith("FN-074", { operation: "remove", dependency: "FN-9999" });
  });

  it("still surfaces non-lookup mutation faults", async () => {
    const dependent = task("FN-073", ["FN-9999"]);
    const store = {
      listTasks: vi.fn().mockResolvedValue([dependent]),
      getTask: vi.fn((id: string) => id === "FN-9999"
        ? Promise.reject(new TaskNotFoundError(id))
        : Promise.resolve(dependent)),
      updateTaskDependencies: vi.fn().mockRejectedValue(new Error("connection terminated unexpectedly")),
      logEntry: vi.fn(),
    };

    await expect(createManager(store).reconcileMissingDependencies()).rejects.toThrow("connection terminated unexpectedly");
  });
});
