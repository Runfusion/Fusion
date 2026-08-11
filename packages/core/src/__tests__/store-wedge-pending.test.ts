import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../__test-utils__/pg-test-harness.js";

/*
FNXC:TaskWedgeNotifications 2026-08-11-18:57:
The durable marker is deliberately separate from episode state and cooldown history. These store
assertions pin the CAS boundary so engine timers can defer an alert without a restart dropping it
or a claim/resolve accidentally being treated as a pending-marker clear.
*/
pgDescribe("TaskStore deferred wedge marker", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_wedge_pending" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seed(id: string) {
    const store = h.store();
    await store.createTaskWithReservedId({ description: "deferred wedge", column: "in-review" }, { taskId: id, applyDefaultWorkflowSteps: false });
    return store;
  }

  const descriptor = { reasonKey: "terminal-failed", source: "auto" as const, reason: "terminal", action: "repair" };

  it("arms once, restamps stale evidence, and clears without changing episode state", async () => {
    const store = await seed("FN-WEDGE-001");
    const first = await store.markTaskWedgeNotificationPending("FN-WEDGE-001", descriptor);
    const second = await store.markTaskWedgeNotificationPending("FN-WEDGE-001", descriptor);
    expect(second).toMatchObject({ since: first.since, armed: false, restamped: false });

    const stale = await store.markTaskWedgeNotificationPending("FN-WEDGE-001", descriptor, { staleAfterMs: -1 });
    expect(stale).toMatchObject({ armed: true, restamped: true });
    expect(await store.clearTaskWedgeNotificationPending("FN-WEDGE-001", "other")).toBe(false);
    expect(await store.clearTaskWedgeNotificationPending("FN-WEDGE-001")).toBe(true);
    const task = await store.getTask("FN-WEDGE-001");
    expect(task.wedgeNotification).toMatchObject({ reasonKey: "terminal-failed", status: "resolved", episodeId: "" });
    expect(task.wedgeNotification?.pending).toBeUndefined();
  });

  it("drops pending evidence on delivered and cooldown-suppressed claims but not resolve", async () => {
    const store = await seed("FN-WEDGE-002");
    await store.markTaskWedgeNotificationPending("FN-WEDGE-002", descriptor);
    expect(await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-002", "terminal-failed")).toMatchObject({ claimed: true });
    expect((await store.getTask("FN-WEDGE-002")).wedgeNotification?.pending).toBeUndefined();

    await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-002", null);
    await store.markTaskWedgeNotificationPending("FN-WEDGE-002", descriptor);
    expect(await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-002", "terminal-failed")).toMatchObject({ claimed: false });
    expect((await store.getTask("FN-WEDGE-002")).wedgeNotification?.pending).toBeUndefined();

    await store.markTaskWedgeNotificationPending("FN-WEDGE-002", { ...descriptor, reasonKey: "tool-failure" });
    await store.claimTaskWedgeNotificationEpisode("FN-WEDGE-002", null);
    expect((await store.getTask("FN-WEDGE-002")).wedgeNotification?.pending).toBeDefined();
  });
});
