/*
FNXC:TaskTiming 2026-08-09-20:34:
Archive cold-storage reconstruction retains planningStartedAt but omits deletedAt,
while archiving tombstones the live row. A mock listTasks fixture cannot prove
that cross-store behavior, so these cases use a real PostgreSQL TaskStore and a
throwaway database to keep the orphan-finalization invariant production-real.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import "@fusion/core";
import type { TaskStore } from "@fusion/core";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager } from "../self-healing.js";

pgDescribe("orphaned planning segment poisoned rows", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_orphaned_planning_segment",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  function createManager(store: TaskStore): SelfHealingManager {
    return new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getPlanningTaskIds: () => new Set<string>(),
      hasActivePlanningWorkflowSession: () => false,
    });
  }

  it("finalizes a live orphan without touching an archive snapshot that retains its planning anchor", async () => {
    const store = h.store();
    const archived = await store.createTask({ description: "archived planning anchor" });
    const live = await store.createTask({ description: "live planning anchor" });
    const archivedStartedAt = "2026-08-08T16:40:09.736Z";
    const liveStartedAt = "2026-08-08T16:41:09.736Z";

    await store.updateTask(archived.id, { planningStartedAt: archivedStartedAt, cumulativePlanningMs: 25 });
    await store.archiveTask(archived.id, { cleanup: false });
    await store.updateTask(live.id, { planningStartedAt: liveStartedAt, cumulativePlanningMs: 50 });

    const manager = createManager(store);
    await expect(manager.finalizeOrphanedPlanningSegments()).resolves.toBe(1);

    const finalizedLive = await store.getTask(live.id);
    expect(finalizedLive!.planningStartedAt).toBeUndefined();
    expect(finalizedLive!.cumulativePlanningMs).toBeGreaterThan(50);

    const archivedEntries = await store.listArchivedTasks({ slim: true });
    expect(archivedEntries.tasks.find((task) => task.id === archived.id)).toMatchObject({
      planningStartedAt: archivedStartedAt,
      cumulativePlanningMs: 25,
    });

    const audit = await store.getRunAuditEventsAsync();
    expect(audit.some((event) =>
      event.mutationType === "task:reconcile-orphaned-planning-segment" && event.taskId === live.id,
    )).toBe(true);
    expect(audit.some((event) =>
      event.mutationType === "task:reconcile-orphaned-planning-segment" && event.taskId === archived.id,
    )).toBe(false);

    manager.stop();
  });

  it("keeps plain soft-deleted rows out of the candidate list while finalizing a co-existing live orphan", async () => {
    const store = h.store();
    const deleted = await store.createTask({ description: "deleted planning anchor" });
    const live = await store.createTask({ description: "live planning anchor" });

    await store.updateTask(deleted.id, { planningStartedAt: "2026-08-08T16:40:09.736Z", cumulativePlanningMs: 25 });
    await store.deleteTask(deleted.id);
    await store.updateTask(live.id, { planningStartedAt: "2026-08-08T16:41:09.736Z", cumulativePlanningMs: 50 });

    const manager = createManager(store);
    await expect(manager.finalizeOrphanedPlanningSegments()).resolves.toBe(1);

    const finalizedLive = await store.getTask(live.id);
    expect(finalizedLive!.planningStartedAt).toBeUndefined();
    expect(finalizedLive!.cumulativePlanningMs).toBeGreaterThan(50);
    expect((await store.listTasks({ slim: true, includeArchived: false })).map((task) => task.id)).not.toContain(deleted.id);

    manager.stop();
  });
});
