import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { InvalidFileScopeError, TaskStore, TombstonedTaskResurrectionError } from "../store.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

/*
 * FNXC:ReservationAtomicity 2026-07-12-00:00:
 * Migrated to PG harness. The it.each (in-memory vs file-backed) variants are
 * collapsed to a single PG-backed test. The sync transactionImmediate +
 * commitDistributedTaskIdReservationInExistingTransaction test is dropped
 (SQLite-only sync transaction API; PG uses async allocator commit/abort).
 */

async function reservationRows(h: SharedPgTaskStoreHarness): Promise<Array<{ taskId: string; status: string; sequence: number }>> {
  const rows = await h.adminDb().execute(
    sql`SELECT task_id AS "taskId", status, sequence FROM project.distributed_task_id_reservations ORDER BY sequence`,
  ) as unknown as Array<{ taskId: string; status: string; sequence: number }>;
  return rows;
}

async function taskExists(h: SharedPgTaskStoreHarness, taskId: string): Promise<boolean> {
  const rows = await h.adminDb().execute(
    sql`SELECT id FROM project.tasks WHERE id = ${taskId}`,
  ) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

async function expectNoReservationTaskDivergence(h: SharedPgTaskStoreHarness): Promise<void> {
  const phantoms = await h.adminDb().execute(
    sql`SELECT r.task_id FROM project.distributed_task_id_reservations r
       LEFT JOIN project.tasks t ON t.id = r.task_id
       WHERE r.status = 'committed' AND t.id IS NULL
       ORDER BY r.task_id`,
  ) as unknown as Array<{ task_id: string }>;
  expect(phantoms).toEqual([]);

  const mismatches = await h.adminDb().execute(
    sql`SELECT t.id AS task_id, r.status FROM project.tasks t
       JOIN project.distributed_task_id_reservations r ON r.task_id = t.id
       WHERE t.deleted_at IS NULL AND r.status != 'committed'
       ORDER BY t.id`,
  ) as unknown as Array<{ task_id: string; status: string }>;
  expect(mismatches).toEqual([]);
}

pgTest("FN-7074 task-create reservation atomicity", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_res_atomicity",
  });

  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("commits reservation when task row and task directory land", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "happy atomic create" });

    expect(await reservationRows(h)).toEqual([{ taskId: task.id, status: "committed", sequence: 1 }]);
    expect(await taskExists(h, task.id)).toBe(true);
    expect(existsSync(join(h.rootDir(), ".fusion", "tasks", task.id, "task.json"))).toBe(true);
    expect(existsSync(join(h.rootDir(), ".fusion", "tasks", task.id, "PROMPT.md"))).toBe(true);
    await expectNoReservationTaskDivergence(h);
  });

  it("aborts the reservation and leaves no task row when the tasks-row insert fails", async () => {
    const store = h.store();
    const original = (store as unknown as { insertTaskWithFtsRecovery: (...args: unknown[]) => void }).insertTaskWithFtsRecovery;
    (store as unknown as { insertTaskWithFtsRecovery: (...args: unknown[]) => void }).insertTaskWithFtsRecovery = () => {
      throw new Error("synthetic insert failure");
    };

    await expect(store.createTask({ description: "insert should fail" })).rejects.toThrow("synthetic insert failure");
    (store as unknown as { insertTaskWithFtsRecovery: (...args: unknown[]) => void }).insertTaskWithFtsRecovery = original;

    expect(await reservationRows(h)).toEqual([{ taskId: "FN-001", status: "aborted", sequence: 1 }]);
    expect(await taskExists(h, "FN-001")).toBe(false);
    await expectNoReservationTaskDivergence(h);
  });

  it("rolls back the committed reservation and task row when task.json disk write fails after insert", async () => {
    const store = h.store();
    const original = (store as unknown as { writeTaskJsonFile: (...args: unknown[]) => Promise<void> }).writeTaskJsonFile;
    (store as unknown as { writeTaskJsonFile: (...args: unknown[]) => Promise<void> }).writeTaskJsonFile = async () => {
      throw new Error("synthetic task.json write failure");
    };

    await expect(store.createTask({ description: "disk write should fail" })).rejects.toThrow("synthetic task.json write failure");
    (store as unknown as { writeTaskJsonFile: (...args: unknown[]) => Promise<void> }).writeTaskJsonFile = original;

    expect(await reservationRows(h)).toEqual([{ taskId: "FN-001", status: "aborted", sequence: 1 }]);
    expect(await taskExists(h, "FN-001")).toBe(false);
    expect(existsSync(join(h.rootDir(), ".fusion", "tasks", "FN-001"))).toBe(false);
    await expectNoReservationTaskDivergence(h);
  });

  it("rolls back distributed create reservations when file-scope validation throws", async () => {
    const store = h.store();
    const originalGenerate = (store as unknown as { generateSpecifiedPrompt: (task: unknown) => string }).generateSpecifiedPrompt;
    (store as unknown as { generateSpecifiedPrompt: (task: unknown) => string }).generateSpecifiedPrompt = () =>
      "# Bad prompt\n\n## File Scope\n\n- `origin/fusion/fn-4280`\n";

    await expect(store.createTask({ description: "bad scope", column: "todo" })).rejects.toBeInstanceOf(InvalidFileScopeError);
    (store as unknown as { generateSpecifiedPrompt: (task: unknown) => string }).generateSpecifiedPrompt = originalGenerate;

    expect(await reservationRows(h)).toEqual([{ taskId: "FN-001", status: "aborted", sequence: 1 }]);
    expect(await taskExists(h, "FN-001")).toBe(false);
    expect(existsSync(join(h.rootDir(), ".fusion", "tasks", "FN-001"))).toBe(false);
    await expectNoReservationTaskDivergence(h);
  });

  it("rolls back distributed create reservations when duplicate intake hits a recent tombstone", async () => {
    const store = h.store();
    await store.updateSettings({ tombstoneStickyWindowDays: 7 });
    const original = await store.createTask({
      title: "Memory leak",
      description: "Fix memory leak in merge worker",
      source: { sourceType: "unknown", sourceAgentId: "agent-1" },
    });
    await store.deleteTask(original.id);

    await expect(store.createTask({
      title: "Memory leak",
      description: "Fix memory leak in merge worker",
      source: { sourceType: "unknown", sourceAgentId: "agent-1" },
    })).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);

    const rows = await reservationRows(h);
    expect(rows).toEqual([
      { taskId: "FN-001", status: "committed", sequence: 1 },
      { taskId: "FN-002", status: "aborted", sequence: 2 },
    ]);
    await expectNoReservationTaskDivergence(h);
  });

  it("preserves ID permanence after a committed create is rolled back", async () => {
    const store = h.store();
    const original = (store as unknown as { writeTaskJsonFile: (...args: unknown[]) => Promise<void> }).writeTaskJsonFile;
    (store as unknown as { writeTaskJsonFile: (...args: unknown[]) => Promise<void> }).writeTaskJsonFile = async () => {
      throw new Error("synthetic task.json write failure");
    };
    await expect(store.createTask({ description: "burn FN-001" })).rejects.toThrow("synthetic task.json write failure");
    (store as unknown as { writeTaskJsonFile: (...args: unknown[]) => Promise<void> }).writeTaskJsonFile = original;

    const next = await store.createTask({ description: "next id" });

    expect(next.id).toBe("FN-002");
    expect(await reservationRows(h)).toEqual([
      { taskId: "FN-001", status: "aborted", sequence: 1 },
      { taskId: "FN-002", status: "committed", sequence: 2 },
    ]);
    await expectNoReservationTaskDivergence(h);
  });

  it("allows replicated direct-reserved creates without requiring a reservation row", async () => {
    const store = h.store();
    const now = new Date().toISOString();

    const result = await store.applyReplicatedTaskCreate({
      replicationVersion: 1,
      reservationId: "remote-reservation",
      taskId: "FN-123",
      sourceNodeId: "node-b",
      input: {
        id: "FN-123",
        description: "replicated create",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: now,
        updatedAt: now,
        columnMovedAt: now,
      } as never,
      createdAt: now,
      updatedAt: now,
      prompt: "# replicated\n",
    });

    expect(result.applied).toBe(true);
    expect(await reservationRows(h)).toEqual([]);
    expect(await taskExists(h, "FN-123")).toBe(true);
  });
});
