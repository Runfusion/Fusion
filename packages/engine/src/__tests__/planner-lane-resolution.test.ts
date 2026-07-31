/*
FNXC:WorkflowLifecycleColumns 2026-07-30-12:50 (U11 — PR #2610 review):

The resolver that makes the two planner-lane seams DRIVEN rather than defaulted.
Both review bots flagged that every production caller omitted `plannerColumns`;
they were right, so the callers now pass these.

The asymmetry is the whole reason there are two functions, and it is what these
tests pin — especially the merged case, where the DEDICATED resolver must return
an empty list rather than the merged column. Returning the merged column would
stop a parked card with preserved progress from skipping staleness, which the
pre-existing U11 proof in `spec-staleness.test.ts` calls "same column, different
status, opposite correct answer".
*/
import { describe, expect, it, vi } from "vitest";
import type { TaskStore, WorkflowIr } from "@fusion/core";

import {
  resolveDedicatedPlannerColumnsForTask,
  resolvePlannerLanesForTask,
} from "../planner-lane-resolution.js";

function storeWith(ir: WorkflowIr | null): TaskStore {
  const selection = { workflowId: "custom:wf", stepIds: [] };
  return {
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => (ir ? { ir } : null)),
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:59:
    The `resolveTaskWorkflowIrSync` stub is REMOVED, and it was redundant: this suite passes without
    it. That reader answers with the DEFAULT board for every task in production, so stubbing it with a
    working IR feeds the broken reader the right answer — the suite would keep passing even if its
    call site stopped resolving. Audited across the 8 files that stubbed it (#3197): four were
    redundant like this one, one is legitimately about the sync path, one was masking real inertness.
    */
  } as unknown as TaskStore;
}

function ir(columns: { id: string; traits: unknown[] }[]): WorkflowIr {
  return { version: "v2", id: "custom:wf", nodes: [], edges: [], columns } as unknown as WorkflowIr;
}

const SPLIT = ir([
  { id: "inbox", traits: [{ trait: "intake" }] },
  { id: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
  { id: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
]);

const MERGED = ir([
  { id: "planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
  { id: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
]);

describe("planner lane resolution", () => {
  it("returns BOTH lanes for a split workflow", async () => {
    expect(await resolvePlannerLanesForTask(storeWith(SPLIT), "FN-1")).toEqual(["inbox", "drafting"]);
  });

  it("collapses a merged workflow's lanes to one entry", async () => {
    expect(await resolvePlannerLanesForTask(storeWith(MERGED), "FN-1")).toEqual(["planning"]);
  });

  it("returns the intake column as DEDICATED only when it is not also the hold lane", async () => {
    expect(await resolveDedicatedPlannerColumnsForTask(storeWith(SPLIT), "FN-1")).toEqual(["inbox"]);
  });

  it("returns NO dedicated planner column for a merged workflow", async () => {
    /*
    The load-bearing case. An empty list is the correct ANSWER here, not a failed
    resolution: on a merged lineage the planner distinction is carried by status.
    */
    expect(await resolveDedicatedPlannerColumnsForTask(storeWith(MERGED), "FN-1")).toEqual([]);
  });

  it("falls back to the DEFAULT workflow's lanes when the task's own cannot be read", async () => {
    /*
    Asserts what actually happens, which is not what I first assumed. I expected
    `undefined` here; `resolveWorkflowIrForTask` instead falls back to the DEFAULT
    workflow IR, so resolution never reports ignorance — the same behaviour that
    makes `resolveTaskWorkflowIrSync` return the default rather than a selection.

    Post-#2515 the default lineage is MERGED, so:
      - the lane resolver yields its single planner column, and
      - the dedicated resolver correctly yields NOTHING.

    The empty list is right, not a lost guard: `triage` is not declared by that
    lineage at all, so a card sitting there is not in a dedicated planner lane —
    it is stranded, which is the undeclared-column rescue's job, not this guard's.
    */
    expect(await resolvePlannerLanesForTask(storeWith(null), "FN-1")).toEqual(["todo"]);
    expect(await resolveDedicatedPlannerColumnsForTask(storeWith(null), "FN-1")).toEqual([]);
  });
  it("EXCLUDES a hold column that sits AFTER implementation (PR #2616 review)", async () => {
    /*
    The defect: `resolveLifecycleColumns` returns the FIRST hold-trait column with no
    positional constraint, so a workflow using a hold trait for a MID-PIPELINE wait
    had that column returned as a planner lane — and mission reconciliation demoted
    the feature to `triaged`, reporting started work as not-yet-started.

    Silent, and wrong in the direction that makes a roadmap lie. It survived because
    every lineage anyone tested puts the hold in FRONT of wip.
    */
    const midPipelineHold = ir([
      { id: "inbox", traits: [{ trait: "intake" }] },
      { id: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "awaiting-signoff", traits: [{ trait: "hold", config: { release: "manual" } }] },
    ]);
    expect(await resolvePlannerLanesForTask(storeWith(midPipelineHold), "FN-1")).toEqual(["inbox"]);
  });

  it("still INCLUDES a hold column that precedes implementation", async () => {
    /* The direction that must not change — every shipped lineage is this shape. */
    expect(await resolvePlannerLanesForTask(storeWith(SPLIT), "FN-1")).toEqual(["inbox", "drafting"]);
  });

});
