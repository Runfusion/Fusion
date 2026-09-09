import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import { buildTaskInsertValues } from "../../task-store/async/async-persistence.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("TaskStore completed-task pagination", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_done_page" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("returns bounded, non-overlapping Done pages with an exact live total", async () => {
    const store = h.store();
    const first = await store.createTask({ description: "first done", column: "done" });
    const current = await store.createTask({ description: "current", column: "todo" });
    const second = await store.createTask({ description: "second done", column: "done" });
    const deleted = await store.createTask({ description: "deleted done", column: "done" });
    const third = await store.createTask({ description: "third done", column: "done" });
    await store.deleteTask(deleted.id);
    await Promise.all([
      [first.id, "2026-08-01T00:00:00.000Z"],
      [second.id, "2026-08-02T00:00:00.000Z"],
      [third.id, "2026-08-04T00:00:00.000Z"],
    ].map(([id, columnMovedAt]) => h.layer().db
      .update(schema.project.tasks)
      .set({ columnMovedAt })
      .where(eq(schema.project.tasks.id, id!))));

    const pageOne = await store.listCompletedTasks({ limit: 2, slim: true });
    const pageTwo = await store.listCompletedTasks({ limit: 2, cursor: pageOne.nextCursor!, slim: true });

    expect(pageOne.total).toBe(3);
    expect(pageOne.hasMore).toBe(true);
    expect(pageTwo.total).toBe(3);
    expect(pageTwo.hasMore).toBe(false);
    expect(pageOne.tasks).toHaveLength(2);
    expect(pageTwo.tasks).toHaveLength(1);
    expect([...pageOne.tasks, ...pageTwo.tasks].map((task) => task.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
    expect([...pageOne.tasks, ...pageTwo.tasks].map((task) => task.id)).not.toContain(current.id);
    expect([...pageOne.tasks, ...pageTwo.tasks].map((task) => task.id)).not.toContain(deleted.id);
  });

  it("pages every completed row beyond the former 200-item boundary for both sorts", async () => {
    const store = h.store();
    const rows = Array.from({ length: 205 }, (_, index) => {
      const id = `FN-${40000 + index}`;
      const timestamp = new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString();
      return buildTaskInsertValues({
        id,
        description: `historical delivery ${index}`,
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        columnMovedAt: timestamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(rows as never);

    for (const sort of ["completion-date-desc", "task-id-desc"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listCompletedTasks({ limit: 50, cursor, sort });
        seen.push(...page.tasks.map((task) => task.id));
        expect(page.total).toBe(205);
        expect(page.counts.byColumn.done).toBe(205);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toHaveLength(205);
      expect(new Set(seen).size).toBe(205);
    }
  });

  it("keeps a newer live insertion out of an existing continuation and includes it after refresh", async () => {
    const store = h.store();
    const older = await store.createTask({ description: "older", column: "done" });
    const oldest = await store.createTask({ description: "oldest", column: "done" });
    await h.layer().db.update(schema.project.tasks).set({ columnMovedAt: "2026-09-01T00:00:00.000Z" }).where(eq(schema.project.tasks.id, older.id));
    await h.layer().db.update(schema.project.tasks).set({ columnMovedAt: "2026-08-01T00:00:00.000Z" }).where(eq(schema.project.tasks.id, oldest.id));
    const first = await store.listCompletedTasks({ limit: 1 });
    const newest = await store.createTask({ description: "newest live", column: "done" });
    await h.layer().db.update(schema.project.tasks).set({ columnMovedAt: "2026-10-01T00:00:00.000Z" }).where(eq(schema.project.tasks.id, newest.id));

    const continuation = await store.listCompletedTasks({ limit: 10, cursor: first.nextCursor! });
    expect(continuation.tasks.map((task) => task.id)).toContain(oldest.id);
    expect(continuation.tasks.map((task) => task.id)).not.toContain(newest.id);
    expect((await store.listCompletedTasks({ limit: 10 })).tasks.map((task) => task.id)).toContain(newest.id);
  });

  it("orders every task-id page in SQL before applying keysets", async () => {
    const store = h.store();
    const high = await store.createTaskWithReservedId(
      { description: "high id", column: "done" },
      { taskId: "FN-29520", applyDefaultWorkflowSteps: false },
    );
    const low = await store.createTaskWithReservedId(
      { description: "low id", column: "done" },
      { taskId: "FN-29503", applyDefaultWorkflowSteps: false },
    );
    const middle = await store.createTaskWithReservedId(
      { description: "middle id", column: "done" },
      { taskId: "FN-29511", applyDefaultWorkflowSteps: false },
    );

    const pageOne = await store.listCompletedTasks({ limit: 2, sort: "task-id-desc" });
    const pageTwo = await store.listCompletedTasks({ limit: 2, cursor: pageOne.nextCursor!, sort: "task-id-desc" });

    expect([...pageOne.tasks, ...pageTwo.tasks].map((task) => task.id)).toEqual([
      high.id,
      middle.id,
      low.id,
    ]);
    await expect(store.listCompletedTasks({ cursor: "not-a-cursor", sort: "task-id-desc" }))
      .rejects.toThrow("Invalid completed-task cursor");
    await expect(store.listCompletedTasks({ cursor: pageOne.nextCursor!, sort: "completion-date-desc" }))
      .rejects.toThrow("Invalid completed-task cursor");
    const foreignPayload = JSON.parse(Buffer.from(pageOne.nextCursor!, "base64url").toString("utf8"));
    foreignPayload.projectId = "another-project";
    const foreignCursor = Buffer.from(JSON.stringify(foreignPayload), "utf8").toString("base64url");
    await expect(store.listCompletedTasks({ cursor: foreignCursor, sort: "task-id-desc" }))
      .rejects.toThrow("Invalid completed-task cursor");
  });

  it("reports exact column and workflow counts with absent selections on the effective default", async () => {
    const store = h.store();
    const inherited = await store.createTask({ description: "default workflow", column: "done" });
    const selected = await store.createTask({ description: "selected workflow", column: "done" });
    const [selectedRow] = await h.layer().db.select({ projectId: schema.project.tasks.projectId }).from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, selected.id));
    await h.layer().db.delete(schema.project.taskWorkflowSelection)
      .where(eq(schema.project.taskWorkflowSelection.taskId, inherited.id));
    await h.layer().db.update(schema.project.taskWorkflowSelection)
      .set({ workflowId: "WF-OTHER", updatedAt: "2026-09-08T00:00:00.000Z" })
      .where(and(
        eq(schema.project.taskWorkflowSelection.projectId, selectedRow!.projectId),
        eq(schema.project.taskWorkflowSelection.taskId, selected.id),
      ));

    const page = await store.listCompletedTasks();
    expect(page.counts.byColumn.done).toBe(2);
    expect(page.counts.byWorkflow["builtin:coding"]?.done).toBe(1);
    expect(page.counts.byWorkflow["WF-OTHER"]?.done).toBe(1);
    expect(page.tasks.map((task) => task.id)).toEqual(expect.arrayContaining([inherited.id, selected.id]));
  });

  it("keeps full-text search pages bounded and rejects a cursor from another query", async () => {
    const store = h.store();
    const rows = Array.from({ length: 21 }, (_, index) => {
      const id = `FN-${51000 + index}`;
      const timestamp = "2026-09-07T01:00:00.000Z";
      return buildTaskInsertValues({
        id, description: `searchable incident ${index}`, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: timestamp, updatedAt: timestamp, columnMovedAt: timestamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(rows as never);

    const first = await store.listCurrentTasksPage({ limit: 10, query: "searchable" });
    const second = await store.listCurrentTasksPage({ limit: 10, query: "searchable", cursor: first.nextCursor! });
    const third = await store.listCurrentTasksPage({ limit: 10, query: "searchable", cursor: second.nextCursor! });

    expect(first.total).toBe(21);
    expect([...first.tasks, ...second.tasks, ...third.tasks]).toHaveLength(21);
    expect(new Set([...first.tasks, ...second.tasks, ...third.tasks].map((task) => task.id)).size).toBe(21);
    await expect(store.listCurrentTasksPage({ limit: 10, query: "different", cursor: first.nextCursor! }))
      .rejects.toThrow("Invalid task list cursor");
  });

  it("continues current-task pages by an exclusive created-at and id cursor", async () => {
    const store = h.store();
    const rows = Array.from({ length: 205 }, (_, index) => {
      const id = `FN-${50000 + index}`;
      const timestamp = "2026-09-07T00:00:00.000Z";
      return buildTaskInsertValues({
        id, description: `current ${index}`, column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: timestamp, updatedAt: timestamp, columnMovedAt: timestamp,
      }, { lineageId: `lineage-${id}` }, h.layer().projectId);
    });
    await h.layer().db.insert(schema.project.tasks).values(rows as never);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listCurrentTasksPage({ limit: 50, cursor });
      expect(page.total).toBe(205);
      seen.push(...page.tasks.map((task) => task.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(205);
    expect(new Set(seen).size).toBe(205);
  });
});
