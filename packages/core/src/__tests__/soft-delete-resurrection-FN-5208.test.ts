import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { TaskDeletedError } from "../store.js";
import type { Task } from "../types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("FN-5208 soft-delete resurrection guards", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("blocks readTaskJson file fallback when the DB row is soft-deleted", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", title: "resurrection target", description: "keep disk copy" });
    const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
    const diskTask = JSON.parse(await readFile(join(dir, "task.json"), "utf-8")) as Task;
    expect(diskTask.deletedAt).toBeUndefined();

    await store.deleteTask(task.id);

    await expect((store as any).readTaskJson(dir)).rejects.toBeInstanceOf(TaskDeletedError);
  });

  it("preserves legacy file-only fallback when no DB row exists", async () => {
    const store = harness.store();
    const taskId = "FN-9999";
    const dir = join(harness.rootDir(), ".fusion", "tasks", taskId);
    const now = new Date().toISOString();
    const fileTask: Task = {
      id: taskId,
      title: "legacy fallback",
      description: "file-only task",
      column: "todo",
      priority: "normal",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: now,
      updatedAt: now,
    };

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "task.json"), JSON.stringify(fileTask));

    await expect((store as any).readTaskJson(dir)).resolves.toMatchObject({
      id: taskId,
      title: "legacy fallback",
      description: "file-only task",
    });
  });

  it("refuses updateTask resurrection attempts and preserves deletedAt", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", title: "before delete", description: "original description" });

    await store.deleteTask(task.id);

    await expect(store.updateTask(task.id, { title: "after delete" })).rejects.toBeInstanceOf(TaskDeletedError);

    const row = (store as any).db
      .prepare("SELECT title, description, deletedAt FROM tasks WHERE id = ?")
      .get(task.id) as { title: string; description: string; deletedAt: string | null };
    expect(row.title).toBe("before delete");
    expect(row.description).toBe("original description");
    expect(typeof row.deletedAt).toBe("string");
  });

  it("refuses stale atomicWriteTaskJson upserts after delete", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", title: "pre-delete title", description: "pre-delete description" });
    const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
    const staleTask: Task = {
      ...task,
      title: "stale title",
      description: "stale description",
    };

    await store.deleteTask(task.id);

    await expect((store as any).atomicWriteTaskJson(dir, staleTask)).rejects.toBeInstanceOf(TaskDeletedError);

    const row = (store as any).db
      .prepare("SELECT title, description, deletedAt FROM tasks WHERE id = ?")
      .get(task.id) as { title: string; description: string; deletedAt: string | null };
    expect(row.title).toBe("pre-delete title");
    expect(row.description).toBe("pre-delete description");
    expect(typeof row.deletedAt).toBe("string");
  });

  it("does not emit task:created when stale create/write attempts target a deleted id", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", title: "created once", description: "do not recreate" });
    const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
    const createdEvents: string[] = [];
    store.on("task:created", (event) => createdEvents.push(event.id));

    await store.deleteTask(task.id);

    await expect((store as any).atomicCreateTaskJson(dir, { ...task, title: "stale recreate" }, "createTask")).rejects.toBeInstanceOf(TaskDeletedError);

    expect(createdEvents).toEqual([]);
  });

  it("keeps deleteTask idempotent and avoids task:updated on refused resurrection writes", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", title: "idempotent delete", description: "delete twice" });
    const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);
    const deletedEvents: string[] = [];
    const updatedEvents: string[] = [];
    store.on("task:deleted", (event) => deletedEvents.push(event.id));
    store.on("task:updated", (event) => updatedEvents.push(event.id));

    await store.deleteTask(task.id);
    const firstRow = (store as any).db
      .prepare("SELECT deletedAt, updatedAt FROM tasks WHERE id = ?")
      .get(task.id) as { deletedAt: string | null; updatedAt: string | null };
    await store.deleteTask(task.id);
    const secondRow = (store as any).db
      .prepare("SELECT deletedAt, updatedAt FROM tasks WHERE id = ?")
      .get(task.id) as { deletedAt: string | null; updatedAt: string | null };
    await expect((store as any).atomicWriteTaskJson(dir, { ...task, title: "resurrect me" })).rejects.toBeInstanceOf(TaskDeletedError);

    expect(firstRow.deletedAt).toBeTruthy();
    expect(secondRow.deletedAt).toBe(firstRow.deletedAt);
    expect(secondRow.updatedAt).toBe(firstRow.updatedAt);
    expect(deletedEvents).toEqual([task.id]);
    expect(updatedEvents).toEqual([]);
  });

  it("allows explicit deletedAt-carrying writes for legitimate soft-delete maintenance paths", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", title: "restore me", description: "restore path" });
    const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);

    await store.deleteTask(task.id);
    const deletedRow = (store as any).readTaskFromDb(task.id, { includeDeleted: true }) as Task;

    await expect((store as any).atomicWriteTaskJson(dir, {
      ...deletedRow,
      log: [...(deletedRow.log ?? []), { timestamp: new Date().toISOString(), action: "maintenance write" }],
    })).resolves.toBeUndefined();

    const persisted = (store as any).readTaskFromDb(task.id, { includeDeleted: true }) as Task;
    expect(persisted.deletedAt).toBe(deletedRow.deletedAt);
  });

  it("records a task:resurrection-blocked audit event when a stale write is refused", async () => {
    const store = harness.store();
    const task = await store.createTask({ column: "todo", title: "audit me", description: "audit trail" });
    const dir = join(harness.rootDir(), ".fusion", "tasks", task.id);

    await store.deleteTask(task.id);
    await expect((store as any).atomicWriteTaskJson(dir, { ...task, title: "blocked write" })).rejects.toBeInstanceOf(TaskDeletedError);

    const events = (store as any).db.prepare(
      "SELECT mutationType, domain, target, metadata FROM runAuditEvents WHERE taskId = ? AND mutationType = ? ORDER BY timestamp ASC"
    ).all(task.id, "task:resurrection-blocked") as Array<{
      mutationType: string;
      domain: string;
      target: string;
      metadata: string | null;
    }>;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mutationType: "task:resurrection-blocked",
      domain: "database",
      target: task.id,
    });
    expect(events[0].metadata ?? "").toContain("atomicWriteTaskJson");
  });
});
