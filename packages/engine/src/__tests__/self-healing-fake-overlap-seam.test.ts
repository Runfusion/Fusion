import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    status: null,
    paused: false,
    blockedBy: null,
    overlapBlockedBy: null,
    dependencies: [],
    steps: [],
    log: [],
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createOverlapStore(seed: Task[]): { store: TaskStore; tasks: Map<string, Task> } {
  const tasks = new Map(seed.map((task) => [task.id, task]));
  const settings = {
    globalPause: false,
    enginePaused: false,
    mergeRequestContractShadowEnabled: true,
  } as Settings;

  const store = {
    getSettings: vi.fn().mockResolvedValue(settings),
    listTasks: vi.fn().mockImplementation(async (opts?: { column?: Task["column"]; includeArchived?: boolean }) => {
      const all = [...tasks.values()];
      if (!opts?.column) return all;
      return all.filter((task) => task.column === opts.column);
    }),
    getTask: vi.fn().mockImplementation(async (id: string, opts?: { includeDeleted?: boolean }) => {
      const task = tasks.get(id);
      if (!task || (task.deletedAt && !opts?.includeDeleted)) return null;
      return task;
    }),
    updateTask: vi.fn().mockImplementation(async (id: string, patch: Partial<Task>) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} missing`);
      const next = { ...current, ...patch } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    /*
    FNXC:OverlapSelfHealing 2026-06-26-12:00:
    This regression intentionally drives a hand-rolled TaskStore through clearStaleBlockedBy's active file-scope-overlap branch. The fake must include parsed scope and completion-handoff methods so a missing method cannot silently turn a preserved-queued recovery into count 0.
    */
    parseFileScopeFromPrompt: vi.fn().mockImplementation(async () => ["packages/engine/src/self-healing.ts"]),
    getCompletionHandoffAcceptedMarker: vi.fn().mockReturnValue(null),
  } as unknown as TaskStore;

  return { store, tasks };
}

describe("SelfHealingManager PostgreSQL soft-delete repair", () => {
  function createSoftDeleteRepairStore(settings: Pick<Settings, "globalPause" | "enginePaused">) {
    const reconcileSoftDeletedColumnDriftBackend = vi.fn().mockResolvedValue({ reconciled: 2 });
    const getDatabase = vi.fn(() => {
      throw new Error("SQLite must not be opened by PostgreSQL soft-delete repair");
    });
    const store = {
      getSettings: vi.fn().mockResolvedValue(settings),
      reconcileSoftDeletedColumnDriftBackend,
      getDatabase,
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStore;
    return { store, reconcileSoftDeletedColumnDriftBackend, getDatabase };
  }

  it("returns early while paused without invoking the backend repair", async () => {
    const { store, reconcileSoftDeletedColumnDriftBackend, getDatabase } = createSoftDeleteRepairStore({
      globalPause: true,
      enginePaused: false,
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await expect(manager.reconcileSoftDeletedColumnDrift()).resolves.toEqual({ reconciled: 0 });

    expect(reconcileSoftDeletedColumnDriftBackend).not.toHaveBeenCalled();
    expect(getDatabase).not.toHaveBeenCalled();
    manager.stop();
  });

  it("delegates active repair to PostgreSQL without opening SQLite", async () => {
    const { store, reconcileSoftDeletedColumnDriftBackend, getDatabase } = createSoftDeleteRepairStore({
      globalPause: false,
      enginePaused: false,
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await expect(manager.reconcileSoftDeletedColumnDrift()).resolves.toEqual({ reconciled: 2 });

    expect(reconcileSoftDeletedColumnDriftBackend).toHaveBeenCalledOnce();
    expect(getDatabase).not.toHaveBeenCalled();
    manager.stop();
  });
});

describe("SelfHealingManager fake TaskStore overlap seam", () => {
  it("preserves queued recovery through active overlap without missing-method drift", async () => {
    const staleBlocker = makeTask("FN-DONE-BLOCKER", { column: "done" });
    const overlapBlocker = makeTask("FN-ACTIVE-OVERLAP", { column: "in-progress" });
    const dependent = makeTask("FN-DEPENDENT", {
      column: "todo",
      status: "queued",
      blockedBy: staleBlocker.id,
      overlapBlockedBy: overlapBlocker.id,
      dependencies: [staleBlocker.id],
    });
    const { store, tasks } = createOverlapStore([staleBlocker, overlapBlocker, dependent]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project", getExecutingTaskIds: () => new Set<string>() });

    await expect(manager.clearStaleBlockedBy()).resolves.toBe(1);

    expect(store.parseFileScopeFromPrompt).toHaveBeenCalledWith(dependent.id);
    expect(store.parseFileScopeFromPrompt).toHaveBeenCalledWith(overlapBlocker.id);
    expect(store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledWith(overlapBlocker.id);
    expect(store.updateTask).toHaveBeenCalledWith(dependent.id, { blockedBy: null, status: "queued" });
    expect(tasks.get(dependent.id)?.blockedBy).toBeNull();
    expect(tasks.get(dependent.id)?.status).toBe("queued");
    expect(tasks.get(dependent.id)?.overlapBlockedBy).toBe(overlapBlocker.id);
    expect(store.logEntry).toHaveBeenCalledWith(
      dependent.id,
      expect.stringContaining(`still blocked by file scope overlap with ${overlapBlocker.id}`),
    );

    manager.stop();
  });
});
