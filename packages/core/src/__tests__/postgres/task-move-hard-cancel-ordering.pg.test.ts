import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  __setTaskMoveDisposalTimeoutForTesting,
  registerTaskMoveDisposer,
} from "../../tasks/task-move-disposer.js";
import { readTaskRow } from "../../task-store/async/async-persistence.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:TaskMovement 2026-07-18-14:32:
Surface enumeration for the hard-cancel invariant:
 - A user move from in-progress to Todo waits for executor cancellation before persistence.
 - The durable task stays in-progress throughout a delayed cancellation.
 - A wedged cancellation times out fail-closed and releases the per-task lock.
 - Engine moves, forward moves, and other destinations do not invoke the user-cancel seam
   (covered by task-move-disposer.test.ts).
 - Main, step, workflow, configured-command, subagent, and CLI surfaces share the executor's
   awaitAbortInFlightTaskWork path (covered by executor-user-cancel.test.ts).
*/
pgDescribe("user move to Todo hard-cancel ordering", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_move_cancel" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  it("keeps the durable task in-progress until cancellation finishes", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Stop before returning to Todo" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });

    let resolveCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const disposer = vi.fn(() => cancellation);
    const unregister = registerTaskMoveDisposer(store, disposer);

    try {
      const move = store.moveTask(created.id, "todo", { moveSource: "user" });
      await vi.waitFor(() => expect(disposer).toHaveBeenCalledOnce());

      expect((await readTaskRow(store.asyncLayer!, created.id))?.column).toBe("in-progress");

      resolveCancellation?.();
      await expect(move).resolves.toMatchObject({ column: "todo", userPaused: true });
      expect((await store.getTask(created.id)).column).toBe("todo");
    } finally {
      resolveCancellation?.();
      unregister();
    }
  });

  it("keeps the task in-progress but releases its lock when cancellation times out", async () => {
    const store = harness.store();
    const created = await store.createTask({ description: "Release a wedged hard cancel" });
    await store.moveTask(created.id, "todo", { moveSource: "engine" });
    await store.moveTask(created.id, "in-progress", { moveSource: "scheduler" });
    const unregister = registerTaskMoveDisposer(store, () => new Promise<void>(() => {}));

    __setTaskMoveDisposalTimeoutForTesting(1);
    try {
      await expect(
        store.moveTask(created.id, "todo", { moveSource: "user" }),
      ).rejects.toThrow(
        `Timed out stopping active work for ${created.id} before moving to Todo`,
      );
    } finally {
      __setTaskMoveDisposalTimeoutForTesting();
      unregister();
    }

    expect((await readTaskRow(store.asyncLayer!, created.id))?.column).toBe("in-progress");
    await expect(
      store.moveTask(created.id, "todo", { moveSource: "engine" }),
    ).resolves.toMatchObject({ column: "todo" });
  });
});
