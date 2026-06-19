import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "../store.js";
import type { Task } from "../types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("near-duplicate stale flag clearing", () => {
  const harness = createTaskStoreTestHarness();
  let store: TaskStore;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  async function createCanonical(): Promise<Task> {
    return store.createTask({ title: "Canonical task", description: "Canonical intent" });
  }

  async function createReferencingTask(canonicalId: string, title = "Referencing task"): Promise<Task> {
    return store.createTask({
      title,
      description: "Similar intent that should stop asking for a duplicate decision",
      source: {
        sourceType: "automation",
        sourceMetadata: {
          nearDuplicateOf: canonicalId,
          nearDuplicateScore: 0.92,
          nearDuplicateSharedTokens: ["packages/core/src/store.ts", "nearDuplicateOf"],
          nearDuplicateDismissed: true,
          retainedMetadata: "kept",
        },
      },
    });
  }

  async function moveCanonicalToDone(taskId: string): Promise<void> {
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");
    await store.moveTask(taskId, "in-review", { allowDirectInReviewMove: true });
    await store.moveTask(taskId, "done", { skipMergeBlocker: true });
  }

  async function expectFlagCleared(taskId: string, canonicalId: string, reason: string): Promise<void> {
    const updated = await store.getTask(taskId);
    expect(updated.sourceMetadata).toEqual({ retainedMetadata: "kept" });
    expect(updated.paused).not.toBe(true);
    expect(updated.status).not.toBe("failed");
    expect(updated.log.some((entry) => entry.action.includes(`Near-duplicate canonical ${canonicalId} is now inactive (${reason}); cleared duplicate flag`))).toBe(true);
  }

  it("clears active referrers when the canonical is archived without cleanup", async () => {
    const canonical = await createCanonical();
    const referrer = await createReferencingTask(canonical.id);

    await store.archiveTask(canonical.id, { cleanup: false });

    await expectFlagCleared(referrer.id, canonical.id, "archived");
  });

  it("clears multiple active referrers when the canonical is archived with cleanup", async () => {
    const canonical = await createCanonical();
    const first = await createReferencingTask(canonical.id, "First referrer");
    const second = await createReferencingTask(canonical.id, "Second referrer");

    await store.archiveTask(canonical.id, { cleanup: true });

    await expectFlagCleared(first.id, canonical.id, "archived");
    await expectFlagCleared(second.id, canonical.id, "archived");
  });

  it("clears active referrers when the canonical is soft-deleted", async () => {
    const canonical = await createCanonical();
    const referrer = await createReferencingTask(canonical.id);

    await store.deleteTask(canonical.id);

    await expectFlagCleared(referrer.id, canonical.id, "deleted");
  });

  it("clears active referrers when the canonical moves to done", async () => {
    const canonical = await createCanonical();
    const referrer = await createReferencingTask(canonical.id);

    await moveCanonicalToDone(canonical.id);

    await expectFlagCleared(referrer.id, canonical.id, "done");
  });

  it("does not fail canonical inactive transitions when there are no referrers", async () => {
    const archived = await createCanonical();
    await expect(store.archiveTask(archived.id, { cleanup: false })).resolves.toMatchObject({ id: archived.id, column: "archived" });

    const deleted = await createCanonical();
    await expect(store.deleteTask(deleted.id)).resolves.toMatchObject({ id: deleted.id });

    const done = await createCanonical();
    await expect(moveCanonicalToDone(done.id)).resolves.toBeUndefined();
    await expect(store.getTask(done.id)).resolves.toMatchObject({ id: done.id, column: "done" });
  });
});
