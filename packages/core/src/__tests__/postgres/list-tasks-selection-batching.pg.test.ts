import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import type { Task, TaskStore } from "../../store.js";

const pgTest = pgDescribe;
const badgeFields = ["inReviewStall", "inReviewStalled", "stalePausedReview", "stalePausedTodo", "ageStaleness", "stalledReview"] as const;

pgTest("TaskStore list selection batching", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_list_selection_batch" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterEach(() => vi.restoreAllMocks());
  afterAll(h.afterAll);

  async function seedRows(count: number): Promise<string[]> {
    const store = h.store();
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const task = await store.createTask({ title: `selectionneedle ${index}`, description: "selection batching" });
      ids.push(task.id);
      if (index % 2 === 0) await store.writeTaskWorkflowSelection(task.id, "builtin:coding", []);
    }
    // Exercise badge hydration for both a review-lane and paused row while the
    // query-count assertions cover persisted and absent workflow selections.
    await h.adminDb().update(schema.project.tasks).set({ column: "in-review" }).where(eq(schema.project.tasks.id, ids[0]!));
    if (ids[1]) await h.adminDb().update(schema.project.tasks).set({ paused: 1 }).where(eq(schema.project.tasks.id, ids[1]!));
    store.taskCache.clear();
    return ids;
  }

  async function expectOneBatch(
    store: TaskStore,
    ids: string[],
    read: () => Promise<unknown>,
  ): Promise<void> {
    const single = vi.spyOn(store, "getTaskWorkflowSelectionAsync");
    const batch = vi.spyOn(store, "getTaskWorkflowSelectionsAsync");

    await read();

    expect(single).toHaveBeenCalledTimes(0);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(expect.arrayContaining(ids));
    expect(batch.mock.calls[0]?.[0]).toHaveLength(ids.length);
  }

  it.each([3, 12])("uses exactly one selection batch and no singular reads for %i list rows", async (count) => {
    const store = h.store();
    const ids = await seedRows(count);
    const tally = { batched: 0, singles: 0 };

    await expectOneBatch(store, ids, () => store.listTasks({ includeArchived: false, selectionReadTally: tally }));
    expect(tally).toEqual({ batched: 1, singles: 0 });
  });

  it.each([3, 12])("uses exactly one selection batch and no singular reads for %i search rows", async (count) => {
    const store = h.store();
    const ids = await seedRows(count);

    await expectOneBatch(store, ids, () => store.searchTasks("selectionneedle"));
  });

  it.each([3, 12])("uses exactly one selection batch and no singular reads for %i modified-since rows", async (count) => {
    const store = h.store();
    const ids = await seedRows(count);

    await expectOneBatch(store, ids, () => store.listTasksModifiedSince("2000-01-01T00:00:00.000Z"));
  });

  it("preserves every hydrated badge when the batch reader falls back to singular reads", async () => {
    const store = h.store();
    const ids = await seedRows(3);
    const batch = vi.spyOn(store, "getTaskWorkflowSelectionsAsync");
    const single = vi.spyOn(store, "getTaskWorkflowSelectionAsync");
    vi.spyOn(Date, "now").mockReturnValue(Date.now());

    const normal = await store.listTasks({ includeArchived: false });
    batch.mockClear();
    single.mockClear();
    batch.mockRejectedValueOnce(new Error("transient batch failure"));
    const fallback = await store.listTasks({ includeArchived: false });

    expect(batch).toHaveBeenCalledTimes(1);
    expect(single).toHaveBeenCalledTimes(ids.length);
    expect(
      fallback.map((task) => [task.id, Object.fromEntries(badgeFields.map((field) => [field, task[field]]))]),
    ).toEqual(
      normal.map((task) => [task.id, Object.fromEntries(badgeFields.map((field) => [field, task[field]]))]),
    );
  });

  it("reports the truthful singular fallback tally", async () => {
    const store = h.store();
    const ids = await seedRows(3);
    vi.spyOn(store, "getTaskWorkflowSelectionsAsync").mockRejectedValueOnce(new Error("transient"));
    const single = vi.spyOn(store, "getTaskWorkflowSelectionAsync");
    const tally = { batched: 0, singles: 0 };

    await store.listTasks({ includeArchived: false, selectionReadTally: tally });

    expect(tally).toEqual({ batched: 0, singles: ids.length });
    expect(single).toHaveBeenCalledTimes(ids.length);
  });

  it("does not query a caller-populated cache and batches only its missing ids", async () => {
    const store = h.store();
    const ids = await seedRows(3);
    const selectionCache = new Map<string, { workflowId: string; stepIds: string[] } | undefined>(
      ids.map((id) => [id, { workflowId: "builtin:coding", stepIds: [] }]),
    );
    const single = vi.spyOn(store, "getTaskWorkflowSelectionAsync");
    const batch = vi.spyOn(store, "getTaskWorkflowSelectionsAsync");
    const fullTally = { batched: 0, singles: 0 };

    await store.listTasks({ includeArchived: false, selectionCache, selectionReadTally: fullTally });

    expect(fullTally).toEqual({ batched: 0, singles: 0 });
    expect(batch).toHaveBeenCalledTimes(0);
    expect(single).toHaveBeenCalledTimes(0);

    selectionCache.delete(ids[2]!);
    const partialTally = { batched: 0, singles: 0 };
    await store.listTasks({ includeArchived: false, selectionCache, selectionReadTally: partialTally });

    expect(partialTally).toEqual({ batched: 1, singles: 0 });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenLastCalledWith([ids[2]]);
    expect(single).toHaveBeenCalledTimes(0);
  });
});
