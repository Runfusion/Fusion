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

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";

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

  it("exposes sync TodoStore read-method parity", async () => {
    const t = todo();
    const list = await t.createList("P-TODO-READS", { title: "Read parity" });
    const first = await t.createItem(list.id, { text: "first" });
    const second = await t.createItem(list.id, { text: "second" });

    expect(await t.getList(list.id)).toMatchObject({ id: list.id, title: "Read parity" });
    expect(await t.getItem(first.id)).toMatchObject({ id: first.id, text: "first" });
    expect((await t.listItems(list.id)).map((item) => item.id)).toEqual([first.id, second.id]);
    expect(await t.getList("TDL-MISSING")).toBeUndefined();
    expect(await t.getItem("TDI-MISSING")).toBeUndefined();
  });

  it("createItem rejects a missing list with a clear error (parity with sync store)", async () => {
    await expect(todo().createItem("TDL-DOES-NOT-EXIST", { text: "x" })).rejects.toThrow(/not found/);
  });

  /**
   * FNXC:PostgresMigrationCoverage 2026-07-13-22:54:
   * PostgreSQL stores every project's todo lists in one physical table, so list reads must retain the former per-project SQLite-file isolation for empty and populated projects.
   */
  it("does not expose another project's lists or items", async () => {
    const t = todo();
    const alpha = await t.createList("project-alpha", { title: "Alpha" });
    const beta = await t.createList("project-beta", { title: "Beta" });
    await t.createItem(alpha.id, { text: "alpha-only" });
    await t.createItem(beta.id, { text: "beta-only" });

    expect((await t.getListsWithItems("project-empty"))).toEqual([]);
    expect((await t.getListsWithItems("project-alpha")).map((list) => list.title)).toEqual(["Alpha"]);
    expect((await t.getListsWithItems("project-alpha"))[0]?.items.map((item) => item.text)).toEqual(["alpha-only"]);
    expect((await t.getListsWithItems("project-beta"))[0]?.items.map((item) => item.text)).toEqual(["beta-only"]);
  });

  /**
   * FNXC:PostgresMigrationCoverage 2026-07-13-22:54:
   * Todo mutations must retain the exact SQLite EventEmitter contract because dashboard SSE subscribers use these payloads to refresh lists and items without polling.
   */
  it("emits the sync TodoStore event names and payloads after successful mutations", async () => {
    const t = todo();
    const onListCreated = vi.fn();
    const onListUpdated = vi.fn();
    const onListDeleted = vi.fn();
    const onItemCreated = vi.fn();
    const onItemUpdated = vi.fn();
    const onItemDeleted = vi.fn();
    const onItemsReordered = vi.fn();
    t.on("list:created", onListCreated);
    t.on("list:updated", onListUpdated);
    t.on("list:deleted", onListDeleted);
    t.on("item:created", onItemCreated);
    t.on("item:updated", onItemUpdated);
    t.on("item:deleted", onItemDeleted);
    t.on("items:reordered", onItemsReordered);

    const list = await t.createList("project-events", { title: "Before" });
    expect(onListCreated).toHaveBeenCalledWith(list);
    const updatedList = await t.updateList(list.id, { title: "After" });
    expect(onListUpdated).toHaveBeenCalledWith(updatedList);

    const first = await t.createItem(list.id, { text: "first" });
    const second = await t.createItem(list.id, { text: "second" });
    expect(onItemCreated).toHaveBeenNthCalledWith(1, first);
    expect(onItemCreated).toHaveBeenNthCalledWith(2, second);
    const updatedItem = await t.updateItem(first.id, { completed: true });
    expect(onItemUpdated).toHaveBeenCalledWith(updatedItem);

    const reordered = await t.reorderItems(list.id, [second.id, first.id]);
    expect(onItemsReordered).toHaveBeenCalledWith({ listId: list.id, items: reordered });
    expect(await t.deleteItem(first.id)).toBe(true);
    expect(onItemDeleted).toHaveBeenCalledWith(first.id);
    expect(await t.deleteList(list.id)).toBe(true);
    expect(onListDeleted).toHaveBeenCalledWith(list.id);
  });

  it("does not emit update or delete events for missing records", async () => {
    const t = todo();
    const onListUpdated = vi.fn();
    const onListDeleted = vi.fn();
    const onItemUpdated = vi.fn();
    const onItemDeleted = vi.fn();
    t.on("list:updated", onListUpdated);
    t.on("list:deleted", onListDeleted);
    t.on("item:updated", onItemUpdated);
    t.on("item:deleted", onItemDeleted);

    expect(await t.updateList("TDL-MISSING", { title: "x" })).toBeUndefined();
    expect(await t.deleteList("TDL-MISSING")).toBe(false);
    expect(await t.updateItem("TDI-MISSING", { text: "x" })).toBeUndefined();
    expect(await t.deleteItem("TDI-MISSING")).toBe(false);
    expect(onListUpdated).not.toHaveBeenCalled();
    expect(onListDeleted).not.toHaveBeenCalled();
    expect(onItemUpdated).not.toHaveBeenCalled();
    expect(onItemDeleted).not.toHaveBeenCalled();
  });
});
