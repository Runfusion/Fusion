import "../executor-test-helpers.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutoClaimSnapshotManager } from "../../scheduling/auto-claim-snapshot.js";
import { Scheduler } from "../../scheduler.js";
import { TaskExecutor } from "../../executor.js";
import { executorLog } from "../../logger.js";
import { createMockStore, resetExecutorMocks } from "../executor-test-helpers.js";

type TestTask = {
  id: string;
  title: string;
  description: string;
  status: string;
  column: string;
  createdAt: string;
  updatedAt: string;
  dependencies: string[];
  comments: unknown[];
  steps: unknown[];
  currentStep: number;
  log: unknown[];
  deletedAt?: string | null;
  paused?: boolean;
  checkedOutBy?: string | null;
};

function createEventedSoftDeleteStore(initialTasks: TestTask[] = []) {
  const listeners = new Map<string, ((payload: any) => void)[]>();
  let sequence = 1;
  const tasks = initialTasks.map((task) => ({ ...task }));

  const emit = (event: string, payload: any) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload);
    }
  };

  const nextTimestamp = () => new Date(1_716_000_000_000 + sequence++).toISOString();

  return {
    on: vi.fn((event: string, listener: (payload: any) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    off: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, maxConcurrent: 2, maxWorktrees: 4 }),
    getRootDir: vi.fn().mockReturnValue("/test/project"),
    getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockImplementation(async (id: string, patch: Partial<TestTask>) => {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) return undefined;
      Object.assign(task, patch, { updatedAt: nextTimestamp() });
      emit("task:updated", { ...task });
      return { ...task };
    }),
    async createTask(input: Partial<TestTask> = {}) {
      const id = `FN-${String(sequence).padStart(4, "0")}`;
      const task: TestTask = {
        id,
        title: input.title ?? `Task ${id}`,
        description: input.description ?? id,
        status: input.status ?? "open",
        column: input.column ?? "triage",
        createdAt: nextTimestamp(),
        updatedAt: nextTimestamp(),
        dependencies: input.dependencies ?? [],
        comments: [],
        steps: [],
        currentStep: 0,
        log: [],
        deletedAt: input.deletedAt ?? null,
        paused: input.paused,
        checkedOutBy: input.checkedOutBy ?? null,
      };
      tasks.push(task);
      emit("task:created", { ...task });
      return { ...task };
    },
    async getTask(id: string, options?: { includeDeleted?: boolean }) {
      const task = tasks.find((entry) => entry.id === id);
      if (!task || (!options?.includeDeleted && task.deletedAt)) {
        throw new Error(`Task ${id} not found`);
      }
      return { ...task };
    },
    readTaskFromDb(id: string, options?: { includeDeleted?: boolean }) {
      const task = tasks.find((entry) => entry.id === id);
      if (!task || (!options?.includeDeleted && task.deletedAt)) {
        return undefined;
      }
      return { ...task };
    },
    async listTasks(options?: { column?: string; slim?: boolean }) {
      return tasks
        .filter((task) => !task.deletedAt)
        .filter((task) => (options?.column ? task.column === options.column : true))
        .map((task) => ({ ...task }));
    },
    async moveTask(id: string, column: string) {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) {
        throw new Error(`Task ${id} not found`);
      }
      const from = task.column;
      task.column = column;
      task.updatedAt = nextTimestamp();
      emit("task:moved", { task: { ...task }, from, to: column });
      return { ...task };
    },
    async deleteTask(id: string) {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) {
        throw new Error(`Task ${id} not found`);
      }
      if (task.deletedAt) {
        return { ...task };
      }
      const deletedAt = nextTimestamp();
      task.deletedAt = deletedAt;
      task.updatedAt = deletedAt;
      emit("task:deleted", { ...task });
      return { ...task };
    },
  };
}

