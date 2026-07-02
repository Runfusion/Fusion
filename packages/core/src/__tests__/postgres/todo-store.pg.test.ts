/**
 * FNXC:TodoStore 2026-06-27-04:00:
 * PostgreSQL integration coverage for the TodoStore port. `store.getTodoStore()`
 * previously THREW "TodoStore is not available in PG backend mode" (the dashboard
 * /api/todos routes 500'd); it now returns the AsyncDataLayer-backed
 * AsyncTodoStore. This drives the real wiring (getTodoStoreImpl → AsyncTodoStore)
 * through the shared PG harness and asserts the full list/item CRUD round-trip:
 * create, sortOrder auto-assignment, completed→completedAt toggle, reorder,
 * and list-with-items grouping. Runs in the blocking gate (test:pg-gate).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncTodoStore } from "../../async-todo-store.js";

const pgTest = pgDescribe;

pgTest("TodoStore (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_todo_store",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getTodoStore() returns AsyncTodoStore (async methods).
  const todo = (): AsyncTodoStore => h.store().getTodoStore() as AsyncTodoStore;

  it("does not throw when resolving the store in backend mode", () => {
    expect(h.store().backendMode).toBe(true);
    expect(() => todo()).not.toThrow();
  });

  it("full list + item CRUD round-trip persists to project.todo_lists/items", async () => {
    const t = todo();

    const list = await t.createList("P-TODO", { title: "Groceries" });
    expect(list.id).toMatch(/^TDL-/);
    expect(list.title).toBe("Groceries");

    await t.createItem(list.id, { text: "milk" });
    await t.createItem(list.id, { text: "eggs" });

    const withItems = await t.getListsWithItems("P-TODO");
    const mine = withItems.find((l) => l.id === list.id);
    expect(mine?.items.map((i) => i.text)).toEqual(["milk", "eggs"]);
    // sortOrder is auto-assigned 0,1 by the helper.
    expect(mine?.items.map((i) => i.sortOrder)).toEqual([0, 1]);

    // Toggle complete sets completedAt.
    const first = mine!.items[0]!;
    const toggled = await t.updateItem(first.id, { completed: true });
    expect(toggled?.completed).toBe(true);
    expect(toggled?.completedAt).toBeTruthy();

    // Reorder swaps the two items.
    const ids = mine!.items.map((i) => i.id);
    const reordered = await t.reorderItems(list.id, [ids[1]!, ids[0]!]);
    expect(reordered[0]!.id).toBe(ids[1]);
    expect(reordered[0]!.sortOrder).toBe(0);

    // Delete an item, then the list.
    expect(await t.deleteItem(ids[0]!)).toBe(true);
    expect((await t.getListsWithItems("P-TODO"))[0]!.items).toHaveLength(1);
    expect(await t.deleteList(list.id)).toBe(true);
    expect(await t.getListsWithItems("P-TODO")).toHaveLength(0);
  });

  it("createItem rejects a missing list with a clear error (parity with sync store)", async () => {
    await expect(todo().createItem("TDL-DOES-NOT-EXIST", { text: "x" })).rejects.toThrow(/not found/);
  });
});
