import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { registerTaskMoveDisposer } from "../../task-move-disposer.js";
import { readTaskRow } from "../../task-store/async-persistence.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";

/*
Surface enumeration for the hard-cancel invariant:
 - A user move from in-progress to Todo waits for executor cancellation before persistence.
 - The durable task stays in-progress throughout a delayed cancellation.
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
});
