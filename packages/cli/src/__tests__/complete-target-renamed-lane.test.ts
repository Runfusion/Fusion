/*
FNXC:WorkflowResolvedColumns 2026-07-30-20:25 (census-invisible moveTask destinations):
The CLI's merge-completion paths (`finalizePullRequestMerge`, `finalizeNoOpMergeTask`) both passed a
hardcoded `"done"` to `moveTask`. The destination is a call ARGUMENT, so the lifecycle-column census —
an AST scan for comparisons — never pointed at either.

Since U12 hoisted the `workflowHasColumn` rejection out of its dead flag-gated branch, a board that does
not declare `done` REJECTS that move. Both callers run `updateTask({ status: null, mergeRetries: 0 })`
FIRST, so on a rejection the merge has already landed and the bookkeeping is already cleared while the
card never reaches its complete lane: the operator sees a merged branch, a card still sitting in review,
and a reset retry counter.

SCOPE, stated rather than implied: this covers the RESOLVER, not the two call sites. Both enclosing
functions are private to the module and reachable only through `processPullRequest`, which needs a live
GitHub surface; exporting them purely to test the wiring would be a worse trade than saying plainly what
is and is not covered. Both call sites now route through this one helper, so they cannot drift from each
other — the same argument as triage's two copies of the terminal filter.

REVERT CHECK, measured: with the body replaced by a bare `return "done"`, the renamed case fails.
*/
import { describe, expect, it, vi } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";
import { resolveCompleteTargetForTask } from "../commands/task-lifecycle.js";

function storeWith(ir: WorkflowIr | undefined): TaskStore {
  return {
    getTaskWorkflowSelectionAsync: vi.fn(async () => (ir ? { workflowId: "cli-lifecycle", stepIds: [] } : undefined)),
    getTaskWorkflowSelection: vi.fn(() => (ir ? { workflowId: "cli-lifecycle", stepIds: [] } : undefined)),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "cli-lifecycle" && ir ? { ir } : undefined)),
  } as unknown as TaskStore;
}

/** Minimal IR: one hold lane and a complete lane whose id is NOT the legacy one. */
const RENAMED_IR = {
  version: "v2",
  id: "cli-lifecycle",
  name: "cli",
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "backlog" }],
  edges: [],
} as unknown as WorkflowIr;

describe("resolveCompleteTargetForTask", () => {
  it("resolves the workflow's OWN complete lane", async () => {
    await expect(resolveCompleteTargetForTask(storeWith(RENAMED_IR), "FN-1")).resolves.toBe("shipped");
  });

  it("falls back to the legacy id when no workflow resolves", async () => {
    /*
    Load-bearing: `resolveWorkflowIrForTask` degrades to the BUILT-IN IR rather than throwing, and the
    built-in complete lane IS `done` — so this also pins that a default board is byte-identical.
    */
    await expect(resolveCompleteTargetForTask(storeWith(undefined), "FN-1")).resolves.toBe("done");
  });

  it("falls back to the legacy id when the workflow lookup throws", async () => {
    const store = {
      getTaskWorkflowSelectionAsync: vi.fn(async () => { throw new Error("store unavailable"); }),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
    } as unknown as TaskStore;

    await expect(resolveCompleteTargetForTask(store, "FN-1")).resolves.toBe("done");
  });
});
