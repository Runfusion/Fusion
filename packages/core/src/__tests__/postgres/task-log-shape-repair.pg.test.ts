/**
 * FNXC:TaskLogShape 2026-11-02-19:18 (RUFU-858 acceptance 3):
 * `project.tasks.log` must be a jsonb ARRAY. A double-encoded row (a jsonb scalar whose text is the JSON of
 * the entry array) makes every store query that selects `id, log` across a project throw, which is how
 * `fn task delete` reported failure after committing and `fn task create` created nothing. The store-open
 * repair must (a) heal what is provably an array, (b) report - never rewrite - what is not, and (c) not move
 * `updated_at`, because that column is the anchor for dwell/stall/admission-age measurements.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { repairDoubleEncodedTaskLogsAsync } from "../../task-store/async/async-task-log-shape.js";

pgDescribe("tasks.log jsonb shape repair (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_log_shape",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const db = () => {
    const layer = h.store().getAsyncLayer();
    if (!layer) throw new Error("expected an async (PostgreSQL) layer");
    return layer.db;
  };

  const writeRawLog = async (taskId: string, jsonText: string) => {
    await db().execute(sql`UPDATE project.tasks SET log = ${jsonText}::jsonb WHERE id = ${taskId}`);
  };

  const readRow = async (taskId: string) => {
    const rows = (await db().execute(sql`
      SELECT jsonb_typeof(log) AS shape, log::text AS raw, updated_at AS upd
        FROM project.tasks WHERE id = ${taskId}
    `)) ?? [];
    return (rows as unknown as Array<{ shape: string; raw: string; upd: string }>)[0];
  };

  it("heals a double-encoded log into an array and leaves updated_at alone", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "Double-encoded history row",
      description: "RUFU-858 acceptance 3: store open must restore the array contract",
    });

    // The exact measured shape: JSON text of the array, wrapped in one more JSON string layer.
    const doubleEncoded = JSON.stringify(JSON.stringify([{ action: "Task created" }]));
    await writeRawLog(task.id, doubleEncoded);

    const poisoned = await readRow(task.id);
    expect(poisoned.shape, "fixture is a jsonb scalar, not an array").toBe("string");

    const result = await repairDoubleEncodedTaskLogsAsync(store);
    expect(result.repaired).toContain(task.id);
    expect(result.unrepairable).not.toContain(task.id);

    const healed = await readRow(task.id);
    expect(healed.shape).toBe("array");
    expect(JSON.parse(healed.raw)).toEqual([{ action: "Task created" }]);
    expect(healed.upd, "a storage-shape repair must not move the clock other sweeps measure").toBe(
      poisoned.upd,
    );
  });

  it("reports a scalar that is not provably an array instead of rewriting it", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "Unrepairable history row",
      description: "RUFU-858: guessing at history is worse than a loud count",
    });
    const garbage = JSON.stringify("not json at all");
    await writeRawLog(task.id, garbage);
    expect((await readRow(task.id)).shape).toBe("string");

    const result = await repairDoubleEncodedTaskLogsAsync(store);
    expect(result.repaired, "an unparsable scalar must not be rewritten").not.toContain(task.id);
    expect(result.unrepairable).toContain(task.id);
    expect((await readRow(task.id)).raw, "value is reported untouched").toBe(garbage);
  });

  it("is a no-op over clean rows, so store open stays cheap", async () => {
    const store = h.store();
    await store.createTask({ title: "Healthy row", description: "must not be touched" });
    const result = await repairDoubleEncodedTaskLogsAsync(store);
    expect(result).toEqual({ repaired: [], unrepairable: [] });
  });
});
