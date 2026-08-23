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
import { getTaskMergeBlocker, type Settings, type Task, type TaskStore, type WorkflowIr } from "@fusion/core";

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

/*
FNXC:WorkflowLifecycleColumns 2026-08-01-22:10 (PR #2706 review — greptile P2, and the project's own
Surface Enumeration rule says the same thing):

The first block covered `requestInterpreterMerge` only, while the change also touches the merge-queue
snapshot, the queue drain, the `taskMoved` handoff, the pause-interruption tracker and the
session-advisor WIP guard. A suite that covers one of six surfaces can stay green while renamed-board
cards disappear from admission or pause tracking again.

Two more surfaces are covered here, chosen because they are the ones with STATE an assertion can see:

  - THE PAUSE-INTERRUPTION TRACKER, because it has state an assertion can see. On a renamed board its
    first branch DELETED every card from `pausedReviewTaskIds` and returned, so pausing an active merge
    never interrupted it.

NOT COVERED, and named rather than implied — I tried each of these before dropping it:

  - THE MERGE-QUEUE SNAPSHOT. Its failure is the quietest in the file (an EMPTY array for a queue full of
    review cards, with no log line saying why), so it is the one I most wanted. The admission provider is
    registered in the CONSTRUCTOR, which builds a whole runtime, so reaching its `refresh` needs a booted
    ProjectEngine. My first attempt looked the method up dynamically on the prototype and would have
    silently skipped — a case that cannot fail is worse than an absent one, so it is gone.
  - THE `taskMoved` HANDOFF and THE QUEUE DRAIN schedule real timers and recurse into the merge machinery.
  - THE SESSION-ADVISOR guard needs a live advisor.

Those four are covered by the census and by review only. Padding the suite with cases that assert nothing
would make the gap invisible, which is the failure this file already documents twice.
*/
describe("the other merge-lane surfaces on a renamed board", () => {
  function storeFor(column: string, ir: WorkflowIr | undefined) {
    const task = { id: "FN-Q", column, dependencies: [], steps: [] } as unknown as Task;
    const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
    return {
      task,
      store: {
        getTask: vi.fn(async () => task),
        getSettings: vi.fn(async () => ({ autoMerge: true }) as unknown as Settings),
        getTaskWorkflowSelection: () => (ir ? selection : undefined),
        getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
        getWorkflowDefinition: async () => (ir ? { ir } : undefined),
        /* `wireTaskPauseMergeInterruption` also subscribes to store events; the stub must accept that. */
        on: vi.fn(),
      } as unknown as TaskStore,
    };
  }

  it("keeps a renamed board's review card in the paused-review set", async () => {
    // Pre-fix: `signoff` !== "in-review", so the first branch DELETED the card and returned — pausing an
    // active merge never interrupted it.
    const { store, task } = storeFor("signoff", RENAMED_IR);
    const self = {
      pausedReviewTaskIds: new Set<string>(),
      mergeQueue: [] as string[],
      mergeActive: new Set<string>(),
      activeMergeTaskId: null as string | null,
      taskUpdatedHandler: undefined as unknown,
      abortActiveMerge: vi.fn(),
    };

    (ProjectEngine.prototype as unknown as {
      wireTaskPauseMergeInterruption: (this: unknown, s: TaskStore) => void;
    }).wireTaskPauseMergeInterruption.call(self, store);

    await (self.taskUpdatedHandler as (t: Task) => Promise<void>)({ ...task, paused: true } as Task);

    expect([...self.pausedReviewTaskIds]).toEqual([task.id]);
  });

  it("still drops a NON-review card from the paused-review set", async () => {
    // The paired negative: the set must not accumulate cards that are not in the merge lane.
    const { store, task } = storeFor("building", RENAMED_IR);
    const self = {
      pausedReviewTaskIds: new Set<string>([task.id]),
      mergeQueue: [] as string[],
      mergeActive: new Set<string>(),
      activeMergeTaskId: null as string | null,
      taskUpdatedHandler: undefined as unknown,
      abortActiveMerge: vi.fn(),
    };

    (ProjectEngine.prototype as unknown as {
      wireTaskPauseMergeInterruption: (this: unknown, s: TaskStore) => void;
    }).wireTaskPauseMergeInterruption.call(self, store);

    await (self.taskUpdatedHandler as (t: Task) => Promise<void>)({ ...task, paused: true } as Task);

    expect([...self.pausedReviewTaskIds]).toEqual([]);
  });

  /*
  FNXC:MergeReadiness 2026-08-23-18:49:
  ProjectEngine's live admission callbacks must receive the same resolved merge lane used by their
  surrounding column guard. Passing only the task makes the injected core blocker silently restore the
  `in-review` literal and prevents a renamed-lane card from re-entering the production merge queue.
  */
  it("re-enqueues an unpaused renamed-lane card through the live merge blocker", async () => {
    const { store, task } = storeFor("signoff", RENAMED_IR);
    const self = {
      options: { getTaskMergeBlocker },
      pausedReviewTaskIds: new Set<string>([task.id]),
      mergeQueue: [] as string[],
      mergeActive: new Set<string>(),
      activeMergeTaskId: null as string | null,
      taskUpdatedHandler: undefined as unknown,
      abortActiveMerge: vi.fn(),
      allowInReviewMergeProcessing: vi.fn(async () => true),
      classifyMergeSweepCandidate: vi.fn(async () => ({ admit: true })),
      internalEnqueueMerge: vi.fn(),
    };

    (ProjectEngine.prototype as unknown as {
      wireTaskPauseMergeInterruption: (this: unknown, s: TaskStore) => void;
    }).wireTaskPauseMergeInterruption.call(self, store);

    await (self.taskUpdatedHandler as (t: Task) => Promise<void>)({ ...task, paused: false } as Task);

    expect(self.internalEnqueueMerge).toHaveBeenCalledWith(task.id);
    expect(self.options.getTaskMergeBlocker(task, { reviewColumns: new Set(["signoff"]) })).toBeUndefined();
  });

  /*
  FNXC:MergeReadiness 2026-08-23-20:25:
  Lane forwarding is required at every live ProjectEngine merge-blocker door, not only unpause. The
  periodic sweep, final dequeue, and both sides of the handoff grace window must give the blocker the
  resolved `signoff` lane; otherwise any one of those callers can silently reject a renamed-lane card.
  */
  it("passes the resolved lane from the periodic sweep into the merge blocker", async () => {
    const { store, task } = storeFor("signoff", RENAMED_IR);
    const blocker = vi.fn(() => "blocked for assertion");
    const self = {
      options: { getTaskMergeBlocker: blocker, getMergeStrategy: vi.fn(() => "direct") },
      runtime: { getTaskStore: () => store },
      canMergeTask: (ProjectEngine.prototype as unknown as { canMergeTask: (...args: unknown[]) => boolean }).canMergeTask,
      allowInReviewMergeProcessing: vi.fn(async () => true),
      loadMergeSweepBatch: vi.fn(async () => ({})),
      classifyMergeSweepCandidate: vi.fn(async () => ({ admit: true })),
      mergeSweepHoldReasons: new Map<string, string>(),
      internalEnqueueMerge: vi.fn(),
    };

    const admitted = await (ProjectEngine.prototype as unknown as {
      enqueueEligibleInReviewTasks: (this: unknown, tasks: readonly Task[], settings: Pick<Settings, "autoMerge" | "maxAutoMergeRetries">) => Promise<number>;
    }).enqueueEligibleInReviewTasks.call(self, [task], { autoMerge: true, maxAutoMergeRetries: 3 });

    expect(admitted).toBe(0);
    expect(blocker).toHaveBeenCalledWith(task, { reviewColumns: new Set(["signoff"]) });
  });

  it("passes the resolved lane from the final dequeue into the merge blocker", async () => {
    const { store, task } = storeFor("signoff", RENAMED_IR);
    const blocker = vi.fn(() => "blocked for assertion");
    const mergeQueue = [task.id];
    const self = {
      options: { getTaskMergeBlocker: blocker, getMergeStrategy: vi.fn(() => "direct") },
      runtime: { getTaskStore: () => store },
      config: { workingDirectory: "/unused" },
      mergeQueue,
      coordinatorAdmittedMergeTaskIds: new Set<string>(),
      mergeRunning: false,
      mergeRunningSince: 0,
      mergeAbortController: null,
      shuttingDown: false,
      reconcileStaleMergeActive: vi.fn(),
      getShadowMergeRequestCandidateId: vi.fn(async () => null),
      pickNextMergeTaskId: vi.fn(async () => mergeQueue.shift()),
      hasMergeResolvers: vi.fn(() => false),
      allowInReviewMergeProcessing: vi.fn(async () => true),
      canMergeTask: (ProjectEngine.prototype as unknown as { canMergeTask: (...args: unknown[]) => boolean }).canMergeTask,
      schedulePrMergeRetry: vi.fn(),
      clearActiveMergeClaim: vi.fn(),
      clearMergeActive: vi.fn(),
    };

    await (ProjectEngine.prototype as unknown as {
      drainMergeQueue: (this: unknown) => Promise<void>;
    }).drainMergeQueue.call(self);

    expect(blocker).toHaveBeenCalledWith(task, { reviewColumns: new Set(["signoff"]) });
  });

  it("passes the resolved lane to both immediate and post-grace handoff blockers", async () => {
    vi.useFakeTimers();
    try {
      const { store, task } = storeFor("signoff", RENAMED_IR);
      const blocker = vi.fn(() => undefined);
      const self = {
        options: { getTaskMergeBlocker: blocker },
        taskMovedHandler: undefined as unknown,
        mergeActive: new Set<string>(),
        mergeQueue: [] as string[],
        activeMergeTaskId: null as string | null,
        clearMergeActive: vi.fn(),
        allowInReviewMergeProcessing: vi.fn(async () => true),
        classifyMergeSweepCandidate: vi.fn(async () => ({ admit: true })),
        internalEnqueueMerge: vi.fn(),
      };

      (ProjectEngine.prototype as unknown as {
        wireAutoMerge: (this: unknown, s: TaskStore, cwd: string) => void;
      }).wireAutoMerge.call(self, store, "/unused");

      await (self.taskMovedHandler as (event: { task: Task; to: string }) => Promise<void>)({ task, to: "signoff" });

      expect(blocker).toHaveBeenCalledTimes(1);
      expect(blocker).toHaveBeenLastCalledWith(task, { reviewColumns: new Set(["signoff"]) });

      await vi.runOnlyPendingTimersAsync();

      expect(blocker).toHaveBeenCalledTimes(2);
      expect(blocker).toHaveBeenLastCalledWith(task, { reviewColumns: new Set(["signoff"]) });
      expect(self.internalEnqueueMerge).toHaveBeenCalledWith(task.id);
    } finally {
      vi.useRealTimers();
    }
  });
});
