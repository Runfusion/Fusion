import { describe, expect, it, vi } from "vitest";
import {
  __setTaskMoveDisposalTimeoutForTesting,
  disposeTaskBeforeMove,
  registerTaskMoveDisposer,
} from "../task-move-disposer.js";

describe("task move disposer", () => {
  it("does not complete a user in-progress to todo move until cancellation settles", async () => {
    const store = {} as never;
    let resolveCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const disposer = vi.fn(() => cancellation);
    registerTaskMoveDisposer(store, disposer);

    let moveReady = false;
    const preparation = disposeTaskBeforeMove(store, {
      task: { id: "FN-CANCEL" } as never,
      from: "in-progress",
      to: "todo",
      source: "user",
    }).then(() => {
      moveReady = true;
    });

    await Promise.resolve();
    expect(disposer).toHaveBeenCalledOnce();
    expect(moveReady).toBe(false);

    resolveCancellation?.();
    await preparation;
    expect(moveReady).toBe(true);
  });

  it("awaits every executor registered to the same store", async () => {
    const store = {} as never;
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const unregisterFirst = registerTaskMoveDisposer(store, first);
    registerTaskMoveDisposer(store, second);

    await disposeTaskBeforeMove(store, {
      task: { id: "FN-MULTI-OWNER" } as never,
      from: "in-progress",
      to: "todo",
      source: "user",
    });

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    unregisterFirst();
    await disposeTaskBeforeMove(store, {
      task: { id: "FN-ONE-OWNER" } as never,
      from: "in-progress",
      to: "todo",
      source: "user",
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("fails closed and releases the move when cancellation does not settle", async () => {
    __setTaskMoveDisposalTimeoutForTesting(1);
    try {
      const store = {} as never;
      registerTaskMoveDisposer(store, () => new Promise<void>(() => {}));

      const preparation = disposeTaskBeforeMove(store, {
        task: { id: "FN-WEDGED" } as never,
        from: "in-progress",
        to: "todo",
        source: "user",
      });
      await expect(preparation).rejects.toThrow(
        "Timed out stopping active work for FN-WEDGED before moving to Todo",
      );
    } finally {
      __setTaskMoveDisposalTimeoutForTesting();
    }
  });

  it.each([
    { from: "in-progress", to: "todo", source: "engine" },
    { from: "todo", to: "in-progress", source: "user" },
    { from: "in-progress", to: "in-review", source: "user" },
  ] as const)("does not cancel for $source $from to $to moves", async (move) => {
    const store = {} as never;
    const disposer = vi.fn();
    registerTaskMoveDisposer(store, disposer);

    await disposeTaskBeforeMove(store, {
      task: { id: "FN-UNCHANGED" } as never,
      ...move,
    });

    expect(disposer).not.toHaveBeenCalled();
  });
});
