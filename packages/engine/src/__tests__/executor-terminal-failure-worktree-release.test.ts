import { beforeEach, describe, expect, it, vi } from "vitest";

import { countLiveWorktreeHolders, listLiveWorktreeHolders, listWorktreeHolderIds, listWorktreeHolders } from "../executor/list-worktree-holders.js";
import { addActiveWorktree } from "../executor/active-worktrees.js";
import { TaskExecutor } from "../executor.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import "./executor-test-helpers.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import { join } from "node:path";
import type { TaskDetail } from "@fusion/core";
import { WORKFLOW_DRIFT_PARK_CONTEXT_KEY } from "../workflows/workflow-graph-executor.js";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-1001",
    title: "Workspace card",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-1001",
    baseBranch: "main",
    worktree: "worktrees/fn-1001/repo",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as TaskDetail;
}

/*
FNXC:WorktreeLiveness 2026-10-08-04:24 (RUFU-323):
A plain execute-node graph failure: no review lane (so no verdict-less reroute), an unresolvable workflow
IR (so `wipColumn` falls back to `in-progress`, matching the card's column), and no tool-failure or
escalation state — which routes `handleGraphFailure` to the immediate terminal write.
*/
function makeGraphFailure() {
  return {
    disposition: "failed",
    outcome: "failure",
    visitedNodeIds: ["execute"],
    context: {},
  };
}

/*
FNXC:WorktreeLiveness 2026-10-08-04:04 (RUFU-323):
The operator symptom: two cards whose runs had already ended `failed` kept the project's
`active_tasks` guard refusing an isolation transition, because `InProcessRuntime.getMetrics()`
answered "how much work is running" with the raw size of the executor's *ownership* map.
These suites pin the replacement contract from both sides — the holder count is liveness-derived
(Step 1/2), and a landed terminal park never leaves its binding behind (Step 3) — plus the guard
behavior the operator reads (Step 4).
*/

/*
FNXC:WorktreeLiveness 2026-10-08-04:58 (RUFU-323):
Shared harness for the two engine-level suites below: a real `TaskExecutor` over the mock store with one
checkout registered for the card, so a case can drive the real `handleGraphFailure` sink and then read
the consequence either through the executor's holder accounting or through a real runtime's metric.
*/
const repoRoot = join(".fusion", "worktrees", "rufu-323");
const worktreePath = join(repoRoot, "wt");

function makeHarness(options: {
  task?: Partial<TaskDetail>;
  settings?: Record<string, unknown>;
  updateTaskAtomic?: ReturnType<typeof vi.fn>;
} = {}) {
  const store = createMockStore();
  const task = makeTask(options.task);
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: false,
    ...options.settings,
  });
  (store as any).claimInterruptedStepSessionRepair = vi.fn().mockResolvedValue(null);
  (store as any).markToolFailureRetryExhaustedAudit = vi.fn().mockResolvedValue(false);
  if (options.updateTaskAtomic) {
    store.updateTaskAtomic = options.updateTaskAtomic as unknown as typeof store.updateTaskAtomic;
  }
  const executor = new TaskExecutor(store, repoRoot, {});
  addActiveWorktree((executor as any).activeWorktrees, task.id, worktreePath);
  return { store, task, executor };
}

