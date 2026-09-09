/*
FNXC:TaskTiming 2026-09-04-10:36:
Soft-deleted tasks must remain absent from orphaned planning-segment repair while a co-existing live orphan is finalized.
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
