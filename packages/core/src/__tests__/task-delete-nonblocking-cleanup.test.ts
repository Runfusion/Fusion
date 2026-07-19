// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteTaskImpl } from "../task-store/archive-lifecycle.js";
import type { Task } from "../types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createTask(overrides: Partial<Task> & { id: string }): Task {
  const now = "2026-07-15T09:00:00.000Z";
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? overrides.id,
    column: overrides.column ?? "todo",
    dependencies: overrides.dependencies ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    size: "M",
    subtasks: [],
    log: overrides.log ?? [],
    tags: [],
    blockedBy: [],
    source: { sourceType: "api" },
    ...overrides,
  } as Task;
}

function makeDeleteStore(input: {
  task: Task;
  dependentIds?: string[];
  lineageChildIds?: string[];
  cleanupBranchForTask?: (task: Task) => Promise<string[]>;
}) {
  const events = new EventEmitter();
  const tasks = new Map<string, Task>([[input.task.id, { ...input.task, log: [...(input.task.log ?? [])] }]]);
  const auditEvents: Array<{ mutationType: string; taskId?: string }> = [];
  const prepareRun = vi.fn((sql: string, args: unknown[]) => {
    if (sql.includes("UPDATE tasks SET \"column\" = 'archived'")) {
      const [deletedAt, allowResurrection, updatedAt, id] = args as [string, number, string, string];
      const task = tasks.get(id)!;
      task.column = "archived";
      task.deletedAt = deletedAt;
      task.allowResurrection = allowResurrection === 1;
      task.updatedAt = updatedAt;
      return;
    }
    if (sql.includes("UPDATE tasks SET log = ?")) {
      const [logJson, updatedAt, id] = args as [string, string, string];
      const task = tasks.get(id)!;
      task.log = JSON.parse(logJson) as Task["log"];
      task.updatedAt = updatedAt;
    }
  });

  const store = {
    backendMode: false,
    agentLogBuffer: [],
    isWatching: true,
    taskCache: new Map<string, Task>([[input.task.id, input.task]]),
    missionStore: undefined,
    db: {
      transaction: (fn: () => void) => fn(),
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => prepareRun(sql, args),
      }),
      bumpLastModified: vi.fn(),
    },
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<Task>) => fn()),
    flushAgentLogBuffer: vi.fn(),
    readTaskFromDb: vi.fn((id: string) => tasks.get(id) ?? null),
    findLiveDependents: vi.fn(() => input.dependentIds ?? []),
    findLiveLineageChildren: vi.fn(async () => input.lineageChildIds ?? []),
    cleanupBranchForTask: vi.fn(input.cleanupBranchForTask ?? (async () => [])),
    rewriteDependentsForRemoval: vi.fn(() => []),
    rewriteBlockedByResidueDependentsForRemoval: vi.fn(() => []),
    rewriteLineageChildrenForRemoval: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; taskId?: string }) => {
      auditEvents.push(event);
    }),
    makeSyntheticDeleteRunId: vi.fn((id: string) => `synthetic-delete-${id}`),
    clearLinkedAgentTaskIds: vi.fn(),
    clearNearDuplicateReferencesToFailSoft: vi.fn(async () => undefined),
    emit: vi.fn((event: string, ...args: unknown[]) => events.emit(event, ...args)),
    on: events.on.bind(events),
    getStoredTask: (id: string) => tasks.get(id),
    getAuditEvents: () => auditEvents,
    prepareRun,
  };

  return store;
}

describe("deleteTask non-blocking cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("soft-deletes before delayed branch cleanup finishes and still records cleanup", async () => {
    const task = createTask({ id: "FN-7968", branch: "fusion/fn-7968" });
    const cleanup = deferred<string[]>();
    const store = makeDeleteStore({
      task,
      cleanupBranchForTask: async () => cleanup.promise,
    });

    const deletedEvents: string[] = [];
    store.on("task:deleted", (deleted: Task) => {
      deletedEvents.push(deleted.id);
    });

    let resolved = false;
    const deletePromise = deleteTaskImpl(store as never, task.id).then((deleted) => {
      resolved = true;
      return deleted;
    });

    await vi.waitFor(() => expect(resolved).toBe(true), { timeout: 100 });
    const deleted = await deletePromise;

    expect(deleted).toMatchObject({ id: task.id, column: "archived" });
    expect(deleted.deletedAt).toEqual(expect.any(String));
    expect(store.cleanupBranchForTask).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
    expect(store.getStoredTask(task.id)?.log).toEqual([]);
    expect(deletedEvents).toEqual([task.id]);
    expect(store.getAuditEvents().filter((event) => event.mutationType === "task:deleted")).toHaveLength(1);

    cleanup.resolve(["fusion/fn-7968"]);

    await vi.waitFor(() => {
      expect(store.getStoredTask(task.id)?.log?.some((entry) => entry.action === "Cleaned up branch: fusion/fn-7968")).toBe(true);
    });
  });

  it("keeps idempotent and gated deletes fast without scheduling branch cleanup", async () => {
    const deletedTask = createTask({ id: "FN-DELETED", deletedAt: "2026-07-15T09:01:00.000Z", column: "archived" });
    const deletedStore = makeDeleteStore({ task: deletedTask });
    await expect(deleteTaskImpl(deletedStore as never, deletedTask.id)).resolves.toMatchObject({ id: deletedTask.id });
    expect(deletedStore.cleanupBranchForTask).not.toHaveBeenCalled();
    expect(deletedStore.getAuditEvents()).toHaveLength(0);

    const dependentParent = createTask({ id: "FN-DEPENDENT-PARENT", branch: "fusion/dependent-parent" });
    const dependentStore = makeDeleteStore({ task: dependentParent, dependentIds: ["FN-DEPENDENT-CHILD"] });
    await expect(deleteTaskImpl(dependentStore as never, dependentParent.id)).rejects.toMatchObject({ name: "TaskHasDependentsError" });
    expect(dependentStore.cleanupBranchForTask).not.toHaveBeenCalled();
    expect(dependentStore.getAuditEvents()).toHaveLength(0);

    const lineageParent = createTask({ id: "FN-LINEAGE-PARENT", branch: "fusion/lineage-parent" });
    const lineageStore = makeDeleteStore({ task: lineageParent, lineageChildIds: ["FN-LINEAGE-CHILD"] });
    await expect(deleteTaskImpl(lineageStore as never, lineageParent.id)).rejects.toMatchObject({ name: "TaskHasLineageChildrenError" });
    expect(lineageStore.cleanupBranchForTask).not.toHaveBeenCalled();
    expect(lineageStore.getAuditEvents()).toHaveLength(0);
  });
});
