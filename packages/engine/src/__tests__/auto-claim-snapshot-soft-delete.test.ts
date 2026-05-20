import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, type Task } from "@fusion/core";
import { AutoClaimSnapshotManager } from "../auto-claim-snapshot.js";

describe("AutoClaimSnapshotManager soft-delete guards", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-5137-engine-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "fn-5137-engine-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(() => {
    store.stopWatching();
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("returns only live todo tasks after soft delete", async () => {
    const live = await store.createTask({ title: "Live", description: "live" });
    const deleted = await store.createTask({ title: "Deleted", description: "deleted" });
    await store.moveTask(live.id, "todo");
    await store.moveTask(deleted.id, "todo");
    await store.deleteTask(deleted.id);

    const manager = new AutoClaimSnapshotManager({ taskStore: store });
    const snapshot = await manager.getSnapshot();

    expect(snapshot.tasks.map((task) => task.id)).toEqual([live.id]);
  });

  it("omits a checked-out task once it is soft-deleted", async () => {
    const live = await store.createTask({ title: "Live", description: "live" });
    const checkedOutDeleted = await store.createTask({ title: "Checked out", description: "checked out" });
    await store.moveTask(live.id, "todo");
    await store.moveTask(checkedOutDeleted.id, "todo");
    await store.updateTask(checkedOutDeleted.id, {
      checkedOutBy: "agent-1",
      checkoutLeaseEpoch: 1,
      checkoutNodeId: "node-1",
    });
    await store.deleteTask(checkedOutDeleted.id);

    const manager = new AutoClaimSnapshotManager({ taskStore: store });
    const snapshot = await manager.getSnapshot();

    expect(snapshot.tasks.map((task) => task.id)).toEqual([live.id]);
  });

  it("drops deleted ids after cache invalidation and rebuild", async () => {
    let includeDeletedCandidate = true;
    const listTasks = vi.fn(async () => ([
      {
        id: "FN-001",
        title: "First",
        description: "first",
        status: "open",
        column: "todo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        dependencies: [],
        comments: [],
        steps: [],
        currentStep: 0,
        log: [],
        deletedAt: null,
      },
      ...(includeDeletedCandidate
        ? [{
          id: "FN-002",
          title: "Second",
          description: "second",
          status: "open",
          column: "todo",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          dependencies: [],
          comments: [],
          steps: [],
          currentStep: 0,
          log: [],
          deletedAt: null,
        }]
        : []),
    ] as unknown as Task[]));

    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks } });
    const beforeDelete = await manager.getSnapshot();
    expect(beforeDelete.tasks.map((task) => task.id)).toEqual(["FN-001", "FN-002"]);

    includeDeletedCandidate = false;
    manager.invalidate("task:deleted");

    const afterDelete = await manager.getSnapshot();
    expect(afterDelete.tasks.map((task) => task.id)).toEqual(["FN-001"]);
  });

  it("defense-in-depth filters checked-out soft-deleted candidates from synthetic listTasks results", async () => {
    const listTasks = vi.fn(async () => ([
      {
        id: "FN-live",
        title: "Live",
        description: "live",
        status: "open",
        column: "todo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        dependencies: [],
        comments: [],
        steps: [],
        currentStep: 0,
        log: [],
        checkedOutBy: null,
        deletedAt: null,
      },
      {
        id: "FN-deleted",
        title: "Deleted",
        description: "deleted",
        status: "open",
        column: "todo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        dependencies: [],
        comments: [],
        steps: [],
        currentStep: 0,
        log: [],
        checkedOutBy: "agent-1",
        deletedAt: "2026-01-02T00:00:00.000Z",
      },
    ] as unknown as Task[]));

    const manager = new AutoClaimSnapshotManager({ taskStore: { listTasks } });
    const snapshot = await manager.getSnapshot();

    expect(snapshot.tasks.map((task) => task.id)).toEqual(["FN-live"]);
  });
});
