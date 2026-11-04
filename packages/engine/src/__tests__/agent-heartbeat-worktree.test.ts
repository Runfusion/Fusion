import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentHeartbeatRun } from "@fusion/core";
import { OVERLAP_DELIVERY_UNAVAILABLE_ERROR } from "@fusion/core";
import { OverlapResumeSynchronizationError } from "../executor/overlap-resume-gate.js";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { __resetOverlapAcquisitionParkDedup } from "../executor/overlap-acquisition-park.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";
import * as worktreeBackend from "../worktree/worktree-backend.js";
import { TaskBranchBaseDivergedError } from "../worktree/task-base-resolution.js";
import * as piModule from "../pi.js";

describe("heartbeat worktree cwd", () => {
  let store: any;
  let taskStore: any;
  const agent: Agent = { id: "a1", name: "A", role: "executor", state: "active", taskId: "FN-1", createdAt: "", updatedAt: "", metadata: {} } as any;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(piModule, "createFnAgent").mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({ worktreePath: "/tmp/wt", branch: "fusion/fn-1", source: "existing", hydrated: false, isResume: true });

    const run: AgentHeartbeatRun = { id: "r1", agentId: "a1", status: "active", startedAt: new Date().toISOString(), endedAt: null } as any;
    store = {
      startHeartbeatRun: vi.fn().mockResolvedValue(run),
      saveRun: vi.fn(),
      getRunDetail: vi.fn().mockResolvedValue(run),
      getAgent: vi.fn().mockResolvedValue(agent),
      updateAgentState: vi.fn(),
      updateAgent: vi.fn(),
      endHeartbeatRun: vi.fn(),
      assignTask: vi.fn(),
      getBudgetStatus: vi.fn().mockResolvedValue({ isOverBudget: false, isOverThreshold: false, usagePercent: 0 }),
      getCachedAgent: vi.fn().mockReturnValue(null),
      getLastBlockedState: vi.fn().mockResolvedValue(null),
      setLastBlockedState: vi.fn(),
      clearLastBlockedState: vi.fn(),
      appendRunLog: vi.fn(),
      getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
      recordHeartbeat: vi.fn(),
    };
    taskStore = {
      getSettings: vi.fn().mockResolvedValue({}),
      getTask: vi.fn().mockResolvedValue({ id: "FN-1", title: "t", description: "d", column: "todo", dependencies: [], steps: [], log: [] }),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      appendAgentLog: vi.fn(),
      listTasks: vi.fn().mockResolvedValue([]),
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes acquired worktree before creating task-scoped session", async () => {
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ id: "FN-1" }),
      refreshStaleBase: true,
    }));
    expect(piModule.createFnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/wt" }));
    expect(worktreeAcquisition.acquireTaskWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(piModule.createFnAgent).mock.invocationCallOrder[0],
    );
  });

  it("acknowledges heartbeat overlap context only after success and delivers a later generation", async () => {
    const episode = (id: string, predecessor: string, revision: number) => ({
      phase: "ready", episodeId: id, revision, owner: "heartbeat-owner",
      receipt: {
        decision: "briefing", freshness: "proven", commonFiles: ["src/shared.ts"], deliveryProofs: [],
        decisionFingerprint: `${id}-generation`, briefing: `OVERLAP_WAIT_CONTEXT:\n${predecessor} delivered src/shared.ts`,
        decidedAt: new Date().toISOString(),
      },
    });
    const first = episode("heartbeat-overlap-a", "FN-A", 3);
    const second = episode("heartbeat-overlap-c", "FN-C", 7);
    let delivery = { context: first.receipt.briefing, episodes: [first] };
    const failedPrompt = vi.fn(async () => { throw new Error("transport failed"); });
    const retryPrompt = vi.fn(async () => undefined);
    const nextGenerationPrompt = vi.fn(async () => undefined);
    vi.spyOn(piModule, "createFnAgent")
      .mockResolvedValueOnce({ session: { prompt: failedPrompt, dispose: vi.fn() } } as any)
      .mockResolvedValueOnce({ session: { prompt: retryPrompt, dispose: vi.fn() } } as any)
      .mockResolvedValueOnce({ session: { prompt: nextGenerationPrompt, dispose: vi.fn() } } as any);
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockImplementation(async () => ({
      worktreePath: "/tmp/wt", branch: "fusion/fn-1", source: "existing", hydrated: false, isResume: true,
      overlapResumeDelivery: delivery,
    } as any));
    taskStore.completeTaskOverlapWait = vi.fn(async (input: any) => ({ ...input, phase: "delivered" }));

    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    expect(taskStore.completeTaskOverlapWait).not.toHaveBeenCalled();

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    expect(retryPrompt).toHaveBeenCalledWith(expect.stringContaining("FN-A delivered src/shared.ts"));
    expect(taskStore.completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "heartbeat-overlap-a", phase: "delivered" }));

    delivery = { context: second.receipt.briefing, episodes: [second] };
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    expect(nextGenerationPrompt).toHaveBeenCalledWith(expect.stringContaining("FN-C delivered src/shared.ts"));
    expect(taskStore.completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "heartbeat-overlap-c", phase: "delivered" }));
  });

  it("uses rootDir for no-task runs", async () => {
    store.getAgent.mockResolvedValue({ ...agent, taskId: undefined, soul: "x" });
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    expect(worktreeAcquisition.acquireTaskWorktree).not.toHaveBeenCalled();
    expect(piModule.createFnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
  });

  it("completes with worktree_acquisition_failed when helper throws", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValueOnce(new Error("nope"));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    expect(piModule.createFnAgent).not.toHaveBeenCalled();
    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-1", "todo", { preserveProgress: true });
    // FN-7721: first failure bumps the bounded cross-heartbeat retry counter
    // (reuses Task.recoveryRetryCount) rather than terminally failing the task.
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", { recoveryRetryCount: 1 });
  });

  it("parks typed base-refresh refusals without consuming acquisition retries", async () => {
    /*
    FNXC:WorktreeBaseRefresh 2026-08-01-16:33:
    A stale checkout is a deliberate no-session outcome. It must retain the concrete reason for
    the next heartbeat rather than converting into the unrelated acquisition retry cap.
    */
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValueOnce(
      new worktreeAcquisition.WorktreeBaseRefreshError({
        kind: "base-reconciliation-required",
        executionSafe: false,
        durableBaseSha: "c0",
        baseSha: "c1",
      }),
    );
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(piModule.createFnAgent).not.toHaveBeenCalled();
    expect(taskStore.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ recoveryRetryCount: expect.anything() }));
    expect(taskStore.logEntry).toHaveBeenCalledWith(
      "FN-1",
      "Worktree base refresh blocked heartbeat execution (base-reconciliation-required)",
      expect.any(String),
    );
    // FNXC:MoveSource 2026-09-17-07:05: the rebound now declares moveSource explicitly (identical value
    // to the implicit default) — the ratchet keeps unattributed heartbeat moves at three.
    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-1", "todo", { preserveProgress: true, moveSource: "engine" });
  });

  /*
  FNXC:TaskBaseResolution 2026-09-16-03:20 (RUFU-245):
  A proven divergence between local `main` and its remote-tracking counterpart is an operator
  decision (push vs. pull), so unlike a stale checkout it must NOT wait for a later heartbeat, and
  unlike an ordinary acquisition failure it must not spend the three-strike budget or reach
  `onTaskAcquisitionExhausted` — filing a base-policy refusal as a broken-checkout flake is the
  re-dispatch wedge RUFU-231 removed. These assertions are the mirror image of the two tests around
  this one: terminal like the retry-cap case, budget-free like the refresh case.
  */
  it("parks a proven task-base divergence terminally without consuming acquisition retries", async () => {
    const diverged = new TaskBranchBaseDivergedError({
      localRef: "main",
      remoteRef: "origin/main",
      aheadCount: 2,
      behindCount: 3,
    });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValueOnce(diverged);
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo", onTaskAcquisitionExhausted });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(piModule.createFnAgent).not.toHaveBeenCalled();
    // The refusal sentence itself is the operator-visible reason, prefix included.
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("TASK_BASE_DIVERGED:"),
    }));
    // No retry budget: neither the increment nor the cap-exhaustion clear may appear.
    expect(taskStore.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ recoveryRetryCount: expect.anything() }));
    expect(onTaskAcquisitionExhausted).not.toHaveBeenCalled();
    // Terminal park survives the rebound move (FN-7721 preserveStatus semantics).
    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-1", "todo", { preserveProgress: true, preserveStatus: true });
    // The run record carries its own fixed reason, so the heartbeat lane is distinguishable from an
    // ordinary `worktree_acquisition_failed` (or the refresh hold) in run history.
    expect(store.saveRun).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      resultJson: expect.objectContaining({ reason: "task_base_diverged" }),
    }));
  });

  // FN-7721 regression: reproduces the reported "worktree-setup loop" symptom
  // (identical `git worktree add -b <branch>` failure repeated indefinitely
  // across heartbeat cycles, ~16.2h in the reported incident) and asserts the
  // loop is now bounded: after MAX_HEARTBEAT_WORKTREE_ACQUISITION_RETRIES (3)
  // consecutive cross-heartbeat acquisition failures for the same task, the
  // task is terminally marked failed instead of being requeued to "todo" again.
  it("terminally fails the task after the bounded cross-heartbeat worktree acquisition retry cap is hit (FN-7721)", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(
      new Error("fatal: a branch named 'fusion/fn-1' already exists"),
    );
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo", onTaskAcquisitionExhausted });

    // Simulate 3 independent heartbeat cycles, each reading back the
    // recoveryRetryCount persisted by the previous cycle (as a real TaskStore
    // would), reproducing the reported "identical failure against 4 different
    // directories" loop shape without an unbounded real-time wait.
    let recoveryRetryCount: number | null | undefined;
    taskStore.updateTask.mockImplementation((_id: string, patch: Record<string, unknown>) => {
      if ("recoveryRetryCount" in patch) recoveryRetryCount = patch.recoveryRetryCount as number | null;
      return Promise.resolve();
    });

    for (let cycle = 0; cycle < 3; cycle++) {
      taskStore.getTask.mockResolvedValue({
        id: "FN-1", title: "t", description: "d", column: "todo", dependencies: [], steps: [], log: [],
        recoveryRetryCount,
      });
      await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    }

    // Bounded: exactly 3 acquisition attempts occurred (cap == 3), not an
    // unbounded number of retries across heartbeat cycles.
    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalledTimes(3);
    // Terminal failure surfaced via the same `status: "failed"` convention the
    // executor uses, so it is a real, countable task failure rather than a
    // silent infinite todo-requeue loop.
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      status: "failed",
      recoveryRetryCount: null,
    }));
    expect(onTaskAcquisitionExhausted).toHaveBeenCalledTimes(1);
    expect(onTaskAcquisitionExhausted.mock.calls[0][0]).toBe("FN-1");

    // FN-7721 regression: `moveTask(..., "todo", ...)` reopen-to-todo semantics
    // clear task.status/error back to undefined unless `preserveStatus: true`
    // is passed (see store.ts's isReopenToTodoOrTriage clause). Without this,
    // the `status: "failed"` written just above is silently wiped, and the
    // task looks like an ordinary todo task that gets reassigned and retried
    // from scratch — defeating the terminal-failure intent of this fix.
    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-1", "todo", expect.objectContaining({ preserveStatus: true }));
  });
});

