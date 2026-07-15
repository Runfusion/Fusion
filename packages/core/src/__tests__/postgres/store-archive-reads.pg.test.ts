/**
 * FNXC:PostgresArchiveReads 2026-07-14-17:07:
 * PostgreSQL cold storage is part of the public TaskStore read model. After a real archiveTask call, includeArchived list/search and task detail must read the archive snapshot, while active-only reads must continue to exclude it. Merged pagination is applied after active and archived results are composed so page boundaries cannot silently drop cold-storage tasks.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { findArchivedTaskEntry } from "../../task-store/async-archive-lineage.js";

pgDescribe("TaskStore archived read parity (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_archive_reads",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("composes archived snapshots into list, search, and detail reads", async () => {
    const store = h.store();
    const first = await store.createTaskWithReservedId(
      { description: "active alpha", column: "todo" },
      {
        taskId: "FN-101",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        applyDefaultWorkflowSteps: false,
      },
    );
    const archivedSource = await store.createTaskWithReservedId(
      { description: "cold-storage-needle beta", column: "done" },
      {
        taskId: "FN-102",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        applyDefaultWorkflowSteps: false,
      },
    );
    const last = await store.createTaskWithReservedId(
      { description: "active gamma", column: "todo" },
      {
        taskId: "FN-103",
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        applyDefaultWorkflowSteps: false,
      },
    );
    await store.archiveTask(archivedSource.id, { cleanup: false });

    expect((await store.listTasks({ includeArchived: false })).map((task) => task.id)).toEqual([
      first.id,
      last.id,
    ]);
    expect((await store.listTasks({ includeArchived: true })).map((task) => task.id)).toEqual([
      first.id,
      archivedSource.id,
      last.id,
    ]);
    expect((await store.listTasks({ includeArchived: true, column: "archived" })).map((task) => task.id)).toEqual([
      archivedSource.id,
    ]);
    expect((await store.listTasks({ includeArchived: true, limit: 1, offset: 1 })).map((task) => task.id)).toEqual([
      archivedSource.id,
    ]);

    const slim = await store.listTasks({ includeArchived: true, column: "archived", slim: true });
    expect(slim[0]?.log).toEqual([]);
    const full = await store.listTasks({ includeArchived: true, column: "archived", slim: false });
    expect(full[0]?.log).not.toEqual([]);

    expect(await store.searchTasks("cold-storage-needle", { includeArchived: false })).toEqual([]);
    expect((await store.searchTasks("cold-storage-needle", { includeArchived: true })).map((task) => task.id)).toEqual([
      archivedSource.id,
    ]);
    expect((await store.searchTasks("alpha cold-storage-needle", {
      includeArchived: true,
      limit: 1,
      offset: 1,
    })).map((task) => task.id)).toEqual([archivedSource.id]);

    const detail = await store.getTask(archivedSource.id);
    expect(detail.id).toBe(archivedSource.id);
    expect(detail.column).toBe("archived");
    expect(detail.description).toBe("cold-storage-needle beta");
    expect(detail.prompt).toContain("cold-storage-needle beta");
  });

  it("keeps globally ordered pages exact across multiple live/cold boundaries", async () => {
    const store = h.store();
    const tasks = [];
    for (let index = 1; index <= 12; index += 1) {
      tasks.push(await store.createTaskWithReservedId(
        { description: `bounded-page-probe ${index}`, column: index % 2 === 0 ? "todo" : "done" },
        {
          taskId: `FN-${200 + index}`,
          createdAt: `2026-02-${String(index).padStart(2, "0")}T00:00:00.000Z`,
          updatedAt: `2026-02-${String(index).padStart(2, "0")}T00:00:00.000Z`,
          applyDefaultWorkflowSteps: false,
        },
      ));
    }
    for (const task of tasks.filter((_, index) => index % 2 === 0)) {
      await store.archiveTask(task.id, { cleanup: false });
    }

    /*
    FNXC:PostgresArchiveReadPerformance 2026-07-14-17:50:
    Small pages that cross several live/cold boundaries must remain identical to a complete globally ordered merge; bounding each source query must never shift or omit a row at the page edge.
    */
    expect((await store.listTasks({ includeArchived: true, offset: 7, limit: 3 })).map((task) => task.id)).toEqual([
      "FN-208",
      "FN-209",
      "FN-210",
    ]);
    expect((await store.searchTasks("bounded-page-probe", { includeArchived: true, offset: 5, limit: 3 })).map((task) => task.id)).toEqual([
      "FN-212",
      "FN-211",
      "FN-209",
    ]);
  });

  /*
  FNXC:ArchiveRestore 2026-07-14-21:48:
  Cold storage is sufficient to reconstruct a task whose project.tasks row was removed by cleanup. Unarchive must materialize the snapshot before consuming it, while the pre-existing live archived-row path remains supported without requiring a snapshot.
  */
  it("rebuilds a missing live row before consuming its archive snapshot", async () => {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: "restore from snapshot only", column: "done" },
      { taskId: "FN-301", applyDefaultWorkflowSteps: false },
    );
    await store.archiveTask(task.id, { cleanup: false });
    expect(await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).toBeDefined();

    await h.adminDb()
      .delete(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, h.layer().projectId ?? "__legacy_unscoped__"),
        eq(schema.project.tasks.id, task.id),
      ));

    const persistRestoredRow = store.atomicWriteTaskJson.bind(store);
    const persistSpy = vi.spyOn(store, "atomicWriteTaskJson").mockImplementation(async (dir, restoredTask) => {
      await persistRestoredRow(dir, restoredTask);
      const durableRows = await h.adminDb()
        .select({ id: schema.project.tasks.id })
        .from(schema.project.tasks)
        .where(and(
          eq(schema.project.tasks.projectId, h.layer().projectId ?? "__legacy_unscoped__"),
          eq(schema.project.tasks.id, task.id),
        ));
      expect(durableRows).toHaveLength(1);
      expect(await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).toBeDefined();
    });

    const restored = await store.unarchiveTask(task.id);
    expect(persistSpy).toHaveBeenCalledOnce();
    expect(restored.id).toBe(task.id);
    expect(restored.description).toBe("restore from snapshot only");
    expect(restored.column).toBe("todo");
    expect(await findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).toBeUndefined();
  });

  it("keeps the existing live archived-row unarchive path", async () => {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: "live archived row", column: "archived" },
      { taskId: "FN-302", applyDefaultWorkflowSteps: false },
    );

    const restored = await store.unarchiveTask(task.id);
    expect(restored.id).toBe(task.id);
    expect(restored.column).toBe("todo");
  });
});
