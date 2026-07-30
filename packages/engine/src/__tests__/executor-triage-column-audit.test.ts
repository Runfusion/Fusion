/*
FNXC:WorkflowLifecycleColumns 2026-07-29-15:30 (P0 audit after the Planning-column merge):

The default coding lineage no longer declares a `triage` column — it has ONE pre-implementation
column, id `todo`. `triage` remains a legal column id (legacy coding, the Task enum), so nothing
throws; every `column === "triage"` comparison simply stops matching for default-workflow cards.
Silent non-firing guards are the failure class this program has now found seven times.

These pin the two sites in the executor's ownership that genuinely misbehaved. Both were observed
FAILING against the pre-fix code.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskDetail, WorkflowIr } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import { UsageLimitPauser } from "../usage-limit-detector.js";

const WF = "custom:planning-only";

/** The post-merge default shape: ONE pre-implementation column, no `triage`. */
function planningOnlyIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "in-review", label: "In review", traits: [{ trait: "mergeOrchestration" }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

describe("dependency-abort cleanup requeues to a DECLARED column", () => {
  it("uses the workflow's own planner column, never the literal triage", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const selection = { workflowId: WF, stepIds: [] };
    store.getTask.mockResolvedValue({ id: "FN-DEP", column: "in-progress", branch: null } as TaskDetail);
    store.getTaskWorkflowSelection = vi.fn(() => selection);
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => selection);
    store.getWorkflowDefinition = vi.fn(async () => ({ id: WF, ir: planningOnlyIr() }));
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleDepAbortCleanup("FN-DEP", "/tmp/test/wt");

    /*
    The failure this pins: the card was parked in a column its workflow does not declare, where
    nothing routes it onward and only a restart-time reconcile could rescue it.
    */
    expect(store.moveTask).toHaveBeenCalledWith("FN-DEP", "todo");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-DEP", "triage");
  });
});

describe("usage-limit fan-out still recognises the planning lane", () => {
  function detectorHarness(tasks: Task[], ir: WorkflowIr = planningOnlyIr()) {
    const store = createMockStore();
    const selection = { workflowId: WF, stepIds: [] };
    store.getSettings.mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15_000 });
    store.listTasks = vi.fn().mockResolvedValue(tasks);
    store.getTask.mockResolvedValue(tasks[0]);
    store.pauseTask = vi.fn().mockResolvedValue(undefined);
    store.getTaskWorkflowSelection = vi.fn(() => selection);
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => selection);
    store.getWorkflowDefinition = vi.fn(async () => ({ id: WF, ir }));
    return { store, detector: new UsageLimitPauser(store as never) };
  }

  /** A workflow with a SECOND processing lane — not a planning column, despite not being wip. */
  function twoLaneIr(): WorkflowIr {
    return {
      version: "v2",
      id: WF,
      nodes: [],
      edges: [],
      columns: [
        { id: "todo", label: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", label: "Build", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "qa", label: "QA", traits: [] },
        { id: "done", label: "Done", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
  }

  const planning = (id: string, column: string): Task =>
    ({ id, column, paused: false, planningModelProvider: "anthropic", planningModelId: "m" }) as Task;

  it("pauses a peer card sitting in the merged Planning column (id `todo`)", async () => {
    /*
    Before the fix the lane resolved to no providers for a `todo` card, so the peer kept running
    against the rate-limited provider. Nothing failed — the containment just stopped happening.
    */
    const peer = planning("FN-PEER", "todo");
    const { store, detector } = detectorHarness([planning("FN-TRIGGER", "todo"), peer]);

    await detector.onUsageLimitHit("triage", "FN-TRIGGER", "429 usage limit reached", "anthropic");

    expect(store.pauseTask).toHaveBeenCalledWith("FN-PEER", true, undefined, expect.anything());
  });

  it("still pauses a peer in a workflow that DOES declare triage (legacy coding)", async () => {
    const peer = planning("FN-PEER", "triage");
    const legacyIr = { version: "v2", id: WF, nodes: [], edges: [], columns: [
      { id: "triage", label: "Triage", traits: [{ trait: "intake" }] },
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ] } as unknown as WorkflowIr;
    const { store, detector } = detectorHarness([planning("FN-TRIGGER", "triage"), peer], legacyIr);

    await detector.onUsageLimitHit("triage", "FN-TRIGGER", "429 usage limit reached", "anthropic");

    expect(store.pauseTask).toHaveBeenCalledWith("FN-PEER", true, undefined, expect.anything());
  });

  it("does NOT treat a custom non-terminal column as a planning lane", async () => {
    /*
    FNXC PR #2572 review (greptile): the previous predicate was "not in-progress and not
    in-review", which reads ANY custom column — a second processing lane, a manual hold, a
    bespoke review stage — as pre-implementation. A planning-provider limit would then pause
    cards nowhere near planning. `qa` carries no lifecycle trait, so it is not the planning lane.
    */
    const peer = planning("FN-PEER", "qa");
    const { store, detector } = detectorHarness([planning("FN-TRIGGER", "todo"), peer], twoLaneIr());

    await detector.onUsageLimitHit("triage", "FN-TRIGGER", "429 usage limit reached", "anthropic");

    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-PEER", true, undefined, expect.anything());
  });

  it("does NOT treat a MID-PIPELINE hold column as a planning lane", async () => {
    /*
    FNXC PR #2572 review (greptile, 2nd): `hold` is not a synonym for planning. A workflow may
    carry the trait on a manual/timed/dependency wait that sits AFTER implementation; a card
    parked there is not queued for planning and must not be paused by a planning-provider limit.
    */
    const midPipelineHoldIr = { version: "v2", id: WF, nodes: [], edges: [], columns: [
      { id: "todo", label: "Planning", traits: [{ trait: "intake" }] },
      { id: "in-progress", label: "Build", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "awaiting-signoff", label: "Awaiting sign-off", traits: [{ trait: "hold", config: { release: "manual" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ] } as unknown as WorkflowIr;
    const peer = planning("FN-PEER", "awaiting-signoff");
    const { store, detector } = detectorHarness([planning("FN-TRIGGER", "todo"), peer], midPipelineHoldIr);

    await detector.onUsageLimitHit("triage", "FN-TRIGGER", "429 usage limit reached", "anthropic");

    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-PEER", true, undefined, expect.anything());
  });

  it("does NOT sweep a card that is mid-implementation into the planning lane", async () => {
    /* The guard must stay narrow: an in-progress card is the executor lane's business. */
    const peer = planning("FN-PEER", "in-progress");
    const { store, detector } = detectorHarness([planning("FN-TRIGGER", "todo"), peer]);

    await detector.onUsageLimitHit("triage", "FN-TRIGGER", "429 usage limit reached", "anthropic");

    expect(store.pauseTask).not.toHaveBeenCalledWith("FN-PEER", true, undefined, expect.anything());
  });
});
