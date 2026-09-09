/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:00 (census-invisible moveTask destinations):
The two MOVE-TARGET resolvers, which are the other half of a lifecycle conversion.

The census is an AST scan for COMPARISONS, so a `moveTask` DESTINATION — a call argument — is invisible
to it. Seven production call sites now route through these two functions instead of a hardcoded id; one
definition, so call sites cannot drift. See
`docs/solutions/architecture-patterns/hardcoded-movetask-destinations-are-census-invisible.md`.

The fallbacks are load-bearing, not defensive padding: `resolveWorkflowIrForTask` degrades to the
BUILT-IN IR rather than throwing, and the built-in board's rebound lane is `todo`, so the fallback
cases below also pin that default behavior remains stable.

REVERT CHECK, measured: replacing either body with a bare `return "<legacy id>"` fails its renamed case.
*/
import { describe, expect, it, vi } from "vitest";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import type { WorkflowIrResolverStore } from "../workflows/workflow-ir-resolver.js";
import { resolveReboundTargetForTask, resolveWipTargetForTask } from "../workflows/workflow-lifecycle-traits.js";

function storeWith(ir: WorkflowIr | undefined): WorkflowIrResolverStore {
  return {
    getTaskWorkflowSelectionAsync: vi.fn(async () => (ir ? { workflowId: "wf", stepIds: [] } : undefined)),
    getTaskWorkflowSelection: vi.fn(() => (ir ? { workflowId: "wf", stepIds: [] } : undefined)),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "wf" && ir ? { ir } : undefined)),
  } as unknown as WorkflowIrResolverStore;
}

const throwingStore = {
  getTaskWorkflowSelectionAsync: vi.fn(async () => { throw new Error("store unavailable"); }),
  getTaskWorkflowSelection: vi.fn(() => { throw new Error("store unavailable"); }),
  getWorkflowDefinition: vi.fn(async () => undefined),
} as unknown as WorkflowIrResolverStore;

/** A board sharing no ids with the legacy vocabulary. */
const RENAMED: WorkflowIr = {
  version: "v2",
  id: "wf",
  name: "renamed",
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
  ],
  nodes: [{ id: "start", kind: "start", column: "backlog" }],
  edges: [],
} as unknown as WorkflowIr;

/*
FNXC:WorkflowResolvedColumns 2026-07-30-19:30 (#2808 review — coderabbit):
The two `.not.toBe(legacyId)` cases are DELETED, and the comment that called one of them
"Non-vacuous" had it exactly backwards.

Each sat directly beneath a positive case asserting an exact resolved target. An exact
equality is strictly stronger than a negation: nothing can satisfy `toBe("backlog")` and still return
`"todo"`. So the negatives could not fail unless the positive had already failed, and they would have
passed for any wrong-but-not-legacy id — which is the weakness they claimed to be guarding against.

The remaining cases pin resolved targets and legacy fallbacks for both an unresolvable workflow and a throwing lookup.
*/
describe("resolveReboundTargetForTask", () => {
  it("resolves the board's own hold lane", async () => {
    await expect(resolveReboundTargetForTask(storeWith(RENAMED), "FN-1")).resolves.toBe("backlog");
  });

  it("falls back to the legacy id when no workflow resolves", async () => {
    await expect(resolveReboundTargetForTask(storeWith(undefined), "FN-1")).resolves.toBe("todo");
  });

  it("falls back to the legacy id when the lookup throws", async () => {
    await expect(resolveReboundTargetForTask(throwingStore, "FN-1")).resolves.toBe("todo");
  });
});

describe("resolveWipTargetForTask", () => {
  it("resolves the board's own wip lane", async () => {
    await expect(resolveWipTargetForTask(storeWith(RENAMED), "FN-1")).resolves.toBe("building");
  });

  it("falls back to the legacy id when no workflow resolves", async () => {
    await expect(resolveWipTargetForTask(storeWith(undefined), "FN-1")).resolves.toBe("in-progress");
  });

  it("falls back to the legacy id when the lookup throws", async () => {
    await expect(resolveWipTargetForTask(throwingStore, "FN-1")).resolves.toBe("in-progress");
  });
});
