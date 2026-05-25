import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TombstonedTaskResurrectionError } from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("FN-5233 tombstoned createTask behavior", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("throws TombstonedTaskResurrectionError when recreating a tombstoned id", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "a", description: "alpha", column: "todo" });
    await store.deleteTask(task.id);
    const created: string[] = [];
    store.on("task:created", (event) => created.push(event.id));

    await expect(
      store.createTaskWithReservedId({ title: "b", description: "beta", column: "todo" }, { taskId: task.id }),
    ).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);

    const row = (store as any).db.prepare("SELECT deletedAt, allowResurrection FROM tasks WHERE id = ?").get(task.id) as {
      deletedAt: string | null;
      allowResurrection: number;
    };
    expect(row.deletedAt).toBeTruthy();
    expect(row.allowResurrection).toBe(0);
    expect(created).toEqual([]);
  });

  it("allows forceResurrect recreation and clears allowResurrection", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "a", description: "alpha", column: "todo" });
    await store.deleteTask(task.id, { allowResurrection: true });

    const created: string[] = [];
    store.on("task:created", (event) => created.push(event.id));
    const recreated = await store.createTaskWithReservedId(
      { title: "c", description: "charlie", forceResurrect: true, column: "todo" },
      { taskId: task.id },
    );
    expect(recreated.id).toBe(task.id);
    expect(created).toEqual([task.id]);

    const row = (store as any).db.prepare("SELECT deletedAt, allowResurrection FROM tasks WHERE id = ?").get(task.id) as {
      deletedAt: string | null;
      allowResurrection: number;
    };
    expect(row.deletedAt).toBeNull();
    expect(row.allowResurrection).toBe(0);
  });

  it("allows recreation when tombstone row has allowResurrection=1", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "a", description: "alpha", column: "todo" });
    await store.deleteTask(task.id, { allowResurrection: true });

    const recreated = await store.createTaskWithReservedId({ title: "d", description: "delta", column: "todo" }, { taskId: task.id });
    expect(recreated.id).toBe(task.id);
    const row = (store as any).db.prepare("SELECT deletedAt, allowResurrection FROM tasks WHERE id = ?").get(task.id) as {
      deletedAt: string | null;
      allowResurrection: number;
    };
    expect(row.deletedAt).toBeNull();
    expect(row.allowResurrection).toBe(0);
  });

  it("records task:resurrection-blocked audit for createTask refusal", async () => {
    const store = harness.store();
    const task = await store.createTask({ title: "a", description: "alpha", column: "todo" });
    await store.deleteTask(task.id);

    await expect(
      store.createTaskWithReservedId({ title: "b", description: "beta", column: "todo" }, { taskId: task.id }),
    ).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);

    const events = (store as any).db.prepare(
      "SELECT mutationType, metadata FROM runAuditEvents WHERE taskId = ? AND mutationType = ?"
    ).all(task.id, "task:resurrection-blocked") as Array<{ mutationType: string; metadata: string | null }>;
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.metadata ?? "").toContain("createTask");
  });
});
