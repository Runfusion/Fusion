import { describe, expect, it, vi } from "vitest";
import {
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
