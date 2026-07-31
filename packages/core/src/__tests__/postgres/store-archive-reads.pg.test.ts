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

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-18:50 (batch-core):

  A CARD SITTING IN THE BOARD'S OWN ARCHIVE LANE IS ALREADY ARCHIVED.

  `archiveTask` refuses a card that is already archived. Keyed on the literal, a board whose archive
  lane is named `attic` did not refuse — the card was archived a second time, from a lane the board
  itself calls archived.

  THE FIXTURE MATTERS, and my first version of this test was vacuous because of it. Calling
  `archiveTask` first does NOT produce a renamed-lane card: the archive path stamps `column:
  "archived"` (`archiveEntryToTask`, serialization.ts:353), so the guard only ever sees the literal
  and both the literal and resolved forms pass. The card has to be MOVED into `attic` by an ordinary
  move for the renamed lane to reach the guard at all.

  The unarchive side is deliberately not covered here: its input always carries the literal by
  construction, which is recorded at that guard.
  */
  it("refuses to archive a card already sitting in the board's renamed archive lane", async () => {
    const store = h.store();
    const definition = await store.createWorkflowDefinition({
      name: "renamed-archive",
      ir: {
        version: "v2",
        name: "renamed-archive",
        columns: [
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "attic", name: "Attic", traits: [{ trait: "archived" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "building" }, { id: "end", kind: "end", column: "attic" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);
    const task = await store.createTask({ description: "already in the attic", workflowId: definition.id } as never);
    await store.moveTask(task.id, "attic" as never, { bypassGuards: true } as never);

    await expect(store.archiveTask(task.id, { cleanup: false } as never)).rejects.toThrow(/already archived/);
  });

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
    /*
    FNXC:ArchiveRestore 2026-07-31-09:25:
    `done`, because #2832 made restore return a card to the lane it was ARCHIVED FROM.

    This asserted `todo`, which was the old behaviour: `preArchiveColumn` has no database column, so
    the pre-#2832 code fell through to a literal and decided the destination the same way for every
    restore. The fixture above creates this card in `done`, so `done` is now the answer.

    MEASURED, NOT ASSUMED — and the result is narrower than "the lane it came from". Changing the
    fixture to `in-progress` and re-running returns **`todo`**, not `in-progress`. So a terminal lane
    is preserved while a WIP lane is re-queued, which is plausible product behaviour (a card cannot
    resume mid-execution after a restore) but is NOT what #2832's summary describes.

    Left asserting `done` rather than encoding a rule I inferred from two samples. The `in-progress`
    observation is flagged on #2832 for its owner: if re-queueing WIP is deliberate it deserves its
    own case, and if it is not, this snapshot-rebuild path still carries the defect #2832 fixed
    elsewhere.

    Note this assertion is weaker than it looks and cannot be strengthened here: `done` is also the
    complete lane, which is what the pre-#2832 "no usable history" branch returned, so a card
    archived from `done` reads the same under both implementations.
    */
    expect(restored.column).toBe("done");
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