describe("countLiveWorktreeHolders (liveness-derived holder accounting)", () => {
  it("counts nothing when no card owns a checkout", () => {
    expect(countLiveWorktreeHolders(new Map(), () => true)).toBe(0);
  });

  it("counts every holder when the predicate reports each task live", () => {
    const activeWorktrees = new Map<string, Set<string>>([
      ["FN-1001", new Set(["/wt/fn-1001"])],
      ["FN-1002", new Set(["/wt/fn-1002"])],
      ["FN-1003", new Set(["/wt/fn-1003"])],
    ]);

    expect(countLiveWorktreeHolders(activeWorktrees, () => true)).toBe(3);
    // Guard-equivalent: the raw map size and the live count agree while everything is running.
    expect(activeWorktrees.size).toBe(listWorktreeHolders(activeWorktrees).length);
  });

  it("counts nothing when every holder belongs to a card that is not live", () => {
    // The reported shape: terminal cards still bound to their checkouts.
    const activeWorktrees = new Map<string, Set<string>>([
      ["SANE-435", new Set(["/wt/sane-435"])],
      ["SANE-453", new Set(["/wt/sane-453"])],
    ]);

    expect(countLiveWorktreeHolders(activeWorktrees, () => false)).toBe(0);
    // What the pre-fix metric reported for this exact state — the false positive itself.
    expect(activeWorktrees.size).toBe(2);
  });

  it("counts a workspace card once even when it holds several sub-repo checkouts", () => {
    const activeWorktrees = new Map<string, Set<string>>([
      ["FN-2001", new Set(["/wt/apps/api", "/wt/apps/web"])],
      ["FN-2002", new Set(["/wt/apps/cli"])],
    ]);

    expect(countLiveWorktreeHolders(activeWorktrees, () => true)).toBe(2);
    // Path rows are the ownership view; the metric counts distinct tasks, so the two differ by design.
    expect(listWorktreeHolders(activeWorktrees)).toHaveLength(3);
  });

  it("asks the predicate per task and never per path", () => {
    const seen: string[] = [];
    const activeWorktrees = new Map<string, Set<string>>([
      ["FN-3001", new Set(["/wt/a", "/wt/b"])],
      ["FN-3002", new Set(["/wt/c"])],
    ]);

    const live = countLiveWorktreeHolders(activeWorktrees, (taskId) => {
      seen.push(taskId);
      return taskId === "FN-3002";
    });

    expect(live).toBe(1);
    expect(seen).toEqual(["FN-3001", "FN-3002"]);
  });

  it("treats an empty worktree set as no holder at all, matching listWorktreeHolders", () => {
    // A released-but-not-deleted key must not read as busy work either.
    const activeWorktrees = new Map<string, Set<string>>([["FN-4001", new Set()]]);

    expect(countLiveWorktreeHolders(activeWorktrees, () => true)).toBe(0);
    expect(listWorktreeHolders(activeWorktrees)).toHaveLength(0);
  });
});

/*
FNXC:IsolationTransitionBlockers 2026-10-15-03:25 (RUFU-328):
Id-level holder listings. The isolation-transition veto refuses by NAME, so the executor must be able to
say WHICH cards it holds, not merely how many — and the count must be the live list's length rather than
a second rule over the same map, or a card can be counted without being nameable. Two listings on purpose:
the liveness-filtered ids (the metric's own source) and every held id (what destroying a runtime would
actually interrupt). The wider list must never DROP a live id, only add to it; the holder rule (an empty
checkout Set is no holder, a workspace card is one holder whatever its sub-repo count) is shared with the
count so the two cannot disagree about who holds anything.
*/
describe("holder id listings (one derivation with the live count)", () => {
  it("names exactly the cards the live count counted", () => {
    const activeWorktrees = new Map<string, Set<string>>([
      ["SANE-435", new Set(["/wt/sane-435"])],
      ["SANE-453", new Set(["/wt/sane-453"])],
    ]);
    const isLive = (taskId: string) => taskId === "SANE-453";

    const liveIds = listLiveWorktreeHolders(activeWorktrees, isLive);

    expect(liveIds).toEqual(["SANE-453"]);
    // The count IS this list: no card is counted that the veto could not name.
    expect(countLiveWorktreeHolders(activeWorktrees, isLive)).toBe(liveIds.length);
  });

  it("names every held id liveness aside, keeping a workspace card single", () => {
    const activeWorktrees = new Map<string, Set<string>>([
      ["FN-2001", new Set(["/wt/apps/api", "/wt/apps/web"])],
      ["FN-2002", new Set(["/wt/apps/cli"])],
    ]);

    // One row per card, not per path — a card holding N sub-repos is one blocker, named once.
    expect(listWorktreeHolderIds(activeWorktrees)).toEqual(["FN-2001", "FN-2002"]);
    // A released-but-not-deleted key holds nothing, so it names nobody.
    expect(listWorktreeHolderIds(new Map([["FN-4001", new Set()]]))).toEqual([]);
  });

  it("widens the held-id list beyond the live list without ever dropping a live id", () => {
    const activeWorktrees = new Map<string, Set<string>>([
      ["FN-5001", new Set(["/wt/a"])],
      ["FN-5002", new Set(["/wt/b"])],
      ["FN-5003", new Set(["/wt/c"])],
    ]);
    const live = listLiveWorktreeHolders(activeWorktrees, (taskId) => taskId === "FN-5002");
    const held = listWorktreeHolderIds(activeWorktrees);

    expect(live).toEqual(["FN-5002"]);
    expect(held).toEqual(["FN-5001", "FN-5002", "FN-5003"]);
    for (const id of live) expect(held).toContain(id);
  });

  it("keeps a real executor's count and id list in agreement across a terminal park", async () => {
    const store = createMockStore();
    const task = makeTask();
    const sibling = makeTask({ id: "RUFU-328-B", title: "Still executing" });
    store.getTask.mockResolvedValue(task);
    (store as any).claimInterruptedStepSessionRepair = vi.fn().mockResolvedValue(null);
    const executor = new TaskExecutor(store, repoRoot, {});
    addActiveWorktree((executor as any).activeWorktrees, task.id, worktreePath);
    addActiveWorktree((executor as any).activeWorktrees, sibling.id, join(repoRoot, "wt-b"));
    // Only the sibling is on an execution surface; the parked card still holds its checkout.
    (executor as any).executing.add(sibling.id);

    expect(executor.listWorktreeHolderIds()).toEqual([task.id, sibling.id]);
    expect(executor.listLiveWorktreeHolderIds()).toEqual([sibling.id]);
    expect(executor.getLiveWorktreeHolderCount()).toBe(executor.listLiveWorktreeHolderIds().length);

    await (executor as any).handleGraphFailure(task, makeGraphFailure());

    // The committed park releases its claim, so both the held list and the live list lose it.
    expect(executor.listWorktreeHolderIds()).toEqual([sibling.id]);
    expect(executor.listLiveWorktreeHolderIds()).toEqual([sibling.id]);
    expect(executor.getLiveWorktreeHolderCount()).toBe(1);
  });
});

