import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../types.js";

const mocks = vi.hoisted(() => ({
  listArchivedTaskEntriesPageTolerant: vi.fn(),
  restoreTaskFromArchive: vi.fn(),
  resolveWorkflowIrForTask: vi.fn(),
  resolveCompleteColumn: vi.fn(),
  readTaskRow: vi.fn(),
}));

vi.mock("../task-store/async/async-archive-lineage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../task-store/async/async-archive-lineage.js")>(),
  listArchivedTaskEntriesPageTolerant: mocks.listArchivedTaskEntriesPageTolerant,
  restoreTaskFromArchive: mocks.restoreTaskFromArchive,
}));
vi.mock("../workflows/workflow-ir-resolver.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../workflows/workflow-ir-resolver.js")>(),
  resolveWorkflowIrForTask: mocks.resolveWorkflowIrForTask,
}));
vi.mock("../workflows/workflow-lifecycle-traits.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../workflows/workflow-lifecycle-traits.js")>(),
  resolveCompleteColumn: mocks.resolveCompleteColumn,
}));
vi.mock("../task-store/async/async-persistence.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../task-store/async/async-persistence.js")>(),
  readTaskRow: mocks.readTaskRow,
}));

import { drainArchivedTasksIntoDone, reconcileArchivedTasksIntoDonePass } from "../task-store/archive-reintegration.js";

function archiveEntry(id: string) {
  return {
    id,
    lineageId: `lineage-${id}`,
    description: `Archived ${id}`,
    column: "archived" as const,
    dependencies: [],
    steps: [{ description: "Delivered", status: "done" as const }],
    currentStep: 1,
    attachments: [{ filename: "proof.txt", mimeType: "text/plain", size: 5 }],
    log: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    archivedAt: "2026-08-03T00:00:00.000Z",
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    ...archiveEntry(id),
    column: "archived",
    ...overrides,
  } as Task;
}

function makeStore(initial: Task[] = []) {
  const rows = new Map(initial.map((value) => [value.id, structuredClone(value)]));
  const store = {
    asyncLayer: { db: { rows }, projectId: "project-1" },
    listTasks: vi.fn(async (options?: { limit?: number; offset?: number }) => {
      const archived = [...rows.values()].filter((value) => value.column === "archived" && !value.deletedAt);
      const offset = options?.offset ?? 0;
      return archived.slice(offset, options?.limit === undefined ? undefined : offset + options.limit);
    }),
    getTask: vi.fn(async (id: string, options?: { includeDeleted?: boolean }) => {
      const value = rows.get(id);
      if (!value || (value.deletedAt && !options?.includeDeleted)) throw new Error(`Task ${id} not found`);
      return structuredClone(value);
    }),
    moveTaskIf: vi.fn(async (id: string, destination: string, predicate: (live: Task) => boolean | Promise<boolean>) => {
      const current = rows.get(id);
      if (!current || !await predicate(current)) return { task: current, moved: false };
      const moved = { ...current, column: destination, updatedAt: "2026-09-04T19:28:00.000Z" } as Task;
      rows.set(id, moved);
      return { task: moved, moved: true };
    }),
    archiveEntryToTask: vi.fn((entry: ReturnType<typeof archiveEntry>) => task(entry.id, entry)),
    restoreFromArchive: vi.fn(async (entry: ReturnType<typeof archiveEntry>) => task(entry.id, entry)),
    logEntry: vi.fn(async (id: string, action: string) => {
      const current = rows.get(id);
      if (current) rows.set(id, { ...current, log: [...current.log, { timestamp: "2026-09-04T19:28:00.000Z", action }] });
    }),
    atomicWriteTaskJson: vi.fn().mockResolvedValue(undefined),
    taskDir: vi.fn((id: string) => `/tasks/${id}`),
  };
  return { store, rows };
}

