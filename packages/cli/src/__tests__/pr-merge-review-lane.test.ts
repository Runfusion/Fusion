/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:55:
THE INVARIANT: a PR merge is decided against THIS task's merge lane, not the literal `in-review`.

`processPullRequestMergeTask` called its injected `getTaskMergeBlocker` with the task alone, so the
blocker's `options.reviewColumns` was undefined and its identity check fell back to
`task.column === "in-review"`. On a renamed board it answered `task is in 'checking', must be in
'in-review'` and this function returned "skipped" — silently, forever. Nothing logs and nothing fails;
the PR just never merges. `daemon.ts`, `serve.ts` and `dashboard.ts` all drain PR merges through here.

There was no test for this function at all, which is why it went unnoticed.

Both cases below fail when the product change is reverted: the first sees the blocker called with no
options, the second gets "skipped" back for a card sitting in its board's real merge lane.
*/
import { describe, expect, it, vi } from "vitest";
import { getTaskMergeBlocker } from "@fusion/core";
import { processPullRequestMergeTask } from "../commands/task-lifecycle.js";

const renamedIr = {
  id: "wf-renamed",
  version: "v2",
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

function makeTask(column: string) {
  return {
    id: "FN-1",
    column,
    description: "task",
    paused: false,
    status: null,
    error: null,
    steps: [],
    workflowStepResults: [],
    dependencies: [],
    currentStep: 0,
    log: [],
  };
}

function createStore(column: string, workflowId: string | undefined = "wf-renamed") {
  return {
    getTask: vi.fn(async () => makeTask(column)),
    getTaskWorkflowSelectionAsync: vi.fn(async () => (workflowId ? { workflowId } : undefined)),
    getTaskWorkflowSelection: vi.fn(() => (workflowId ? { workflowId } : undefined)),
    getWorkflowDefinition: vi.fn(async () => ({ id: "wf-renamed", ir: renamedIr })),
  };
}

/* The merge path needs a real repo it will not get here; the blocker decision happens first, which is
   the whole point, so the throw afterwards is caught and never asserted on. */
async function runAndSettle(store: unknown, blocker: unknown): Promise<string> {
  try {
    return (await processPullRequestMergeTask(
      store as never,
      "/nonexistent-cwd",
      "FN-1",
      {} as never,
      blocker as never,
    )) as string;
  } catch (error) {
    return `threw:${(error as Error).message}`;
  }
}

describe("PR merge decides against the task's own merge lane", () => {
  it("hands the blocker the resolved merge lane, not the literal", async () => {
    const blocker = vi.fn(() => undefined);

    await runAndSettle(createStore("checking"), blocker);

    expect(blocker).toHaveBeenCalledWith(
      expect.objectContaining({ column: "checking" }),
      { reviewColumns: new Set(["checking"]) },
    );
  });

  it("does not skip a card sitting in the board's real merge lane", async () => {
    // The REAL core blocker — the one daemon/serve/dashboard actually inject.
    const result = await runAndSettle(createStore("checking"), getTaskMergeBlocker);

    expect(result).not.toBe("skipped");
  });

  it("still skips a card that is not in any merge lane", async () => {
    const result = await runAndSettle(createStore("building"), getTaskMergeBlocker);

    expect(result).toBe("skipped");
  });

  it("falls back to the legacy lane when the workflow resolves no merge column", async () => {
    // A v1-upgraded IR resolves every role empty; `in-review` must still merge there.
    const blocker = vi.fn(() => undefined);
    const store = createStore("in-review", undefined);
    store.getWorkflowDefinition = vi.fn(async () => ({ id: "v1", ir: { id: "v1", version: "v2", columns: [] } })) as never;

    await runAndSettle(store, blocker);

    expect(blocker).toHaveBeenCalledWith(expect.objectContaining({ column: "in-review" }), { reviewColumns: undefined });
  });
});
