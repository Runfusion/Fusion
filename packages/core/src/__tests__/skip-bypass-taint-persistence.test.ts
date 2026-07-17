import { afterEach, beforeAll, beforeEach, afterAll, expect, it } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

/*
FNXC:Lifecycle 2026-07-16-21:40:
FN-8141 — the skip-bypass taint marker `bulkCompletionRefusalAt` must survive a
requeue (it is set on attempt N's refusal and consulted on attempt N+1's promotion),
so it has to round-trip through the store. Assert set/read/clear on the real backend.
*/
pgTest("TaskStore bulkCompletionRefusalAt (skip-bypass taint) persistence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_skip_bypass_taint" });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  it("round-trips the taint marker: unset → set → cleared", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Skip bypass taint round-trip" });

    // Fresh tasks carry no taint.
    expect((await store.getTask(task.id)).bulkCompletionRefusalAt).toBeUndefined();

    const stamp = "2026-07-16T21:40:00.000Z";
    await store.updateTask(task.id, { bulkCompletionRefusalAt: stamp });
    expect((await store.getTask(task.id)).bulkCompletionRefusalAt).toBe(stamp);

    // null clears the marker back to undefined (the honest-exit / operator-retry path).
    await store.updateTask(task.id, { bulkCompletionRefusalAt: null });
    expect((await store.getTask(task.id)).bulkCompletionRefusalAt).toBeUndefined();
  });
});
