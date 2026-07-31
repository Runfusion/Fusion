import { describe, expect, it, vi } from "vitest";
import "@fusion/core"; // registers the built-in column traits
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

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-15:35 (batch-core):

  THE HARD CANCEL MUST FIRE ON A RENAMED BOARD.

  Keyed on `from === "in-progress" && to === "todo"`, this returned early for every board that renamed
  either lane, so the disposer never ran: a user pulling a card out of active execution got a task
  that LOOKS parked while its agent kept running. A cancellation contract failing OPEN — the operator
  believes the work stopped.

  The resolution is LAZY, taken only when the literals do not already match, because an unconditional
  await pushed the disposer past the one-microtask window the test above pins. That is why this case
  drives a board whose lanes share NO id with the legacy pair.
  */
  it("fires the hard cancel on a RENAMED board", async () => {
    const renamedIr = {
      version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
      columns: [
        { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
      ],
    };
    const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
    const store = {
      getTaskWorkflowSelection: () => selection,
      getTaskWorkflowSelectionAsync: async () => selection,
      getWorkflowDefinition: async () => ({ id: "wf-renamed", ir: renamedIr }),
    } as never;
    const disposer = vi.fn().mockResolvedValue(undefined);
    registerTaskMoveDisposer(store, disposer);

    await disposeTaskBeforeMove(store, {
      task: { id: "FN-RENAMED" } as never,
      from: "building",
      to: "backlog",
      source: "user",
    });

    expect(disposer).toHaveBeenCalledOnce();
  });

  it("does NOT fire for a renamed move that is not wip -> pre-wip", async () => {
    /*
    The paired negative: resolving lanes must not turn every user move into a cancel. `backlog` is
    the hold lane, so hold -> wip is a start, not a cancel.
    */
    const renamedIr = {
      version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
      columns: [
        { id: "backlog", name: "Backlog", traits: [{ trait: "hold" }] },
        { id: "building", name: "Building", traits: [{ trait: "wip" }] },
      ],
    };
    const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
    const store = {
      getTaskWorkflowSelection: () => selection,
      getTaskWorkflowSelectionAsync: async () => selection,
      getWorkflowDefinition: async () => ({ id: "wf-renamed", ir: renamedIr }),
    } as never;
    const disposer = vi.fn().mockResolvedValue(undefined);
    registerTaskMoveDisposer(store, disposer);

    await disposeTaskBeforeMove(store, {
      task: { id: "FN-START" } as never,
      from: "backlog",
      to: "building",
      source: "user",
    });

    expect(disposer).not.toHaveBeenCalled();
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
