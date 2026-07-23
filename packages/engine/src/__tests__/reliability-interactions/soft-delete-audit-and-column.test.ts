import { describe, expect, it, vi } from "vitest";

import { AutoClaimSnapshotManager } from "../../scheduling/auto-claim-snapshot.js";
import { Scheduler } from "../../scheduler.js";

type TestTask = {
  id: string;
  title: string;
  description: string;
  status: string | null;
  column: string;
  createdAt: string;
  updatedAt: string;
  dependencies: string[];
  comments: unknown[];
  steps: unknown[];
  currentStep: number;
  log: unknown[];
  deletedAt?: string | null;
};

function createEventedSoftDeleteStore(initialTasks: TestTask[] = []) {
  const listeners = new Map<string, ((payload: any) => void)[]>();
  const tasks = initialTasks.map((task) => ({ ...task }));
  const archivedTasks = new Map<string, TestTask>();
  const auditEvents: Array<Record<string, unknown>> = [];
  let sequence = 1;

  const nextTimestamp = () => new Date(1_716_000_000_000 + sequence++).toISOString();
  const emit = (event: string, payload: any) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload);
    }
  };

  return {
    auditEvents,
    archivedTasks,
    emit,
    on: vi.fn((event: string, listener: (payload: any) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    off: vi.fn(),
    getRootDir: vi.fn().mockReturnValue("/test/project"),
    getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, maxConcurrent: 2, maxWorktrees: 4 }),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    readTaskFromDb(id: string, options?: { includeDeleted?: boolean }) {
      const task = tasks.find((entry) => entry.id === id);
      if (!task || (!options?.includeDeleted && task.deletedAt)) return undefined;
      return { ...task };
    },
    async getTask(id: string, options?: { includeDeleted?: boolean }) {
      const task = this.readTaskFromDb(id, options);
      if (!task) throw new Error(`Task ${id} not found`);
      return task;
    },
    async listTasks(options?: { column?: string }) {
      return tasks
        .filter((task) => !task.deletedAt)
        .filter((task) => (options?.column ? task.column === options.column : true))
        .map((task) => ({ ...task }));
    },
    async createTask(input: Partial<TestTask> = {}) {
      const id = input.id ?? `FN-${String(sequence).padStart(4, "0")}`;
      const task: TestTask = {
        id,
        title: input.title ?? id,
        description: input.description ?? id,
        status: input.status ?? null,
        column: input.column ?? "todo",
        createdAt: nextTimestamp(),
        updatedAt: nextTimestamp(),
        dependencies: input.dependencies ?? [],
        comments: [],
        steps: [],
        currentStep: 0,
        log: [],
        deletedAt: input.deletedAt ?? null,
      };
      tasks.push(task);
      emit("task:created", { ...task });
      return { ...task };
    },
    async deleteTask(id: string) {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) throw new Error(`Task ${id} not found`);
      if (task.deletedAt) return { ...task };
      const deletedAt = nextTimestamp();
      auditEvents.push({
        domain: "database",
        mutationType: "task:deleted",
        target: id,
        taskId: id,
      });
      task.column = "archived";
      task.deletedAt = deletedAt;
      task.updatedAt = deletedAt;
      emit("task:deleted", { ...task });
      return { ...task };
    },
    async archiveTask(id: string) {
      const index = tasks.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`Task ${id} not found`);
      const [task] = tasks.splice(index, 1);
      archivedTasks.set(task.id, { ...task });
      emit("task:moved", { task: { ...task }, from: task.column, to: "archived" });
      return { ...task, column: "archived" };
    },
  };
}

describe("reliability interactions: FN-5175 soft-delete audit + archived column", () => {
  it("invalidates scheduler snapshots while keeping archived-column soft-deletes undispatchable", async () => {
    const store = createEventedSoftDeleteStore();
    const task = await store.createTask({ column: "todo", title: "Soft delete target" });
    const snapshotManager = new AutoClaimSnapshotManager({ taskStore: store as any });
    const invalidateSpy = vi.spyOn(snapshotManager, "invalidate");
    new Scheduler(store as any, { snapshotManager } as any);

    await store.deleteTask(task.id);

    expect(invalidateSpy).toHaveBeenCalledWith("task:deleted");
    expect(store.readTaskFromDb(task.id, { includeDeleted: true })).toMatchObject({
      id: task.id,
      column: "archived",
    });
    expect((await snapshotManager.getSnapshot()).tasks.map((entry) => entry.id)).not.toContain(task.id);
    expect((await store.listTasks({ column: "archived" })).map((entry) => entry.id)).not.toContain(task.id);
    expect(store.auditEvents).toHaveLength(1);
  });

  it("fans out a single task:deleted event to listeners while recording one audit event", async () => {
    const store = createEventedSoftDeleteStore();
    const task = await store.createTask({ column: "in-progress", title: "Listener target" });
    const abortSpy = vi.fn();
    store.on("task:deleted", abortSpy);

    await store.deleteTask(task.id);

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledWith(expect.objectContaining({ id: task.id, column: "archived" }));
    expect(store.auditEvents).toHaveLength(1);
  });

  it("does not duplicate audit bookkeeping when a watcher re-emits task:deleted", async () => {
    const store = createEventedSoftDeleteStore();
    const task = await store.createTask({ column: "todo", title: "Watcher target" });

    const deleted = await store.deleteTask(task.id);
    store.emit("task:deleted", { ...deleted });

    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]).toMatchObject({ mutationType: "task:deleted", taskId: task.id });
  });

  it("keeps archiveTask semantics unchanged for live done rows while soft-delete audit rows persist", async () => {
    const store = createEventedSoftDeleteStore();
    const softDeleted = await store.createTask({ column: "todo", title: "soft delete first" });
    const doneTask = await store.createTask({ column: "done", title: "archive me" });

    await store.deleteTask(softDeleted.id);
    await store.archiveTask(doneTask.id);

    expect(store.readTaskFromDb(doneTask.id, { includeDeleted: true })).toBeUndefined();
    expect(store.archivedTasks.get(doneTask.id)).toMatchObject({ id: doneTask.id, column: "done" });
    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]).toMatchObject({ mutationType: "task:deleted", taskId: softDeleted.id });
  });
});