/*
FNXC:WorktreeLiveness 2026-10-08-04:24 (RUFU-323):
Release invariant for the terminal parks. `handleGraphFailure` is one of only two places allowed to end
a worktree-ownership claim, and before this change NO terminal park released anything: the graph
`finally` releases only external-execution checkouts and `execute()`'s release is gated on
`task.paused`, so a failed card's entry survived forever and was counted as in-flight work.

Each case drives the real `handleGraphFailure` on a real `TaskExecutor` and asserts the binding on both
sides of the fence: a park that COMMITS releases, while a park that is declined, thrown, or preempted by
a honoring classifier preserves it. Releasing on a skipped park would delete the holder of a run that is
still using the checkout.
*/
describe("terminal graph-failure park releases the worktree binding", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  /** The reducer-honouring atomic seam the real store provides: a null reducer declines, a patch commits. */
  function atomicSeam(store: ReturnType<typeof createMockStore>, readRow: () => TaskDetail) {
    return vi.fn(async (id: string, updater: (current: TaskDetail) => Record<string, unknown> | null) => {
      const patch = await updater(readRow());
      if (patch) store.updateTask(id, patch as Partial<TaskDetail>, undefined);
      return store.getTask(id);
    });
  }

  it("releases the binding when the terminal write commits", async () => {
    const { task, executor } = makeHarness();
    expect(executor.getActiveWorktreePaths(task.id)).toEqual([worktreePath]);

    await (executor as any).handleGraphFailure(task, makeGraphFailure());

    expect(executor.getActiveWorktreePaths(task.id)).toEqual([]);
    expect(executor.getLiveWorktreeHolderCount()).toBe(0);
  });

  it("keeps the binding when the terminal fence declines the write", async () => {
    const store = createMockStore();
    const task = makeTask();
    // The row is already terminal when the fenced reducer reads it, so the reducer declines the write.
    const declinedRow: TaskDetail = { ...task, status: "failed" };
    store.getTask.mockResolvedValue(task);
    (store as any).claimInterruptedStepSessionRepair = vi.fn().mockResolvedValue(null);
    store.updateTaskAtomic = atomicSeam(store, () => declinedRow) as unknown as typeof store.updateTaskAtomic;
    const executor = new TaskExecutor(store, repoRoot, {});
    addActiveWorktree((executor as any).activeWorktrees, task.id, worktreePath);

    await (executor as any).handleGraphFailure(task, makeGraphFailure());

    // Resolved-but-declined is NOT a landed park: the row belongs to another disposition now and a
    // newer run may hold this binding. Releasing here is the hazard this task must never introduce,
    // which is why the release hangs on the committed reducer path rather than on the call resolving.
    expect(executor.getActiveWorktreePaths(task.id)).toEqual([worktreePath]);
  });

  it("keeps the binding when the terminal write throws", async () => {
    const { store, task, executor } = makeHarness({
      updateTaskAtomic: vi.fn().mockRejectedValue(new Error("store unavailable")),
    });
    (store as any).claimNextToolFailureRetry = vi.fn().mockResolvedValue({ outcome: "exhausted" });
    (executor as any).hasTrailingConsecutiveToolFailures = async () => true;

    await (executor as any).handleGraphFailure(task, makeGraphFailure());

    // A write that never landed is not a park. The deferred chain may still park this card later,
    // so the binding stays claimed until then — releasing here would drop a live card's checkout.
    expect(executor.getActiveWorktreePaths(task.id)).toEqual([worktreePath]);
  });

  it("keeps the binding for a park that stays recoverable by requeue", async () => {
    const { store, task, executor } = makeHarness();
    const driftFailure = {
      ...makeGraphFailure(),
      context: { [WORKFLOW_DRIFT_PARK_CONTEXT_KEY]: true },
    };

    await (executor as any).handleGraphFailure(task, driftFailure);

    /*
     * The drift park deliberately preserves worktree/branch/step progress so an ordinary requeue can
     * resume the card, so it must NOT release the ownership claim: the checkout is still the card's to
     * continue in. That is the boundary of this task's release rule — releases follow parks that END
     * the run's ownership, not every write of a status. (RUFU-291's cancel exit, which does release,
     * stays pinned end-to-end by `executor-user-cancel-terminal-graph-exit.test.ts`.)
     */
    expect(executor.getActiveWorktreePaths(task.id)).toEqual([worktreePath]);
    expect(store.updateTask.mock.calls.some(([, patch]) => patch.status === "failed")).toBe(true);
  });

  it("leaves a still-live sibling untouched when the parked card exits", async () => {
    const store = createMockStore();
    const task = makeTask();
    const sibling = makeTask({ id: "RUFU-323-B", title: "Still executing" });
    store.getTask.mockResolvedValue(task);
    (store as any).claimInterruptedStepSessionRepair = vi.fn().mockResolvedValue(null);
    const executor = new TaskExecutor(store, repoRoot, {});
    addActiveWorktree((executor as any).activeWorktrees, task.id, worktreePath);
    addActiveWorktree((executor as any).activeWorktrees, sibling.id, join(repoRoot, "wt-b"));
    (executor as any).executing.add(sibling.id);
    // The parked card is idle so it already counts zero (the derivation), while the registry holds both.
    expect(executor.getLiveWorktreeHolderCount()).toBe(1);
    expect((executor as any).activeWorktrees.size).toBe(2);

    await (executor as any).handleGraphFailure(task, makeGraphFailure());

    expect(executor.getActiveWorktreePaths(task.id)).toEqual([]);
    expect(executor.getActiveWorktreePaths(sibling.id)).toEqual([join(repoRoot, "wt-b")]);
    expect(executor.getLiveWorktreeHolderCount()).toBe(1);
    expect((executor as any).activeWorktrees.size).toBe(1);
  });
});

