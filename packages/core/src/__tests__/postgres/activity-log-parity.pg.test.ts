/**
 * FNXC:PostgresMigrationCoverage 2026-07-13-22:54:
 * The PostgreSQL cutover must preserve the activity log's best-effort write contract, structured metadata, newest-first filtering, bounded reads, and explicit clearing. These are live operator-facing audit invariants formerly asserted only by the removed SQLite TaskStore suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";

pgDescribe("activity log parity (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_activity_parity",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("keeps failed writes best-effort so audit storage cannot break product operations", async () => {
    const layer = h.layer();
    const insert = vi.spyOn(layer.db, "insert").mockImplementation(() => {
      throw new Error("activity insert failed");
    });

    try {
      await expect(
        h.store().recordActivity({
          type: "task:created",
          taskId: "FN-404",
          taskTitle: "Resilient operation",
          details: "Create event",
          metadata: { source: "test" },
        }),
      ).resolves.toMatchObject({
        type: "task:created",
        taskId: "FN-404",
        metadata: { source: "test" },
      });
      expect(await h.store().getActivityLog()).toEqual([]);
    } finally {
      insert.mockRestore();
    }
  });

  it("filters by timestamp and type, orders newest first, applies a limit, and clears", async () => {
    const store = h.store();
    const first = await store.recordActivity({
      type: "task:created",
      taskId: "FN-001",
      taskTitle: "First task",
      details: "Created",
    });
    const moved = await store.recordActivity({
      type: "task:moved",
      taskId: "FN-001",
      taskTitle: "First task",
      details: "Moved",
      metadata: { from: "todo", to: "in-progress" },
    });
    const latest = await store.recordActivity({
      type: "task:created",
      taskId: "FN-002",
      taskTitle: "Second task",
      details: "Created later",
    });
    await h.adminDb().insert(schema.project.activityLog).values({
      projectId: "other-project",
      id: "other-project-event",
      timestamp: "2026-07-13T20:03:00.000Z",
      type: "task:created",
      taskId: "FN-OTHER",
      details: "Must remain isolated",
    });

    await h.adminDb().update(schema.project.activityLog).set({ timestamp: "2026-07-13T20:00:00.000Z" }).where(eq(schema.project.activityLog.id, first.id));
    await h.adminDb().update(schema.project.activityLog).set({ timestamp: "2026-07-13T20:01:00.000Z" }).where(eq(schema.project.activityLog.id, moved.id));
    await h.adminDb().update(schema.project.activityLog).set({ timestamp: "2026-07-13T20:02:00.000Z" }).where(eq(schema.project.activityLog.id, latest.id));

    expect((await store.getActivityLog({ limit: 2 })).map((event) => event.taskId)).toEqual([
      "FN-002",
      "FN-001",
    ]);
    const movedEvents = await store.getActivityLog({ type: "task:moved" });
    expect(movedEvents).toHaveLength(1);
    expect(movedEvents[0]?.metadata).toEqual({ from: "todo", to: "in-progress" });
    expect((await store.getActivityLog({ since: "2026-07-13T20:01:30.000Z" })).map((event) => event.taskId)).toEqual(["FN-002"]);

    await store.clearActivityLog();
    expect(await store.getActivityLog()).toEqual([]);
    const otherProject = await h.adminDb()
      .select({ id: schema.project.activityLog.id })
      .from(schema.project.activityLog)
      .where(eq(schema.project.activityLog.projectId, "other-project"));
    expect(otherProject).toEqual([{ id: "other-project-event" }]);
  });
});
