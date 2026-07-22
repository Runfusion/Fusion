import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentHeartbeatRun } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";
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

  it("uses acquired worktree cwd for task-scoped runs", async () => {
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    expect(worktreeAcquisition.acquireTaskWorktree).toHaveBeenCalled();
    expect(piModule.createFnAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/wt" }));
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
