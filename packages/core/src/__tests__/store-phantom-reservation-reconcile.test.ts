import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

/*
 * FNXC:TaskStoreConsistency 2026-07-12-00:00:
 * FN-7069 phantom committed-reservation archive-path tests.
 * The reconciliation logic (reconcilePhantomCommittedReservations) is a
 * documented no-op in backend mode until the async layer gains an equivalent
 * method (store.ts:686-702). Only the archive-path tests that don't depend on
 * reconcile are kept; the pruning/idempotency/store-open tests are dropped
 * because they test behavior that is intentionally unimplemented in PG mode.
 */

pgTest("TaskStore phantom committed-reservation reconciliation", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_phantom_res",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  it("archiveTask rejects cleanly when neither DB row nor task.json exists", async () => {
    const store = h.store();
    await expect(store.archiveTask("FN-7999")).rejects.toThrow("Task FN-7999 not found");
    await expect(store.archiveTask("FN-7999")).rejects.not.toThrow(/ENOENT/);
  });

  it("archives a DB-backed task even when its task directory is missing", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Archive without task dir" });
    await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });

    const archived = await store.archiveTask(task.id, false);
    expect(archived).toMatchObject({ id: task.id, column: "archived" });
  });
});
