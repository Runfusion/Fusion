/**
 * FNXC:SqliteFinalRemoval 2026-06-25-10:40:
 * PostgreSQL integration test verifying createTaskWithReservedId works in
 * backend mode. Previously this path threw "SQLite Database is not available
 * in backend mode" because _createTaskInternal -> atomicCreateTaskJson used
 * store.db.transactionImmediate(). The fix routes the _createTaskInternal
 * facade method to the async backend variant when store.backendMode is true,
 * so reserved-id creates (used by mesh replication, dependency refinement,
 * and task duplication) persist against PostgreSQL.
 */
import { describe, it, expect } from "vitest";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("createTaskWithReservedId backend mode (PostgreSQL)", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_reserved_id" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  it("createTaskWithReservedId persists a task with the reserved id in backend mode", async () => {
    const h = await makeHarness();
    try {
      const reservedId = "FN-RESERVED-001";
      const task = await h.store.createTaskWithReservedId(
        { description: "Reserved-id create in backend mode" },
        { taskId: reservedId },
      );
      expect(task.id).toBe(reservedId);

      // Round-trip: read it back via the public API.
      const fetched = await h.store.getTask(reservedId);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(reservedId);
      expect(fetched!.description).toBe("Reserved-id create in backend mode");

      // Appears in the task list.
      const all = await h.store.listTasks();
      expect(all.map((t) => t.id)).toContain(reservedId);
    } finally {
      await teardown();
    }
  });

  it("createTaskWithReservedId rejects an empty description", async () => {
    const h = await makeHarness();
    try {
      await expect(
        h.store.createTaskWithReservedId({ description: "   " }, { taskId: "FN-EMPTY" }),
      ).rejects.toThrow(/Description is required/);
    } finally {
      await teardown();
    }
  });

  it("createTaskWithReservedId rejects an already-used id", async () => {
    const h = await makeHarness();
    try {
      const id = "FN-DOUBLE-001";
      await h.store.createTaskWithReservedId({ description: "first" }, { taskId: id });
      await expect(
        h.store.createTaskWithReservedId({ description: "second" }, { taskId: id }),
      ).rejects.toThrow();
    } finally {
      await teardown();
    }
  });

  it("createTaskWithReservedId persists supplied createdAt/updatedAt", async () => {
    const h = await makeHarness();
    try {
      const id = "FN-TS-001";
      const fixedCreated = "2026-01-15T08:00:00.000Z";
      const fixedUpdated = "2026-02-20T12:30:00.000Z";
      await h.store.createTaskWithReservedId(
        { description: "explicit timestamps" },
        { taskId: id, createdAt: fixedCreated, updatedAt: fixedUpdated },
      );
      const fetched = await h.store.getTask(id);
      expect(fetched!.createdAt).toBe(fixedCreated);
      expect(fetched!.updatedAt).toBe(fixedUpdated);
    } finally {
      await teardown();
    }
  });
});

// Keep `describe` referenced so the import is not flagged as unused if the
// pgDescribe.skip path is taken in CI (no PG available).
void describe;
