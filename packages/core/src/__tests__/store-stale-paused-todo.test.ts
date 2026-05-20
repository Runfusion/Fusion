import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../store.js";

describe("TaskStore stalePausedTodo hydration", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "store-stale-paused-todo-"));
    globalDir = join(rootDir, ".fusion-global-settings");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function seedTask(id: string, overrides: { paused?: boolean; ageMs?: number; column?: "todo" | "in-review" }) {
    const now = Date.now();
    const ageMs = overrides.ageMs ?? 24 * 60 * 60_000 + 1_000;
    const movedAt = new Date(now - ageMs).toISOString();
    const column = overrides.column ?? "todo";
    await store.createTaskWithReservedId(
      { description: id, column },
      { taskId: id, createdAt: movedAt, updatedAt: movedAt, applyDefaultWorkflowSteps: false },
    );
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } } }).db;
    db.prepare(`UPDATE tasks
      SET paused = ?, columnMovedAt = ?, updatedAt = ?
      WHERE id = ?`).run(
      overrides.paused ? 1 : 0,
      movedAt,
      movedAt,
      id,
    );
  }

  it("hydrates stalePausedTodo for paused todo past threshold", async () => {
    await seedTask("FN-5034-A", { paused: true });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5034-A");
    expect(task?.stalePausedTodo?.code).toBe("stale-paused-todo");
  });

  it("respects stalePausedTodoThresholdMs setting override", async () => {
    await store.updateSettings({ stalePausedTodoThresholdMs: 2_000 });
    await seedTask("FN-5034-B", { paused: true, ageMs: 2_500 });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5034-B");
    expect(task?.stalePausedTodo?.thresholdMs).toBe(2_000);
  });

  it("does not hydrate stalePausedTodo for paused in-review tasks", async () => {
    await seedTask("FN-5034-C", { paused: true, column: "in-review" });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5034-C");
    expect(task?.stalePausedTodo).toBeUndefined();
  });

  it("does not hydrate stalePausedTodo for unpaused todo tasks", async () => {
    await seedTask("FN-5034-D", { paused: false });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5034-D");
    expect(task?.stalePausedTodo).toBeUndefined();
  });
});
