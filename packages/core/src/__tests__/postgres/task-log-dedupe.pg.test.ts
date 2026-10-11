import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:WorkspaceIntegration 2026-08-21-22:07:
Concurrent merge doors must present one environment-repair alert per cause, so this PostgreSQL
fixture proves the advisory-locked log append rather than an in-memory best-effort suppression.
*/
const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_log_dedupe" });

pgDescribe("workspace operator log dedupe", () => {
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  it("atomically appends one alert for concurrent identical environment failures", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "workspace environment" });
    const input = {
      action: "Workspace repository repo-a needs remote 'upstream': restore access and choose Retry.",
      outcome: "WorkspaceEnvironmentRequired",
      dedupeKey: "workspace-environment:repo-a:remote-upstream:access",
      windowMs: 5 * 60_000,
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => store.logEntryOnce(task.id, input)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const current = await store.getTask(task.id);
    expect(current.log?.filter((entry) => entry.dedupeKey === input.dedupeKey)).toHaveLength(1);
  });

  /*
  FNXC:ConcurrencyAdmission 2026-10-11-00:37 (RUFU-382):
  The planning-capacity mirror now treats a FULFILLED once-seam call as proof the card's History is settled,
  which is only sound if a duplicate inside the window cannot reject and cannot append, while a genuine
  failure always rejects. Both directions are pinned against the real advisory-locked transaction rather than
  a fake: a caller that read a duplicate as failure would re-stamp its retry marker forever, and a caller
  that read a throw as a duplicate would silently drop the operator's only explanation of a throttled card.
  */
  it("fulfils a duplicate inside the window without appending, and appends nothing when it throws", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "planning capacity mirror" });
    const input = {
      action: "Queued — maxConcurrent capacity exhausted: used=1/1.",
      dedupeKey: "plan-admission-throttled:running-agent cap|1|1|1|1|fusion-382",
      windowMs: 15 * 60_000,
    };

    const first = await store.logEntryOnce(task.id, input);
    const second = await store.logEntryOnce(task.id, input);
    // Both FULFIL: a deduped no-op is a proven write, not a failed one.
    expect(first).toBe(true);
    expect(second).toBe(false);
    const afterDuplicate = await store.getTask(task.id);
    expect(afterDuplicate.log?.filter((entry) => entry.dedupeKey === input.dedupeKey)).toHaveLength(1);

    /*
    A missing row raises out of the transaction before the UPDATE, so rejection is the only shape that
    leaves nothing durable anywhere — which is what lets a caller gate a retry marker on it.
    */
    await expect(store.logEntryOnce("fusion-382-no-such-task", { ...input, dedupeKey: "plan-admission-throttled:absent-row" }))
      .rejects.toThrow(/not found while logging episode/);
    const afterThrow = await store.getTask(task.id);
    expect(afterThrow.log?.filter((entry) => entry.dedupeKey === input.dedupeKey)).toHaveLength(1);
  });
});
