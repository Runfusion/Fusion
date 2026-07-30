/*
FNXC:WorkflowLifecycleColumns 2026-08-02-09:20 (fleet: the CLI surface on a renamed board):

THE INVARIANT: `active=N` counts the board's own wip and review lanes.

The same four-line aggregation appears FOUR times in `dashboard.ts` — the TUI stats refresh, the serve
summary, the status line, and the agent-stats pass — each comparing the default lineage's two ids. On a
renamed board every one reported `active=0` while the board was plainly busy.

WHY THIS IS WORSE THAN AN INTERNAL INERT GUARD: this number is the operator's first read of a project. A
recovery path that silently stops firing is invisible until something breaks; a stats line that says zero is
read, believed, and acted on — "nothing is running, so I can restart the engine".

The four copies are now one helper, which is the other half of the fix: four independent copies of a
lifecycle decision is how they drift, and these four were identical by accident rather than by construction.
*/
import { describe, expect, it, vi } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";

import { countActiveTasks } from "../commands/dashboard.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed",
  nodes: [{ id: "start", kind: "start", column: "backlog" }],
  edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function storeFor(ir: WorkflowIr | undefined) {
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const getWorkflowDefinition = vi.fn(async () => (ir ? { ir } : undefined));
  return {
    store: {
      getTaskWorkflowSelection: () => (ir ? selection : undefined),
      getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
      getWorkflowDefinition,
    } as unknown as TaskStore,
    getWorkflowDefinition,
  };
}

describe("the CLI's active-task count resolves the board's lanes", () => {
  it("counts a renamed board's wip and review cards", async () => {
    // Pre-fix: neither `building` nor `signoff` matched, so this returned 0 for a busy board.
    const { store } = storeFor(RENAMED_IR);

    const active = await countActiveTasks(store, [
      { id: "FN-1", column: "building" },
      { id: "FN-2", column: "signoff" },
      { id: "FN-3", column: "backlog" },
      { id: "FN-4", column: "shipped" },
    ]);

    expect(active).toBe(2);
  });

  it("counts nothing when no card is in either lane", async () => {
    // The paired negative: the count must not degrade into "every card is active".
    const { store } = storeFor(RENAMED_IR);

    expect(await countActiveTasks(store, [
      { id: "FN-5", column: "backlog" },
      { id: "FN-6", column: "shipped" },
    ])).toBe(0);
  });

  it("resolves one IR per WORKFLOW, not per task", async () => {
    /*
    The cost of converting a per-list aggregation is the reason to assert this: a 500-card board must not
    become 500 workflow reads. The shared cache is what makes that true, and only a call count can see it —
    the returned number is identical either way.
    */
    const { store, getWorkflowDefinition } = storeFor(RENAMED_IR);
    const tasks = Array.from({ length: 25 }, (_, i) => ({ id: `FN-${i}`, column: "building" }));

    expect(await countActiveTasks(store, tasks)).toBe(25);
    expect(getWorkflowDefinition).toHaveBeenCalledTimes(1);
  });

  it("behaves identically on the DEFAULT board", async () => {
    // No workflow selection: falls back to the legacy pair. Passes either way by design.
    const { store } = storeFor(undefined);

    expect(await countActiveTasks(store, [
      { id: "FN-7", column: "in-progress" },
      { id: "FN-8", column: "in-review" },
      { id: "FN-9", column: "todo" },
    ])).toBe(2);
  });
});
