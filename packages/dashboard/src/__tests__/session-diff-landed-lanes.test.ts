// @vitest-environment node

/*
FNXC:WorkflowResolvedColumns 2026-07-31-00:55 (batch-core):

"HAS THIS TASK LANDED?" — THE QUESTION THAT PICKS THE DIFF BOUNDARY.

The two diff routes chose between a MERGE-COMMIT diff (finished work, already on the integration
branch) and a LIVE-BRANCH diff by comparing `task.column === "done"`. On a renamed board a landed task
took the live-branch path, so its diff was computed against a branch that had been merged and usually
deleted — an empty or misleading diff for exactly the tasks an operator reviews after the fact.

`landedColumnsForTask` holds that decision. Testing the seam rather than the routes is deliberate:
an HTTP fixture over these route registrars starts background work and hangs (measured while
converting `register-git-github.ts`), and mocking git + the GitHub client to get past it is the
mock-the-world shell FN-5048 tells us not to add.

Both roles count as landed, and both fallback directions are pinned, because they fail differently:
an unresolvable workflow and a v1-upgraded one (every synthesized column carries `traits: []`, so the
resolved set is EMPTY even though the columns exist) must BOTH keep the legacy pair. Reading empty as
"this board has no complete lane" would send every pre-v2 project down the live-branch path.
*/
import { describe, expect, it, vi } from "vitest";
import "@fusion/core"; // registers the built-in column traits so flags resolve
import { landedColumnsForTask } from "../routes/register-session-diff-routes.js";

function storeWith(ir: unknown, workflowId = "wf") {
  const selection = { workflowId, stepIds: [] as string[] };
  return {
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    getWorkflowDefinition: async () => (ir === undefined ? undefined : { id: workflowId, ir }),
  } as never;
}

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "attic", name: "Attic", traits: [{ trait: "archived" }] },
  ],
};

/** Exactly what synthesizeDefaultColumns emits for a v1 graph: every column, NO traits. */
const V1_UPGRADED_IR = {
  version: "v2", id: "wf-v1", name: "legacy", nodes: [], edges: [],
  columns: ["todo", "in-progress", "in-review", "done", "archived"].map((id) => ({ id, name: id, traits: [] })),
};

describe("landedColumnsForTask", () => {
  it("returns the renamed complete AND archived lanes, and not the legacy ids", async () => {
    const landed = await landedColumnsForTask(storeWith(RENAMED_IR), "FN-1");

    expect([...landed].sort()).toEqual(["attic", "shipped"]);
    /*
    The archived half is asserted explicitly: the two roles resolve independently and have failed
    independently before, so a fixture that only proved `complete` would miss half the guard.
    */
    expect(landed.has("done")).toBe(false);
  });

  it("falls back to the legacy pair for a V1-UPGRADED workflow whose columns carry no traits", async () => {
    expect([...(await landedColumnsForTask(storeWith(V1_UPGRADED_IR), "FN-1"))].sort()).toEqual(["archived", "done"]);
  });

  it("falls back to the legacy pair when the workflow cannot be resolved at all", async () => {
    const store = {
      getTaskWorkflowSelectionAsync: async () => { throw new Error("unreadable"); },
      getTaskWorkflowSelection: () => { throw new Error("unreadable"); },
      getWorkflowDefinition: vi.fn(),
    } as never;

    expect([...(await landedColumnsForTask(store, "FN-1"))].sort()).toEqual(["archived", "done"]);
  });
});
