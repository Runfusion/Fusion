import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

/*
FNXC:WorkspaceMergeDispatch 2026-08-15-09:46:
A merge body that already pushed may wake after a successor has reclaimed its dispatch tenancy.
The terminal callback must be guarded by the durable owner-and-fence transaction, not by a renewal
callback or an in-process belief, so a stale body cannot mark the task complete.
*/
pgTest("workspace merge dispatch finalization (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_workspace_dispatch_finalization" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("does not invoke a predecessor terminal callback after a durable successor reclaim", async () => {
    const predecessorStore = h.store();
    const successorStore = h.store();
    const task = await predecessorStore.createTask({ description: "durable merge terminal fence" });
    const predecessor = await predecessorStore.acquireWorkspaceLease({
      leaseKey: "merge-dispatch:FN-9059-finalize",
      kind: "merge-dispatch",
      owner: { taskId: "FN-9059-finalize", nodeId: "node-b", incarnationId: "inc-b" },
      leaseMs: 1,
    });
    if (predecessor.outcome === "conflict") throw new Error("expected predecessor lease");

    // The renewal callback never runs. Once the durable TTL passes, another node reclaims with a
    // higher token and the predecessor's finalization transaction must refuse its old handle.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const successor = await successorStore.acquireWorkspaceLease({
      leaseKey: predecessor.handle.leaseKey,
      kind: "merge-dispatch",
      owner: { taskId: "FN-9059-finalize", nodeId: "node-a", incarnationId: "inc-a" },
      leaseMs: 60_000,
    });
    expect(successor.outcome).toBe("reclaimed-expired");

    /*
    FNXC:WorkspaceMergeDispatch 2026-08-15-10:18:
    Model the post-push terminal persist with the real PostgreSQL TaskStore. A successor reclaim
    must prevent the callback itself from entering its durable task mutation, not merely reject a
    mocked finalizer after a renewal timer notices expiry.
    */
    const terminalWrite = vi.fn(async () => {
      await predecessorStore.updateTask(task.id, { title: "stale merge outcome" });
    });
    await expect(predecessorStore.withValidWorkspaceLease(predecessor.handle, terminalWrite)).rejects.toThrow("Workspace lease is no longer valid");
    expect(terminalWrite).not.toHaveBeenCalled();
    expect((await predecessorStore.getTask(task.id))?.title).toBe(task.title);
  });
});
