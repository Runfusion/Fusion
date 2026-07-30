// @vitest-environment node
/*
FNXC:WorkflowLifecycleColumns 2026-08-01-19:50 (fleet: project-engine.ts merge lane):

THE INVARIANT: the merge machinery recognises the task's OWN merge lane.

Every merge guard in `project-engine.ts` spelled it `in-review`. The consequence on a renamed board is
not an error anywhere — it is auto-merge DECLINING every card:

  - `requestInterpreterMerge` returns `noOp: true` ("parked cleanly in review, awaiting human merge")
    for a card that was in review and fully eligible;
  - the merge-queue snapshot returns an EMPTY list for a queue full of review cards, so the
    coordinator sees nothing to admit;
  - the taskMoved handoff never fires, so nothing is handed to auto-merge in the first place.

That is why this class has no error signature to search for: the operator sees cards resting in review
with auto-merge on, and every log line says the system did the right thing.

HOW THIS DRIVES THE REAL METHOD. `ProjectEngine`'s constructor builds a whole runtime, which a unit
test has no business standing up — so the method is invoked with `.call()` on a minimal `this`
providing exactly what it touches: `runtime.getTaskStore()`, `allowInReviewMergeProcessing`, and
`onMerge`. The body under test is the shipped one, not a copy. `onMerge` is stubbed because reaching it
IS the assertion: eligible routes to the serialized merge path, ineligible returns the `noOp` result.

REVERT PROOF, measured: restore the literal and the renamed-board case returns `noOp: true` instead of
routing to `onMerge`.
*/
import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { ProjectEngine } from "../project-engine.js";

/** A board whose merge lane is `signoff`, sharing no lifecycle id with the default lineage. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function harness(column: string, ir: WorkflowIr | undefined) {
  const task = { id: "FN-1", column, branch: "fusion/FN-1", dependencies: [], steps: [] } as unknown as Task;
  const settings = { autoMerge: true, globalPause: false, enginePaused: false } as unknown as Settings;
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };

  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => settings),
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
    getWorkflowDefinition: async () => (ir ? { ir } : undefined),
  } as unknown as TaskStore;

  const onMerge = vi.fn(async () => ({ task, branch: task.branch ?? "", merged: true } as never));
  const self = {
    runtime: { getTaskStore: () => store },
    allowInReviewMergeProcessing: vi.fn(async () => true),
    onMerge,
  };

  const call = () =>
    (ProjectEngine.prototype as unknown as {
      requestInterpreterMerge: (this: unknown, id: string, o?: unknown) => Promise<{ noOp?: boolean; merged?: boolean }>;
    }).requestInterpreterMerge.call(self, "FN-1", {});

  return { call, onMerge, task };
}

describe("project-engine merge eligibility resolves the board's own merge lane", () => {
  it("routes a RENAMED board's review card to the merge path instead of declining it", async () => {
    // Pre-fix: `signoff` !== "in-review", so this returned noOp:true and the card sat in review with
    // auto-merge on and a log line saying manual merge was required.
    const { call, onMerge } = harness("signoff", RENAMED_IR);

    const result = await call();

    expect(onMerge).toHaveBeenCalledTimes(1);
    expect(result.noOp).toBeUndefined();
  });

  it("still declines a card that is NOT in the merge lane", async () => {
    // The paired negative: a card mid-implementation must not be merged.
    const { call, onMerge } = harness("building", RENAMED_IR);

    const result = await call();

    expect(onMerge).not.toHaveBeenCalled();
    expect(result.noOp).toBe(true);
    expect(result.merged).toBe(false);
  });

  it("behaves identically on the DEFAULT board", async () => {
    // No workflow selection: resolution falls back to `in-review`, unchanged behaviour. This case
    // passes either way by design and is here as no-change evidence, not as coverage.
    const { call, onMerge } = harness("in-review", undefined);

    await call();

    expect(onMerge).toHaveBeenCalledTimes(1);
  });
});
