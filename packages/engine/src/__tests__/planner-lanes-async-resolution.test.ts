import { describe, expect, it, vi } from "vitest";
import { resolvePlannerLanes, resolvePlannerLanesForTaskAsync } from "../replan-target.js";
import type { TaskStore, WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-23:10 (fleet — the sync resolver never resolved):

`resolvePlannerLanes` reads `store.resolveTaskWorkflowIrSync`, whose selection reader
(`getTaskWorkflowSelectionImpl`) returns `undefined` UNCONDITIONALLY in PostgreSQL mode — the shipped
backend. So it resolves the DEFAULT workflow for every task and answers with the legacy ids no matter
what board the card is on, while still reporting `resolvedFromWorkflow: true` because an IR did come
back. A caller branching on that flag is told the lanes are workflow-resolved and handed the defaults.

That is worse than an unconverted literal: it reads as converted, the lifecycle-column census counts
it, and the guard behaves exactly as the literal did.

WHAT THESE CASES PIN. The two resolvers are given the SAME store and the SAME task. The sync one is
handed a store whose sync reader behaves as production's does (no selection → default IR); the async
one resolves through the authoritative path. They must disagree, and the async one must be right —
that disagreement is the entire reason `recoverCompletedTask` was switched over.

The store here is a fake on purpose: the production-fidelity proof that the sync selection reader
returns undefined against a REAL PostgreSQL store lives in
`core/src/__tests__/postgres/sync-workflow-ir-is-always-default.pg.test.ts`. This suite pins the
CONSEQUENCE for planner lanes, cheaply, where the engine can assert it.
*/

const RENAMED_IR = {
  version: "v2",
  id: "custom:renamed-planning",
  nodes: [],
  edges: [],
  columns: [
    { id: "ideas", label: "Ideas", traits: [{ trait: "intake" }] },
    { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", label: "Checking", traits: [{ trait: "human-review" }, { trait: "merge" }] },
    { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/**
 * A store whose ASYNC readers see the task's real workflow and whose SYNC selection reader returns
 * undefined — which is exactly what PostgreSQL mode does in production.
 */
function createStore(): TaskStore {
  const selection = { workflowId: "custom:renamed-planning", stepIds: [] as string[] };
  return {
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: RENAMED_IR })),
    /*
    FNXC:WorkflowResolvedColumns 2026-08-01-02:07 DELIBERATE-SYNC:
    Removing this production-faithful DEFAULT-IR stub and running
    `pnpm --filter @fusion/engine exec vitest run src/__tests__/planner-lanes-async-resolution.test.ts --silent=passed-only --reporter=dot`
    produced 1 failed / 3 passed: the named SYNC contrast no longer reported
    `resolvedFromWorkflow: true`. The stub intentionally proves that an inert sync read can look
    resolved, while the authoritative async reader returns the renamed workflow.
    */
    resolveTaskWorkflowIrSync: vi.fn(() => BUILTIN_DEFAULT_IR),
  } as unknown as TaskStore;
}

/** Stand-in for the built-in coding workflow's lanes, which is what the sync path always returns. */
const BUILTIN_DEFAULT_IR = {
  version: "v2",
  id: "builtin:coding",
  nodes: [],
  edges: [],
  columns: [
    { id: "triage", label: "Triage", traits: [{ trait: "intake" }] },
    { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "in-review", label: "In Review", traits: [{ trait: "human-review" }, { trait: "merge" }] },
    { id: "done", label: "Done", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

describe("planner lanes resolve through the ASYNC path", () => {
  it("the async resolver returns the task's OWN lanes", async () => {
    const lanes = await resolvePlannerLanesForTaskAsync(createStore(), "FN-1");

    expect(lanes.hold).toBe("drafting");
    expect(lanes.intake).toBe("ideas");
    expect(lanes.wip).toBe("building");
    expect(lanes.review).toBe("checking");
    expect(lanes.complete).toBe("shipped");
  });

  /*
  The defect, stated as a contrast rather than asserted about production: given the same store and
  task, the sync resolver answers with the DEFAULT lanes — and still claims it resolved from the
  workflow, which is what makes it undetectable at the call site.
  */
  it("the SYNC resolver answers with default lanes for the same task, and claims it resolved", () => {
    const lanes = resolvePlannerLanes(createStore(), "FN-1");

    expect(lanes.hold).toBe("todo");
    expect(lanes.hold).not.toBe("drafting");
    expect(lanes.wip).not.toBe("building");
    /* The misleading part: nothing at the call site can tell this answer apart from a real one. */
    expect(lanes.resolvedFromWorkflow).toBe(true);
  });

  /* The two must not agree, or this suite would pass with the async twin deleted. */
  it("the two resolvers DISAGREE for the same task — the reason the caller was switched", async () => {
    const store = createStore();
    const sync = resolvePlannerLanes(store, "FN-1");
    const async = await resolvePlannerLanesForTaskAsync(store, "FN-1");

    expect(async.hold).not.toBe(sync.hold);
    expect(async.wip).not.toBe(sync.wip);
  });

  /*
  The paired negative: an unresolvable workflow must degrade to the DEFAULT lineage's planner lanes,
  never to "missing". The conversion must not turn "unknown" into "no lane".

  `intake` is `todo`, not `triage`, and that is CORRECT rather than a fallback bug — worth stating
  because it looks wrong. `resolveWorkflowIrForTask` has its own default-IR fallback, so this does not
  reach the `LEGACY_PLANNER_LANES` catch at all; it resolves the DEFAULT lineage, which post-U11 no
  longer declares an intake column. `intake: lifecycle.intake ?? lifecycle.hold` then correctly
  reports the hold lane, because on that board planning work rests there. Asserting `triage` here
  would be pinning a column the product deleted.
  */
  it("degrades to the DEFAULT lineage's planner lanes when the workflow cannot be resolved", async () => {
    const brokenStore = {
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getTaskWorkflowSelectionAsync: vi.fn(async () => { throw new Error("no db"); }),
      getWorkflowDefinition: vi.fn(async () => { throw new Error("no db"); }),
    } as unknown as TaskStore;

    const lanes = await resolvePlannerLanesForTaskAsync(brokenStore, "FN-1");

    expect(lanes.hold).toBe("todo");
    expect(lanes.intake).toBe("todo");
    /* Not "missing": the forward lanes still resolve, so a caller can still promote. */
    expect(lanes.wip).toBe("in-progress");
  });
});