describe("reconcileArchivedTasksIntoDonePass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkflowIrForTask.mockResolvedValue({ version: "v2", columns: [] });
    mocks.resolveCompleteColumn.mockReturnValue("done");
    mocks.listArchivedTaskEntriesPageTolerant.mockResolvedValue([]);
    mocks.readTaskRow.mockImplementation(async (layer, id) => layer.db.rows.get(id));
  });

  it("is a silent no-op when neither archive source has rows", async () => {
    const { store } = makeStore();

    await expect(reconcileArchivedTasksIntoDonePass(store as never)).resolves.toEqual({
      movedCount: 0,
      restoredCount: 0,
      outcomes: [],
      hasMore: false,
    });
    expect(store.moveTaskIf).not.toHaveBeenCalled();
    expect(mocks.restoreTaskFromArchive).not.toHaveBeenCalled();
  });

  it("moves a live archived row while preserving progress and attachments", async () => {
    const original = task("FN-29501");
    const { store, rows } = makeStore([original]);

    const result = await reconcileArchivedTasksIntoDonePass(store as never);

    expect(result).toMatchObject({ movedCount: 1, restoredCount: 0 });
    expect(store.moveTaskIf).toHaveBeenCalledWith(
      original.id,
      "done",
      expect.any(Function),
      { moveSource: "engine", recoveryRehome: true, preserveProgress: true },
    );
    expect(rows.get(original.id)).toMatchObject({
      column: "done",
      steps: original.steps,
      attachments: original.attachments,
    });
  });

  it("recreates a cold-only snapshot directly in Done", async () => {
    const entry = archiveEntry("FN-29502");
    const { store, rows } = makeStore();
    mocks.listArchivedTaskEntriesPageTolerant.mockResolvedValue([{ id: entry.id, entry, malformed: false }]);
    mocks.restoreTaskFromArchive.mockImplementation(async (_layer, _entry, options) => {
      rows.set(entry.id, options.taskRecord as Task);
      return { outcome: "restored", moved: true };
    });

    const result = await reconcileArchivedTasksIntoDonePass(store as never);

    expect(result).toMatchObject({ movedCount: 0, restoredCount: 1 });
    expect(mocks.restoreTaskFromArchive).toHaveBeenCalledWith(
      store.asyncLayer,
      entry,
      expect.objectContaining({
        targetColumn: "done",
        taskRecord: expect.objectContaining({ id: entry.id, column: "done", steps: entry.steps, attachments: entry.attachments }),
      }),
    );
    expect(rows.get(entry.id)).toMatchObject({ column: "done" });
  });

  it("retains a malformed snapshot while restoring valid rows that follow it", async () => {
    const valid = archiveEntry("FN-29512");
    const { store, rows } = makeStore();
    mocks.listArchivedTaskEntriesPageTolerant.mockResolvedValue([
      { id: "FN-29513", malformed: true },
      { id: valid.id, entry: valid, malformed: false },
    ]);
    mocks.restoreTaskFromArchive.mockImplementation(async (_layer, _entry, options) => {
      rows.set(valid.id, options.taskRecord as Task);
      return { outcome: "restored", moved: true };
    });

    const result = await reconcileArchivedTasksIntoDonePass(store as never, { limit: 4 });

    expect(result.outcomes).toEqual([
      { taskId: "FN-29513", source: "cold-storage", outcome: "retained", reason: "malformed-snapshot" },
      { taskId: valid.id, source: "cold-storage", outcome: "restored" },
    ]);
    expect(rows.get(valid.id)).toMatchObject({ column: "done" });
  });

  it("lets the live row win a cold-snapshot collision without creating a duplicate", async () => {
    const entry = archiveEntry("FN-29503");
    const live = task(entry.id, { title: "Authoritative live row" });
    const { store, rows } = makeStore([live]);
    mocks.listArchivedTaskEntriesPageTolerant.mockResolvedValue([{ id: entry.id, entry, malformed: false }]);
    mocks.restoreTaskFromArchive.mockResolvedValue({ outcome: "live-won", moved: false });

    const result = await reconcileArchivedTasksIntoDonePass(store as never);

    expect(result.outcomes).toEqual([
      { taskId: entry.id, source: "live-column", outcome: "moved" },
      { taskId: entry.id, source: "cold-storage", outcome: "live-won" },
    ]);
    expect(store.restoreFromArchive).not.toHaveBeenCalled();
    expect([...rows.values()]).toHaveLength(1);
    expect(rows.get(entry.id)).toMatchObject({ column: "done", title: "Authoritative live row" });
  });

  it("is idempotent on an immediate second pass", async () => {
    const original = task("FN-29504");
    const { store } = makeStore([original]);

    await expect(reconcileArchivedTasksIntoDonePass(store as never)).resolves.toMatchObject({ movedCount: 1 });
    await expect(reconcileArchivedTasksIntoDonePass(store as never)).resolves.toEqual({
      movedCount: 0,
      restoredCount: 0,
      outcomes: [],
      hasMore: false,
    });
    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
  });

  it("advances beyond a paused first page while independently draining cold storage", async () => {
    const pausedA = task("FN-29505", { userPaused: true });
    const pausedB = task("FN-29506", { userPaused: true });
    const trailingLive = task("FN-29507");
    const cold = archiveEntry("FN-29508");
    const { store, rows } = makeStore([pausedA, pausedB, trailingLive]);
    mocks.listArchivedTaskEntriesPageTolerant
      .mockResolvedValueOnce([{ id: cold.id, entry: cold, malformed: false }])
      .mockResolvedValue([]);
    mocks.restoreTaskFromArchive.mockImplementation(async (_layer, _entry, options) => {
      rows.set(cold.id, options.taskRecord as Task);
      return { outcome: "restored", moved: true };
    });

    const firstPass = await reconcileArchivedTasksIntoDonePass(store as never, { limit: 4 });
    const secondPass = await reconcileArchivedTasksIntoDonePass(store as never, { limit: 4 });

    expect(firstPass).toMatchObject({ movedCount: 0, restoredCount: 1, hasMore: true });
    expect(secondPass).toMatchObject({ movedCount: 1, restoredCount: 0, hasMore: true });
    expect(store.listTasks).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 2, offset: 0 }));
    expect(store.listTasks).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 2, offset: 2 }));
    expect(mocks.listArchivedTaskEntriesPageTolerant).toHaveBeenNthCalledWith(1, store.asyncLayer.db, 2, 0, "project-1");
    expect(rows.get(pausedA.id)).toMatchObject({ column: "archived", userPaused: true });
    expect(rows.get(pausedB.id)).toMatchObject({ column: "archived", userPaused: true });
    expect(rows.get(trailingLive.id)).toMatchObject({ column: "done" });
  });

  it("drains more than one historical page in one cooperative cycle", async () => {
    const archived = Array.from({ length: 205 }, (_, index) => task(`FN-${30000 + index}`));
    const { store, rows } = makeStore(archived);

    const result = await drainArchivedTasksIntoDone(store as never, { limit: 200 });

    expect(result).toMatchObject({ movedCount: 205, restoredCount: 0, hasMore: false });
    expect(new Set(result.outcomes.map((item) => item.taskId)).size).toBe(205);
    expect([...rows.values()].filter((value) => value.column === "done")).toHaveLength(205);
  });

  it("yields a repeatedly failing row after the shared starvation budget", async () => {
    const failing = task("FN-29509");
    const { store } = makeStore([failing]);
    store.moveTaskIf.mockRejectedValue(new Error("move failed"));

    const firstPass = await reconcileArchivedTasksIntoDonePass(store as never, {
      limit: 2,
      maxFailureAttempts: 1,
    });
    const yieldedPass = await reconcileArchivedTasksIntoDonePass(store as never, {
      limit: 2,
      maxFailureAttempts: 1,
    });
    const retryPass = await reconcileArchivedTasksIntoDonePass(store as never, {
      limit: 2,
      maxFailureAttempts: 1,
    });

    expect(firstPass.outcomes).toEqual([
      { taskId: failing.id, source: "live-column", outcome: "failed" },
    ]);
    expect(yieldedPass.outcomes).toEqual([]);
    expect(retryPass.outcomes).toEqual([
      { taskId: failing.id, source: "live-column", outcome: "retained", reason: "failure-budget" },
    ]);
    expect(store.moveTaskIf).toHaveBeenCalledTimes(1);
  });
});
