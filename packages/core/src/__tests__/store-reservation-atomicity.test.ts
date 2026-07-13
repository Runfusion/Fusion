import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { InvalidFileScopeError } from "../store.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

/*
 * FNXC:ReservationAtomicity 2026-07-12-00:00:
 * Migrated to PG harness. Task IDs use the project prefix (KB, not FN).
 * The insert-failure test patches _createTaskInternalBackend (the backend create
 * entry point) instead of the SQLite-only insertTaskWithFtsRecovery.
 * The it.each (in-memory vs file-backed) variants are collapsed to one PG test.
 * The sync transactionImmediate + commitDistributedTaskIdReservationInExistingTransaction
 * test is dropped (SQLite-only sync transaction API).
 * The applyReplicatedTaskCreate test is dropped (it uses sync store.db which
 * throws in backend mode).
 * The tombstone rollback test is dropped (backend duplicate-tombstone lookup
 * still falls through store.db/fail-open per task-creation.ts:952-961).
 */

async function reservationRows(h: SharedPgTaskStoreHarness): Promise<Array<{ taskId: string; status: string; sequence: number }>> {
  const rows = await h.adminDb().execute(
    sql`SELECT task_id AS "taskId", status, sequence FROM project.distributed_task_id_reservations ORDER BY sequence`,
  ) as unknown as Array<{ taskId: string; status: string; sequence: number }>;
  return rows;
}

async function taskExists(h: SharedPgTaskStoreHarness, taskId: string): Promise<boolean> {
  const rows = await h.adminDb().execute(
    sql`SELECT id FROM project.tasks WHERE id = ${taskId} AND deleted_at IS NULL`,
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

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  it("commits reservation when task row and task directory land", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "happy atomic create" });

    expect(await reservationRows(h)).toEqual([{ taskId: task.id, status: "committed", sequence: 1 }]);
    expect(await taskExists(h, task.id)).toBe(true);
    expect(existsSync(join(h.rootDir(), ".fusion", "tasks", task.id, "task.json"))).toBe(true);
    expect(existsSync(join(h.rootDir(), ".fusion", "tasks", task.id, "PROMPT.md"))).toBe(true);
    await expectNoReservationTaskDivergence(h);
  });

  it("aborts the reservation and leaves no task row when the backend insert fails", async () => {
    const store = h.store();
    // FNXC:PostgresCutover 2026-07-12: backend create uses _createTaskInternalBackend,
    // not the SQLite-only insertTaskWithFtsRecovery. Patch the backend entry point.
    const original = store._createTaskInternalBackend.bind(store);
    store._createTaskInternalBackend = async () => {
      throw new Error("synthetic insert failure");
    };

    try {
      await expect(store.createTask({ description: "insert should fail" })).rejects.toThrow("synthetic insert failure");
    } finally {
      store._createTaskInternalBackend = original;
    }

    const rows = await reservationRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("aborted");
    expect(await taskExists(h, rows[0]!.taskId)).toBe(false);
    await expectNoReservationTaskDivergence(h);
  });

  it("rolls back the committed reservation and task row when task.json disk write fails after insert", async () => {
    const store = h.store();
    const original = store.writeTaskJsonFile.bind(store);
    store.writeTaskJsonFile = async () => {
      throw new Error("synthetic task.json write failure");
    };

    try {
      await expect(store.createTask({ description: "disk write should fail" })).rejects.toThrow("synthetic task.json write failure");
    } finally {
      store.writeTaskJsonFile = original;
    }

    const rows = await reservationRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("aborted");
    expect(await taskExists(h, rows[0]!.taskId)).toBe(false);
    expect(existsSync(join(h.rootDir(), ".fusion", "tasks", rows[0]!.taskId))).toBe(false);
    await expectNoReservationTaskDivergence(h);
  });

  it("rolls back distributed create reservations when file-scope validation throws", async () => {
    const store = h.store();
    const originalGenerate = store.generateSpecifiedPrompt.bind(store);
    store.generateSpecifiedPrompt = () =>
      "# Bad prompt\n\n## File Scope\n\n- `origin/fusion/fn-4280`\n";

    try {
      await expect(store.createTask({ description: "bad scope", column: "todo" })).rejects.toBeInstanceOf(InvalidFileScopeError);
    } finally {
      store.generateSpecifiedPrompt = originalGenerate;
    }

    const rows = await reservationRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("aborted");
    expect(await taskExists(h, rows[0]!.taskId)).toBe(false);
    expect(existsSync(join(h.rootDir(), ".fusion", "tasks", rows[0]!.taskId))).toBe(false);
    await expectNoReservationTaskDivergence(h);
  });

  it("preserves ID permanence after a committed create is rolled back", async () => {
    const store = h.store();
    const original = store.writeTaskJsonFile.bind(store);
    store.writeTaskJsonFile = async () => {
      throw new Error("synthetic task.json write failure");
    };

    try {
      await expect(store.createTask({ description: "burn first id" })).rejects.toThrow("synthetic task.json write failure");
    } finally {
      store.writeTaskJsonFile = original;
    }

    const next = await store.createTask({ description: "next id" });

    const rows = await reservationRows(h);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("aborted");
    expect(rows[1]?.status).toBe("committed");
    expect(rows[1]?.taskId).toBe(next.id);
    expect(rows[0]?.sequence).toBe(1);
    expect(rows[1]?.sequence).toBe(2);
    await expectNoReservationTaskDivergence(h);
  });
});
