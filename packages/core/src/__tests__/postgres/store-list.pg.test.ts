/**
 * FNXC:SqliteFinalRemoval 2026-06-25-11:05:
 * PostgreSQL-backed counterpart of the listTasks portions of store-create.test.ts
 * and store-sort.test.ts. Validates the public TaskStore.listTasks() facade
 * (the primary board read path) against PostgreSQL backend mode, covering
 * column filtering, slim vs full hydration, soft-delete exclusion, and
 * createdAt-then-numeric-id sort ordering.
 *
 * Migrated from `new TaskStore(rootDir, globalDir, { inMemoryDb: true })`
 * (SQLite) to `createSharedPgTaskStoreTestHarness` (PostgreSQL).
 */
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore.listTasks facade (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_list",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  it("returns an empty array when the board has no tasks", async () => {
    const tasks = await h.store().listTasks();
    expect(tasks).toEqual([]);
  });

  it("atomically replaces the sole active task workflow continuation", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "continuation owner", column: "todo" });
    const first = await store.replaceActiveTaskWorkflowContinuation({
      runId: `${task.id}:continuation:0`,
      taskId: task.id,
      nodeId: "plan-review",
      kind: "task",
      state: "runnable",
      stableWorkflowRunId: `${task.id}:workflow`,
      continuationSequence: 0,
      waitReason: "planning",
      sourceColumn: "todo",
      targetColumn: "todo",
      irHash: "ir-v1",
    });
    const second = await store.replaceActiveTaskWorkflowContinuation({
      runId: `${task.id}:continuation:1`,
      taskId: task.id,
      nodeId: "parse",
      kind: "task",
      state: "held",
      stableWorkflowRunId: `${task.id}:workflow`,
      continuationSequence: 1,
      waitReason: "capacity",
      sourceColumn: "todo",
      targetColumn: "in-progress",
      irHash: "ir-v1",
    });

    expect((await store.getWorkflowWorkItem(first.id))?.state).toBe("succeeded");
    expect(second).toMatchObject({
      state: "held",
      waitReason: "capacity",
      sourceColumn: "todo",
      targetColumn: "in-progress",
      continuationSequence: 1,
    });
    await expect(store.upsertWorkflowWorkItem({
      runId: `${task.id}:continuation:2`,
      taskId: task.id,
      nodeId: "steps",
      kind: "task",
      state: "runnable",
    })).rejects.toThrow();
  });

  it("returns all live tasks sorted by createdAt then numeric id suffix", async () => {
    const store = h.store();
    // Seed with explicit ascending timestamps so ordering is deterministic.
    await store.createTaskWithReservedId(
      { description: "first", column: "todo" },
      { taskId: "FN-100", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", applyDefaultWorkflowSteps: false },
    );
    await store.createTaskWithReservedId(
      { description: "second", column: "todo" },
      { taskId: "FN-005", createdAt: "2026-01-01T00:00:00.001Z", updatedAt: "2026-01-01T00:00:00.001Z", applyDefaultWorkflowSteps: false },
    );
    await store.createTaskWithReservedId(
      { description: "third", column: "todo" },
      { taskId: "FN-010", createdAt: "2026-01-01T00:00:00.001Z", updatedAt: "2026-01-01T00:00:00.001Z", applyDefaultWorkflowSteps: false },
    );

    const tasks = await store.listTasks();
    // createdAt ASC; ties broken by numeric id suffix ASC.
    expect(tasks.map((t) => t.id)).toEqual(["FN-100", "FN-005", "FN-010"]);
  });

  it("limit/offset paginate in SQL with the same (createdAt, numeric id suffix) order as the full list", async () => {
    /*
    FNXC:TaskStoreReadsPerf 2026-07-11 (PR #1793 review):
    Pagination moved from a client-side slice over the WHOLE table to SQL
    LIMIT/OFFSET with an ORDER BY matching the JS comparator. This pins that
    the SQL page equals the old client-side page — including the numeric id
    tiebreak ("FN-5" before "FN-10" despite string order) and composition
    with the column filter.
    */
    const store = h.store();
    const seed = async (taskId: string, createdAt: string, column: string) =>
      store.createTaskWithReservedId(
        { description: `seed ${taskId}`, column: column as "todo" },
        { taskId, createdAt, updatedAt: createdAt, applyDefaultWorkflowSteps: false },
      );
    await seed("FN-100", "2026-01-01T00:00:00.000Z", "todo");
    await seed("FN-005", "2026-01-01T00:00:00.001Z", "todo");
    await seed("FN-010", "2026-01-01T00:00:00.001Z", "todo");
    await seed("FN-020", "2026-01-01T00:00:00.002Z", "in-review");
    await seed("FN-030", "2026-01-01T00:00:00.003Z", "todo");

    // Full order: FN-100, FN-005, FN-010, FN-020, FN-030.
    expect((await store.listTasks({ limit: 2 })).map((t) => t.id)).toEqual(["FN-100", "FN-005"]);
    expect((await store.listTasks({ offset: 1, limit: 2 })).map((t) => t.id)).toEqual(["FN-005", "FN-010"]);
    expect((await store.listTasks({ offset: 3 })).map((t) => t.id)).toEqual(["FN-020", "FN-030"]);
    expect((await store.listTasks({ offset: 99 })).length).toBe(0);
    expect((await store.listTasks({ limit: 0 })).length).toBe(0);
    // Pagination composes with the SQL column filter.
    expect((await store.listTasks({ column: "todo", offset: 2, limit: 2 })).map((t) => t.id)).toEqual(["FN-010", "FN-030"]);
  });

  it("archived cold-storage reads are scoped per project (shared archive table)", async () => {
    /*
    FNXC:MultiProjectIsolation 2026-07-12 (PR #2007 review P1):
    archive.archived_tasks is ONE shared table across every project on the
    embedded cluster. Writers stamp project_id; page/count/membership/search
    readers filter to the caller's project — otherwise project A's archived
    board lists project B's rows. Unbound (undefined) readers keep the
    pre-isolation whole-table behavior.
    */
    const db = h.layer().db;
    const now = new Date().toISOString();
    const makeEntry = (id: string): import("../../types.js").ArchivedTaskEntry => ({
      id,
      lineageId: id,
      description: `${id} archived body`,
      column: "archived",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: now,
    } as unknown as import("../../types.js").ArchivedTaskEntry);

    const { upsertArchivedTaskEntry } = await import("../../task-store/async/async-archive-lineage.js");
    const { listArchivedTaskEntriesPage, getArchivedRowCount, filterArchived, searchArchivedTasks } = await import("../../async-archive-db.js");

    await upsertArchivedTaskEntry(db, makeEntry("FN-901"), "proj-a");
    await upsertArchivedTaskEntry(db, makeEntry("FN-902"), "proj-b");

    // Page + count are scoped to the owner…
    expect((await listArchivedTaskEntriesPage(db, 10, 0, "proj-a")).map((e) => e.id)).toEqual(["FN-901"]);
    expect(await getArchivedRowCount(db, "proj-a")).toBe(1);
    expect(await getArchivedRowCount(db, "proj-b")).toBe(1);
    // …unbound readers still see the whole table (pre-isolation behavior).
    expect(await getArchivedRowCount(db)).toBe(2);
    // Membership and search respect the scope too.
    expect(await filterArchived(db, ["FN-901", "FN-902"], "proj-a")).toEqual(new Set(["FN-901"]));
    expect((await searchArchivedTasks(db, "archived body", 10, "proj-b")).map((e) => e.id)).toEqual(["FN-902"]);
  });

  it("column filter returns only tasks in that column", async () => {
    const store = h.store();
    await store.createTask({ description: "in todo", column: "todo" });
    const review = await store.createTask({ description: "in review", column: "in-review" });
    await store.createTask({ description: "another todo", column: "todo" });

    const reviewOnly = await store.listTasks({ column: "in-review" });
    expect(reviewOnly.map((t) => t.id)).toEqual([review.id]);
    expect(reviewOnly.length).toBe(1);
  });

  it("excludes soft-deleted tasks", async () => {
    const store = h.store();
    const keep = await store.createTask({ description: "keep me", column: "todo" });
    const drop = await store.createTask({ description: "drop me", column: "todo" });
    await store.deleteTask(drop.id);

    const tasks = await store.listTasks();
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(drop.id);
  });

  it("slim mode strips the log payload but keeps other JSON columns", async () => {
    const store = h.store();
    const created = await store.createTask({ description: "slim probe", column: "todo" });

    const slim = await store.listTasks({ slim: true });
    const target = slim.find((t) => t.id === created.id);
    expect(target).toBeDefined();
    expect(target!.log).toEqual([]);
    // Non-log JSON columns are retained (description is always present).
    expect(target!.description).toBe("slim probe");
  });

  it("limit and offset paginate the result set", async () => {
    const store = h.store();
    for (let i = 1; i <= 5; i += 1) {
      await store.createTaskWithReservedId(
        { description: `task ${i}`, column: "todo" },
        { taskId: `FN-PG-${i}`, createdAt: `2026-03-01T00:00:0${i}.000Z`, updatedAt: `2026-03-01T00:00:0${i}.000Z`, applyDefaultWorkflowSteps: false },
      );
    }

    const page1 = await store.listTasks({ limit: 2, offset: 0 });
    const page2 = await store.listTasks({ limit: 2, offset: 2 });
    expect(page1.map((t) => t.id)).toEqual(["FN-PG-1", "FN-PG-2"]);
    expect(page2.map((t) => t.id)).toEqual(["FN-PG-3", "FN-PG-4"]);
  });
});
