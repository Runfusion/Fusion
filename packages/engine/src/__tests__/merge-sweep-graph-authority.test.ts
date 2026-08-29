import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ currentStore: null as any }));

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getTaskStore: () => testState.currentStore,
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      configurePrMonitoring: vi.fn(),
      setActiveMergeTaskIdProvider: vi.fn(),
      setActiveMergeStartedAtMsProvider: vi.fn(),
      setActiveMergeAborter: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergeActiveClearer: vi.fn(),
      setMergePendingProvider: vi.fn(),
      setMergeRequester: vi.fn(),
      resumeAfterUnpause: vi.fn(async () => undefined),
      getPluginRunner: vi.fn(() => undefined),
    };
  }),
}));

import type { Task } from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { ProjectEngine } from "../project-engine.js";

/*
FNXC:MergeAuthority 2026-08-23-18:05 (FN-9191 + FN-9193 wedges):
SYMPTOM these pin: the in-review auto-merge sweep merged cards its workflow had not authorized.
FN-9191 — merged ~2s after `fn_task_done`, before Code Review had ever started.
FN-9193 — merged while Code Review was RE-running; the gate then requested revision and reset the
steps, the in-flight merge landed the pre-remediation branch on main, and the card was left
`mergeConfirmed` WITH incomplete steps, which nothing could finalize for five hours.

ASSERTION: the sweep enqueues only cards whose graph reached the merge region, or that are
recovering an already-authorized merge. It never initiates one.
*/

const AN_HOUR_AGO = () => new Date(Date.now() - 60 * 60_000).toISOString();

function inReview(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    column: "in-review",
    paused: false,
    mergeRetries: 0,
    status: null,
    steps: [],
    enabledWorkflowSteps: [],
    updatedAt: AN_HOUR_AGO(),
    ...overrides,
  } as unknown as Task;
}