/*
FNXC:WorktreeLiveness 2026-10-08-04:58 (RUFU-323):
The operator symptom stated end to end, at the exact value the guard reads. SANE-435 and SANE-453 were
`status: "failed"` cards parked in the WIP lane while `ProjectManager.restartProjectRuntime()` refused
the isolation transition with `{ kind: "active_tasks", count }`, because that guard reads
`InProcessRuntime.getMetrics().inFlightTasks` and the metric answered with the size of the executor's
worktree-OWNERSHIP map. These cases wire a REAL runtime to a REAL executor and drive the REAL failure
sink, so neither half of the fix can be faked out: the release at the terminal park and the liveness
derivation both have to hold for the number to reach zero. The paired live case is what proves the
fix did not simply silence the guard.
*/
describe("in-flight metric after a real graph failure parks the only card", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  function makeRuntimeFor(executor: TaskExecutor): any {
    const runtime = new InProcessRuntime(
      {
        projectId: "proj_rufu323",
        workingDirectory: repoRoot,
        isolationMode: "in-process",
      } as any,
      {} as any,
    );
    runtime.executor = executor;
    return runtime;
  }

  it("reports zero in-flight work for the project the transition guard is judging", async () => {
    const { task, executor } = makeHarness();
    const runtime = makeRuntimeFor(executor);

    await (executor as any).handleGraphFailure(task, makeGraphFailure());

    // This is the number `restartProjectRuntime()` compares against zero; on HEAD it was 1.
    expect(runtime.getMetrics().inFlightTasks).toBe(0);
    expect(runtime.getMetrics().activeAgents).toBe(0);
  });

  it("still reports the card as in-flight while its run is live on the execution surface", () => {
    const { task, executor } = makeHarness();
    const runtime = makeRuntimeFor(executor);
    (executor as any).executing.add(task.id);

    // Guard protection is unchanged: genuinely running work still refuses the transition.
    expect(runtime.getMetrics().inFlightTasks).toBe(1);
  });
});