/*
FNXC:OverlapScheduling 2026-09-09-00:05 (RUFU-200):
The phantom re-arm guard. RUFU-198 sat in `todo` behind a paused, unparseable dependency: it could
never dispatch, yet every heartbeat patrol called `acquireTaskWorktree` for it, and the retained
checkout re-armed the dormant file-scope lease that blocked its overlapping peer — the deadlock
outlived every sweep that cleared it. These tests pin BOTH halves: the skip for the shape that
generates the phantom, and today's acquisition for every shape that legitimately owns a checkout
(satisfied backlog, WIP, review, and a renamed hold board).
*/
describe("heartbeat skips worktree acquisition for a dependency-blocked planning-lane card", () => {
  let store: any;
  let taskStore: any;
  const agent: Agent = { id: "a1", name: "A", role: "executor", state: "active", taskId: "FN-1", createdAt: "", updatedAt: "", metadata: {} } as any;
  const run: AgentHeartbeatRun = { id: "r1", agentId: "a1", status: "active", startedAt: new Date().toISOString(), endedAt: null } as any;

  function boundTask(overrides: Record<string, unknown> = {}) {
    return {
      id: "FN-1", title: "t", description: "d", column: "todo",
      dependencies: ["FN-DEP"], steps: [], log: [],
      worktree: "/tmp/existing-wt", branch: "fusion/fn-1",
      ...overrides,
    };
  }

  function depTask(column: string) {
    return { id: "FN-DEP", title: "dep", description: "", column, dependencies: [], steps: [], log: [] };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(piModule, "createFnAgent").mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({ worktreePath: "/tmp/wt", branch: "fusion/fn-1", source: "existing", hydrated: false, isResume: true });
    store = {
      startHeartbeatRun: vi.fn().mockResolvedValue(run),
      saveRun: vi.fn(),
      getRunDetail: vi.fn().mockResolvedValue(run),
      getAgent: vi.fn().mockResolvedValue(agent),
      updateAgentState: vi.fn(),
      updateAgent: vi.fn(),
      endHeartbeatRun: vi.fn(),
      assignTask: vi.fn(),
      getBudgetStatus: vi.fn().mockResolvedValue({ isOverBudget: false, isOverThreshold: false, usagePercent: 0 }),
      getCachedAgent: vi.fn().mockReturnValue(null),
      getLastBlockedState: vi.fn().mockResolvedValue(null),
      setLastBlockedState: vi.fn(),
      clearLastBlockedState: vi.fn(),
      appendRunLog: vi.fn(),
      getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
      recordHeartbeat: vi.fn(),
    };
    taskStore = {
      getSettings: vi.fn().mockResolvedValue({}),
      getTask: vi.fn().mockResolvedValue(boundTask()),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      appendAgentLog: vi.fn(),
      // The dependency exists and is NOT satisfied, so this card genuinely cannot dispatch.
      listTasks: vi.fn().mockResolvedValue([depTask("in-progress")]),
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips acquisition and runs the patrol from the project root", async () => {
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    // RED before RUFU-200: every patrol used to re-arm the holder here.
    expect(worktreeAcquisition.acquireTaskWorktree).not.toHaveBeenCalled();
    expect(piModule.createFnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
    // The guard is read-only: it must not pretend to have cleared the holder's metadata.
    expect(taskStore.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ worktree: null }));
    expect(taskStore.moveTask).not.toHaveBeenCalled();
  });

  it("keeps acquiring once the dependency is satisfied", async () => {
    taskStore.listTasks.mockResolvedValue([depTask("done")]);
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalledTimes(1);
    expect(piModule.createFnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/wt" }));
  });

  it("keeps acquiring for a WIP-lane card even with unmet dependencies", async () => {
    /* A card that already entered execution owns its checkout regardless of its dependency edges —
       skipping there would strand live work, so today's answer stays today's answer. */
    taskStore.getTask.mockResolvedValue(boundTask({ column: "in-progress" }));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalledTimes(1);
  });

  it("keeps acquiring for a review-lane card even with unmet dependencies", async () => {
    /* The merged-but-still-blocked case: a human-owned merge keeps its checkout. */
    taskStore.getTask.mockResolvedValue(boundTask({ column: "in-review" }));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalledTimes(1);
  });

  it("applies on a renamed hold board via the resolved lifecycle lane", async () => {
    /* The guard reads the task's OWN workflow vocabulary, so a renamed hold column is still the
       planning lane; a literal-only reading would acquire here and re-arm the phantom. */
    const renamedIr = {
      version: "v2",
      id: "custom:wf",
      nodes: [],
      edges: [],
      columns: [
        { id: "inbox", name: "inbox", traits: [{ trait: "intake" }] },
        { id: "drafting", name: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "reviewing", name: "reviewing", traits: [{ trait: "review" }] },
        { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
      ],
    } as any;
    const selection = { workflowId: "custom:wf", stepIds: [] };
    taskStore.getTask.mockResolvedValue(boundTask({ column: "drafting" }));
    taskStore.getTaskWorkflowSelection = vi.fn(() => selection);
    taskStore.getTaskWorkflowSelectionAsync = vi.fn(async () => selection);
    taskStore.getWorkflowDefinition = vi.fn(async () => ({ ir: renamedIr }));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(worktreeAcquisition.acquireTaskWorktree).not.toHaveBeenCalled();
    expect(piModule.createFnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
  });

  /*
  FNXC:OverlapScheduling 2026-09-09-05:31 (RUFU-200, CEO ruling 2026-09-08T19:30Z):
  The deps=[] variant of the same self-rearming shape. A planning-lane card with NO dependency
  edges can still be the blocked party: the dispatch gate stamps `task.overlapBlockedBy` when the
  card's own retained checkout is the dormant lease refusing an overlapping peer, and that card is
  itself held from dispatch by the overlap episode. `getUnmetSchedulingDependencies` returns [] for
  it — the block lives on the row, not on an edge — so only the explicit overlap signal keeps the
  patrol from handing it a checkout and re-arming the lease the sweep just cleared.
  Done-gate symptom surface: deps=[] + overlapBlockedBy set ⇒ no acquire.
  */
  it("skips acquisition for a deps-free card whose own overlap lease blocks a peer", async () => {
    taskStore.getTask.mockResolvedValue(boundTask({ dependencies: [], overlapBlockedBy: "FN-PEER" }));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    // RED before the CEO ruling's OR-branch: the early `dependencies.length === 0` return let this
    // card acquire on every patrol, re-establishing `task.worktree` and therefore the dormant lease.
    expect(worktreeAcquisition.acquireTaskWorktree).not.toHaveBeenCalled();
    expect(piModule.createFnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
    // Read-only guard: it must not clear the overlap signal or move the card.
    expect(taskStore.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ overlapBlockedBy: null }));
    expect(taskStore.moveTask).not.toHaveBeenCalled();
  });

  it("keeps acquiring for a deps-free backlog card with no overlap block", async () => {
    /* Non-vacuity control for the new branch: with neither unmet deps nor `overlapBlockedBy`, a
       planning-lane card may legitimately dispatch on the next pass, so today's acquisition stays. */
    taskStore.getTask.mockResolvedValue(boundTask({ dependencies: [] }));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalledTimes(1);
    expect(piModule.createFnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/wt" }));
  });

  it("keeps acquiring for a WIP card whose overlap lease blocks a peer", async () => {
    /* The lane check still bounds the new signal: a card that already entered execution owns its
       checkout, so an overlap stamp must not strand live work. */
    taskStore.getTask.mockResolvedValue(boundTask({ column: "in-progress", dependencies: [], overlapBlockedBy: "FN-PEER" }));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:OverlapAcquisitionPark 2026-11-04-00:40 (RUFU-373):
The delivered-file-evidence wedge class. SANE-436 (project saneca, 2026-09-27) and ROZV-197
(7 856 / 7 855 todo<->in-progress bounces, 6 939 occurrences of one sentence across 23 578 activity
rows) are the same defect: a pending file-scope episode whose predecessor has not LANDED yet is a
deterministic WAIT, but the acquisition path refused it as an ordinary broken checkout, so every
heartbeat burned one of three strikes, the cap composed a message no recovery matcher recognises,
and the card kept a worktree registration whose dormant file-scope lease can block the very
predecessor it waits for (the RUFU-200 re-arm shape).
*/
describe("heartbeat worktree acquisition refused by overlap synchronization", () => {
  let store: any;
  let taskStore: any;
  const agent: Agent = { id: "a1", name: "A", role: "executor", state: "active", taskId: "FN-1", createdAt: "", updatedAt: "", metadata: {} } as any;
  const run: AgentHeartbeatRun = { id: "r1", agentId: "a1", status: "active", startedAt: new Date().toISOString(), endedAt: null } as any;
  const CHECKOUT = "task-checkout/fn-1";

  /** The card as it reads AFTER acquisition persisted its assignment: a live registration. */
  function parkedTask(overrides: Record<string, unknown> = {}) {
    return {
      id: "FN-1", title: "t", description: "d", column: "todo", dependencies: [], steps: [], log: [],
      worktree: CHECKOUT, branch: "fusion/fn-1",
      ...overrides,
    };
  }

  function auditRows(): any[] {
    return taskStore.recordRunAuditEvent.mock.calls
      .map((call: any[]) => call[0])
      .filter((entry: any) => entry.mutationType === "task:overlap-acquisition-parked");
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetOverlapAcquisitionParkDedup();
    vi.spyOn(piModule, "createFnAgent").mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(
      new OverlapResumeSynchronizationError("delivery-unavailable", OVERLAP_DELIVERY_UNAVAILABLE_ERROR, {
        episodeIds: ["ep-1"], blockerTaskIds: ["FN-A"], repositories: ["repo-a"], missingEvidence: "delivery-evidence-unavailable",
      }),
    );
    store = {
      startHeartbeatRun: vi.fn().mockResolvedValue(run),
      saveRun: vi.fn(),
      getRunDetail: vi.fn().mockResolvedValue(run),
      getAgent: vi.fn().mockResolvedValue(agent),
      updateAgentState: vi.fn(),
      updateAgent: vi.fn(),
      endHeartbeatRun: vi.fn(),
      assignTask: vi.fn(),
      getBudgetStatus: vi.fn().mockResolvedValue({ isOverBudget: false, isOverThreshold: false, usagePercent: 0 }),
      getCachedAgent: vi.fn().mockReturnValue(null),
      getLastBlockedState: vi.fn().mockResolvedValue(null),
      setLastBlockedState: vi.fn(),
      clearLastBlockedState: vi.fn(),
      appendRunLog: vi.fn(),
      getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
      recordHeartbeat: vi.fn(),
    };
    taskStore = {
      getSettings: vi.fn().mockResolvedValue({}),
      getTask: vi.fn().mockResolvedValue(parkedTask()),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      appendAgentLog: vi.fn(),
      listTasks: vi.fn().mockResolvedValue([]),
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
      recordRunAuditEvent: vi.fn(async () => undefined),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parks the typed refusal once, names the missing artifact, and releases the leaked registration", async () => {
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "repo-root", onTaskAcquisitionExhausted });
    const remove = vi.spyOn(worktreeBackend, "removeWorktree").mockResolvedValue({
      removed: true, classification: "removed",
    } as any);

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(piModule.createFnAgent).not.toHaveBeenCalled();
    // No strike: a deterministic wait must never touch the broken-checkout budget, neither on entry
    // nor through the cap-exhaustion clear.
    expect(taskStore.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ recoveryRetryCount: expect.anything() }));
    expect(onTaskAcquisitionExhausted).not.toHaveBeenCalled();
    // The bare recoverable sentence is the whole operator-visible reason, so the core matcher and the
    // released-overlap-waits sweep can both resume this card.
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      status: "failed",
      error: OVERLAP_DELIVERY_UNAVAILABLE_ERROR,
    }));
    // The terminal park survives the rebound move (FN-7721 preserveStatus semantics).
    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-1", "todo", { preserveProgress: true, preserveStatus: true });
    // The registration that used to survive the failure is released through the defensive path and its
    // pointers cleared, so the dormant file-scope lease cannot re-arm (RUFU-200).
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: CHECKOUT,
      taskId: "FN-1",
      reason: "acquisition-refused",
    }));
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({ worktree: null, branch: null }));
    // One audit row names WHICH artifact is missing — ids/counts/fixed enums only.
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({
      taskId: "FN-1",
      reason: "delivery-unavailable",
      missingEvidence: "delivery-evidence-unavailable",
      blockerTaskIds: ["FN-A"],
      repositories: ["repo-a"],
      strikeBudgetConsumed: 0,
      registrationRelease: "removed",
    });
    // The task-history line names the predecessor whose delivery is missing.
    expect(taskStore.logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("FN-A"), expect.any(String));
  });

  it("never burns the strike budget or writes the composed exhaustion message for the typed refusal", async () => {
    /*
     * The permanent negative proof. ROZV-197 is exactly this loop: 7 856 bounces produced by charging
     * a deterministic wait against a budget meant for a broken checkout. Three heartbeats with the
     * counter read back the way a real TaskStore persists it must never reach the cap, because the
     * cap's composed sentence is what made the wedge invisible to every recovery sweep
     * (`isRecoverableOverlapWaitFailure` matches the bare sentence only).
     */
    let recoveryRetryCount: number | null | undefined;
    taskStore.updateTask.mockImplementation((_id: string, patch: Record<string, unknown>) => {
      if ("recoveryRetryCount" in patch) recoveryRetryCount = patch.recoveryRetryCount as number | null;
      return Promise.resolve();
    });
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "repo-root" });

    for (let cycle = 0; cycle < 3; cycle++) {
      taskStore.getTask.mockResolvedValue(parkedTask({ recoveryRetryCount }));
      await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    }

    expect(recoveryRetryCount).toBeUndefined();
    const writtenErrors = taskStore.updateTask.mock.calls
      .map((call: any[]) => (call[1] as Record<string, unknown>)?.error)
      .filter((value: unknown): value is string => typeof value === "string");
    expect(writtenErrors.length).toBeGreaterThan(0);
    for (const error of writtenErrors) expect(error).not.toMatch(/heartbeat attempts for branch/);
    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalledTimes(3);
  });

  it("keeps the pointer and the checkout when content preservation refuses the release", async () => {
    vi.spyOn(worktreeBackend, "removeWorktree").mockRejectedValue(
      new worktreeBackend.WorktreeContentPreservationError(CHECKOUT),
    );
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "repo-root" });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      status: "failed",
      error: OVERLAP_DELIVERY_UNAVAILABLE_ERROR,
    }));
    // No pointer clear over a preserved checkout — that is how an orphan is created.
    expect(taskStore.updateTask).not.toHaveBeenCalledWith("FN-1", expect.objectContaining({ worktree: null }));
    expect(auditRows()[0]?.metadata).toMatchObject({ registrationRelease: "preserved" });
  });

  it("emits one audit row per (task, episodes, reason) episode rather than one per heartbeat", async () => {
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "repo-root" });
    for (let cycle = 0; cycle < 3; cycle++) await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(auditRows()).toHaveLength(1);
  });

  it("still burns strikes for an ordinary broken checkout (non-typed acquisition failure keeps the cap)", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error("fatal: not a git repository"));
    let recoveryRetryCount: number | null | undefined;
    taskStore.updateTask.mockImplementation((_id: string, patch: Record<string, unknown>) => {
      if ("recoveryRetryCount" in patch) recoveryRetryCount = patch.recoveryRetryCount as number | null;
      return Promise.resolve();
    });
    const onTaskAcquisitionExhausted = vi.fn();
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "repo-root", onTaskAcquisitionExhausted });

    for (let cycle = 0; cycle < 3; cycle++) {
      taskStore.getTask.mockResolvedValue(parkedTask({ recoveryRetryCount }));
      await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    }

    expect(onTaskAcquisitionExhausted).toHaveBeenCalledTimes(1);
    expect(taskStore.updateTask).toHaveBeenCalledWith("FN-1", expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("Worktree acquisition failed after 3 heartbeat attempts"),
    }));
    expect(auditRows()).toHaveLength(0);
  });
});
