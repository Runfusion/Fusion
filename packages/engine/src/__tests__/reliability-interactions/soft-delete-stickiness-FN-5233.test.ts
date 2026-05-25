import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskDeletedError, TaskStore, TombstonedTaskResurrectionError } from "@fusion/core";

describe("reliability interactions: FN-5233 soft-delete stickiness", () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fn-5233-reliability-"));
    await mkdir(join(rootDir, ".fusion"), { recursive: true });
    store = new TaskStore(rootDir, undefined, { inMemoryDb: false });
    await store.init();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("composes Layer1 delete signal + Layer2 write guard + Layer3 recreate refusal", async () => {
    const task = await store.createTask({ title: "target", description: "target", column: "todo" });
    const deletedEvents: string[] = [];
    store.on("task:deleted", (event) => deletedEvents.push(event.id));

    await store.deleteTask(task.id);
    expect(deletedEvents).toEqual([task.id]);

    await expect(store.updateTask(task.id, { title: "stale write" })).rejects.toBeInstanceOf(TaskDeletedError);
    await expect(
      store.createTaskWithReservedId({ title: "recreate", description: "same", column: "todo" }, { taskId: task.id }),
    ).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);
  });

  it("refuses near-duplicate intake against recent tombstone and supports explicit unlock", async () => {
    await store.updateSettings({ tombstoneStickyWindowDays: 7 });
    const original = await store.createTask({
      title: "duplicate me",
      description: "duplicate me now",
      source: { sourceType: "unknown", sourceAgentId: "agent-r1" },
    });
    await store.deleteTask(original.id);

    await expect(store.createTask({
      title: "duplicate me",
      description: "duplicate me now",
      source: { sourceType: "unknown", sourceAgentId: "agent-r1" },
    })).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);

    const blocked = (store as any).db.prepare("SELECT mutationType FROM runAuditEvents WHERE mutationType = 'intake:resurrection-blocked'").all() as Array<{ mutationType: string }>;
    expect(blocked.length).toBeGreaterThan(0);

    const unlocked = await store.createTask({
      title: "unlock target",
      description: "unlock target",
      source: { sourceType: "unknown", sourceAgentId: "agent-r2" },
    });
    await store.deleteTask(unlocked.id, { allowResurrection: true });
    await expect(store.createTaskWithReservedId({ title: "allowed", description: "allowed", column: "todo" }, { taskId: unlocked.id })).resolves.toMatchObject({ id: unlocked.id });
  });

  it("does not emit recreated task ids across repeated stale attempts over simulated 6 minutes", async () => {
    vi.useFakeTimers();
    const task = await store.createTask({ title: "clock", description: "clock", column: "todo" });
    await store.deleteTask(task.id);

    const createdEvents: string[] = [];
    store.on("task:created", (event) => createdEvents.push(event.id));

    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(60_000);
      await expect(
        store.createTaskWithReservedId({ title: `retry-${i}`, description: "retry", column: "todo" }, { taskId: task.id }),
      ).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);
    }

    expect(createdEvents).toEqual([]);
  });
});
