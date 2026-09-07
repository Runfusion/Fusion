import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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

    const pageOne = await store.listCompletedTasks({ limit: 2, offset: 0, slim: true });
    const pageTwo = await store.listCompletedTasks({ limit: 2, offset: 2, slim: true });

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
      for (let offset = 0; ; offset += 50) {
        const page = await store.listCompletedTasks({ limit: 50, offset, sort });
        seen.push(...page.tasks.map((task) => task.id));
        expect(page.total).toBe(205);
        if (!page.hasMore) break;
      }
      expect(seen).toHaveLength(205);
      expect(new Set(seen).size).toBe(205);
    }
  });

  it("orders every task-id page in SQL before applying offsets", async () => {
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

    const pageOne = await store.listCompletedTasks({ limit: 2, offset: 0, sort: "task-id-desc" });
    const pageTwo = await store.listCompletedTasks({ limit: 2, offset: 2, sort: "task-id-desc" });

    expect([...pageOne.tasks, ...pageTwo.tasks].map((task) => task.id)).toEqual([
      high.id,
      middle.id,
      low.id,
    ]);
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
