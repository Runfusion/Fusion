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
});