/** `nodeId` names an ACTIVE `kind:"task"` continuation — where the graph is holding the card. */
function makeStore(continuationsByTask: Record<string, string[]> = {}) {
  return {
    getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
    getTask: vi.fn(async () => null),
    listWorkflowWorkItemsForTask: vi.fn(async (taskId: string) =>
      (continuationsByTask[taskId] ?? []).map((nodeId, i) => ({
        id: `${taskId}-wi-${i}`,
        taskId,
        nodeId,
        kind: "task",
        state: "held",
      })),
    ),
    getBranchGroup: vi.fn(async () => ({ status: "open", branchName: "main" })),
    getTaskWorkflowSelection: () => undefined,
    getTaskWorkflowSelectionAsync: async () => undefined,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

function createEngine(store: ReturnType<typeof makeStore>) {
  testState.currentStore = store;
  const engine = new ProjectEngine(
    {
      projectId: "proj_test",
      workingDirectory: "/tmp/proj_test",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 2,
    },
    {} as never,
    { skipNotifier: true },
  ) as any;
  const enqueueSpy = vi.spyOn(engine, "internalEnqueueMerge").mockImplementation(() => true);
  const sweep = (tasks: Task[]): Promise<number> =>
    engine.enqueueEligibleInReviewTasks(tasks, { autoMerge: true });
  return { engine, enqueueSpy, sweep };
}

describe("auto-merge sweep respects the graph's merge authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executingTaskLock._clearForTest();
    for (const path of activeSessionRegistry.pathsForTask("FN-workspace")) {
      activeSessionRegistry.unregisterPath(path);
    }
  });

  it("holds a card the graph is holding at Code Review (FN-9193)", async () => {
    const store = makeStore({ "FN-9193": ["code-review"] });
    const { enqueueSpy, sweep } = createEngine(store);

    expect(await sweep([inReview("FN-9193")])).toBe(0);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("admits a card parked at its merge-attempt node", async () => {
    const store = makeStore({ "FN-merge": ["merge-attempt"] });
    const { enqueueSpy, sweep } = createEngine(store);

    expect(await sweep([inReview("FN-merge")])).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith("FN-merge");
  });

  /* MULTI-REPO: a shared-branch member's integration node is its merge lane. */
  it("admits a shared-branch member parked at branch-group-member-integration", async () => {
    const store = makeStore({ "FN-member": ["branch-group-member-integration"] });
    const { enqueueSpy, sweep } = createEngine(store);
    const member = inReview("FN-member", {
      branchContext: { assignmentMode: "shared", groupId: "BG-1", source: "mission" },
    } as Partial<Task>);

    expect(await sweep([member])).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith("FN-member");
  });

  /* MULTI-REPO: a workspace task mid sub-repo land registers its repo path; never dispatch over it. */
  it("holds a workspace task while a sub-repo land session is live", async () => {
    const store = makeStore({ "FN-workspace": ["merge-attempt"] });
    const { enqueueSpy, sweep } = createEngine(store);
    activeSessionRegistry.registerPath("/tmp/proj_test/repos/api", {
      taskId: "FN-workspace",
      kind: "workspace-repo-land",
    } as never);

    try {
      expect(await sweep([inReview("FN-workspace")])).toBe(0);
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      activeSessionRegistry.unregisterPath("/tmp/proj_test/repos/api");
    }
  });

  /* FN-9193's aftermath: the branch landed, so finalization must still be reachable. */
  it("admits a confirmed merge for finalization even with incomplete steps", async () => {
    const store = makeStore({ "FN-landed": ["execute"] });
    const { enqueueSpy, sweep } = createEngine(store);
    const landed = inReview("FN-landed", {
      steps: [{ status: "pending" }],
      mergeDetails: { mergeConfirmed: true, commitSha: "eaa1d47c" },
    } as unknown as Partial<Task>);

    expect(await sweep([landed])).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith("FN-landed");
  });

  /* FN-9191: marked done seconds ago, gates never ran, nothing scheduled yet. */
  it("holds a just-completed card whose pre-merge gates have not run", async () => {
    const store = makeStore({});
    const { enqueueSpy, sweep } = createEngine(store);
    const justDone = inReview("FN-9191", {
      enabledWorkflowSteps: ["plan-review", "code-review"],
      updatedAt: new Date().toISOString(),
    });

    expect(await sweep([justDone])).toBe(0);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("still rescues a long-quiescent card with nothing scheduled and gates satisfied", async () => {
    const store = makeStore({});
    const { enqueueSpy, sweep } = createEngine(store);

    expect(await sweep([inReview("FN-stalled")])).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledWith("FN-stalled");
  });

  /*
  FNXC:MergeAuthority 2026-08-23-20:05 (review findings #1, #2, #9):
  THE SWEEP WAS NEVER THE ONLY DOOR. Three other paths reach `internalEnqueueMerge` or dispatch a
  queued merge; gating only the sweep left the fastest one (a 300ms column-entry handoff, which
  matches FN-9191's observed timing better than any 15s sweep tick) wide open.
  */
  describe("every merge door proves graph authority", () => {
    it("holds the 300ms column-entry handoff for a card at Code Review (#1)", async () => {
      const store = makeStore({ "FN-handoff": ["code-review"] });
      const { engine, enqueueSpy } = createEngine(store);
      const task = inReview("FN-handoff");
      store.getTask.mockResolvedValue(task);

      await (engine as any).classifyMergeSweepCandidate(task, new Map(), undefined, { ignoreOwnMergePipeline: true })
        .then((admission: { admit: boolean; reason: string }) => {
          expect(admission).toEqual({ admit: false, reason: "not-at-merge-region-node" });
        });
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it("admits the handoff once the graph reaches its merge region (#1)", async () => {
      const store = makeStore({ "FN-handoff": ["merge-attempt"] });
      const { engine } = createEngine(store);
      const admission = await (engine as any).classifyMergeSweepCandidate(
        inReview("FN-handoff"), new Map(), undefined, { ignoreOwnMergePipeline: true },
      );
      expect(admission).toEqual({ admit: true, reason: "at-merge-region-node" });
    });

    /* FN-3900: a card whose own merge is already queued/running must still be (re-)enqueued by the
       leaked-mergeActive rescue — that is dedupe, not someone else's work. */
    it("does not treat this card's own in-flight merge as foreign liveness (#1)", async () => {
      const store = makeStore({ "FN-busy": ["merge-attempt"] });
      const { engine } = createEngine(store);
      (engine as any).activeMergeTaskId = "FN-busy";

      expect(await (engine as any).classifyMergeSweepCandidate(inReview("FN-busy"), new Map()))
        .toEqual({ admit: false, reason: "live-session" });
      expect(await (engine as any).classifyMergeSweepCandidate(
        inReview("FN-busy"), new Map(), undefined, { ignoreOwnMergePipeline: true },
      )).toEqual({ admit: true, reason: "at-merge-region-node" });
    });

    it("refuses to dispatch a queued card the graph moved out of the merge region (#2)", async () => {
      const store = makeStore({ "FN-bounced": ["code-review"] });
      const { engine } = createEngine(store);
      expect(await (engine as any).isDispatchStillGraphAuthorized(inReview("FN-bounced"))).toBe(false);
    });

    it("fails the dispatch guard OPEN when position is unknowable (#2)", async () => {
      // No continuation at all is the interrupted-merge / quiescent-recovery shape, and an
      // unreadable read is the door's problem, not this guard's.
      const { engine: noContinuation } = createEngine(makeStore({}));
      expect(await (noContinuation as any).isDispatchStillGraphAuthorized(inReview("FN-none"))).toBe(true);

      const throwing = makeStore({});
      throwing.listWorkflowWorkItemsForTask = vi.fn(async () => { throw new Error("db down"); });
      const { engine: unreadable } = createEngine(throwing);
      expect(await (unreadable as any).isDispatchStillGraphAuthorized(inReview("FN-unreadable"))).toBe(true);
    });
  });
});