describe("reliability interactions: FN-5153 soft-delete end-to-end", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("keeps live readers and scheduler snapshots converged after task:deleted", async () => {
    const store = createEventedSoftDeleteStore();
    const task = await store.createTask({ column: "todo", title: "Soft delete target" });
    const snapshotManager = new AutoClaimSnapshotManager({ taskStore: store as any });
    const invalidateSpy = vi.spyOn(snapshotManager, "invalidate");
    new Scheduler(store as any, { snapshotManager } as any);

    expect((await snapshotManager.getSnapshot()).tasks.map((entry) => entry.id)).toContain(task.id);
    expect((await store.listTasks()).map((entry) => entry.id)).toContain(task.id);

    await store.deleteTask(task.id);

    await expect(store.getTask(task.id)).rejects.toThrow(`Task ${task.id} not found`);
    expect((await store.listTasks()).map((entry) => entry.id)).not.toContain(task.id);
    expect(store.readTaskFromDb(task.id, { includeDeleted: true })?.deletedAt).toBeTruthy();
    expect(invalidateSpy).toHaveBeenCalledWith("task:deleted");
    expect((await snapshotManager.getSnapshot()).tasks.map((entry) => entry.id)).not.toContain(task.id);
  });

  it("keeps executor entry points from running soft-deleted tasks", async () => {
    const deletedTask = {
      id: "FN-5153-DELETED",
      title: "Deleted",
      description: "deleted",
      status: "open",
      column: "in-progress",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      dependencies: [],
      comments: [],
      steps: [],
      currentStep: 0,
      log: [],
      deletedAt: "2026-01-02T00:00:00.000Z",
    } as any;
    const store = createMockStore();
    store.listTasks.mockResolvedValue([deletedTask]);
    /*
    FNXC:EngineTests 2026-07-19-03:24 (U10b):
    Requirement unchanged: no executor entry point may run a soft-deleted task.
    What changed: `execute()` now always enters the workflow graph, and the graph RE-READS the row
    from the store instead of trusting the object handed to `execute()`. A fixture that marked
    `deletedAt` only on its local literal therefore described an impossible world (store says
    alive, caller says deleted) and the refusal never fired. Publish the deletion into the store
    row so the store and the caller agree, which is the only state production can actually be in.
    */
    store._setRow(deletedTask.id, { deletedAt: deletedTask.deletedAt });

    const executor = new TaskExecutor(store as any, "/tmp/test");
    const warnSpy = vi.spyOn(executorLog, "warn");
    const executeSpy = vi.spyOn(executor, "execute");

    await executor.execute(deletedTask);
    await executor.resumeOrphaned();

    expect(warnSpy).toHaveBeenCalledWith("FN-5153-DELETED: refusing execute — task is soft-deleted");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps re-delete idempotent and deleted IDs reserved", async () => {
    const store = createEventedSoftDeleteStore();
    const task = await store.createTask({ column: "todo", title: "Original" });
    const deletedEvents: string[] = [];
    store.on("task:deleted", (event) => deletedEvents.push(event.id));

    const firstDelete = await store.deleteTask(task.id);
    const secondDelete = await store.deleteTask(task.id);
    const replacement = await store.createTask({ column: "todo", title: "Replacement" });

    expect(firstDelete.deletedAt).toBeTruthy();
    expect(secondDelete.deletedAt).toBe(firstDelete.deletedAt);
    expect(deletedEvents).toEqual([task.id]);
    expect(replacement.id).not.toBe(task.id);
  });

  it("converges cleanly when in-progress → todo is immediately followed by task:deleted", async () => {
    const store = createEventedSoftDeleteStore();
    const task = await store.createTask({ column: "in-progress", title: "Race target" });
    const snapshotManager = new AutoClaimSnapshotManager({ taskStore: store as any });
    const invalidateSpy = vi.spyOn(snapshotManager, "invalidate");
    new Scheduler(store as any, { snapshotManager } as any);

    await store.moveTask(task.id, "todo");
    await store.deleteTask(task.id);

    expect(invalidateSpy).toHaveBeenCalledWith("task:deleted");
    expect((await snapshotManager.getSnapshot()).tasks.map((entry) => entry.id)).not.toContain(task.id);
    await expect(store.getTask(task.id)).rejects.toThrow(`Task ${task.id} not found`);
    expect((await store.listTasks()).map((entry) => entry.id)).not.toContain(task.id);

    const mockStore = createMockStore();
    mockStore.listTasks.mockResolvedValue([]);
    const executor = new TaskExecutor(mockStore as any, "/tmp/test");
    const warnSpy = vi.spyOn(executorLog, "warn");
    const executeSpy = vi.spyOn(executor, "execute");

    await executor.resumeOrphaned();

    expect(executeSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
