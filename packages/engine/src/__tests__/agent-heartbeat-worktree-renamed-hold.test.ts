/*
FNXC:WorkflowLifecycleColumns 2026-07-28-09:10 (U11 conversion — engine recovery core):

When worktree acquisition fails, the heartbeat requeues the card to the BACKLOG so
another cycle can retry it. Both requeue sites hardcoded `"todo"`, so for a
workflow whose hold column is named anything else the card was shoved into a
column that workflow does not declare.

This is the rebound-target shape already converted in mesh-lease-manager and
`recoverStrandedCompletedTodoTasks`: the target is the KTD-10 ordering
`resolveReboundTarget` (hold -> intake -> first column), not the literal `todo`.

It matters more than usual here because U11 DELETES the `todo` column from the
builtin workflows. After that these two sites would requeue every
acquisition-failed card into a column that no longer exists.

Both sites are covered, because they are different branches of the same failure:
the bounded-retry requeue and the retry-cap-exhausted terminal park. Converting
one and not the other would leave the rarer path — the one that fires only after
three consecutive failures — still writing the literal.

Written against the literal implementation and observed FAILING first.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentHeartbeatRun, WorkflowIr } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import * as worktreeAcquisition from "../worktree-acquisition.js";
import * as piModule from "../pi.js";

const WF = "custom:wf";

/** A workflow whose hold column is `drafting` — it declares NO `todo` column. */
function renamedIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", name: "inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", name: "drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

describe("heartbeat worktree-acquisition requeue under a renamed hold column", () => {
  let store: any;
  let taskStore: any;
  const agent: Agent = {
    id: "a1", name: "A", role: "executor", state: "active", taskId: "FN-1",
    createdAt: "", updatedAt: "", metadata: {},
  } as any;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(piModule, "createFnAgent").mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);

    const run: AgentHeartbeatRun = {
      id: "r1", agentId: "a1", status: "active", startedAt: new Date().toISOString(), endedAt: null,
    } as any;
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
    const selection = { workflowId: WF, stepIds: [] };
    taskStore = {
      getSettings: vi.fn().mockResolvedValue({}),
      getTask: vi.fn().mockResolvedValue({
        id: "FN-1", title: "t", description: "d", column: "drafting", dependencies: [], steps: [], log: [],
      }),
      moveTask: vi.fn(),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      appendAgentLog: vi.fn(),
      listTasks: vi.fn().mockResolvedValue([]),
      selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
      getTaskWorkflowSelection: vi.fn(() => selection),
      getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
      getWorkflowDefinition: vi.fn(async () => ({ ir: renamedIr() })),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requeues to the workflow's HOLD column, not the literal todo", async () => {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValueOnce(new Error("nope"));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-1", "drafting", { preserveProgress: true });
    expect(taskStore.moveTask).not.toHaveBeenCalledWith("FN-1", "todo", expect.anything());
  });

  it("parks to the HOLD column on the retry-cap-exhausted path too", async () => {
    /*
    The rarer branch, which only fires after three consecutive failures. It keeps
    `preserveStatus: true` so the `status: "failed"` written just before is not
    wiped by reopen-to-todo semantics (FN-7721) — converting the column must not
    disturb that flag.
    */
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error("branch exists"));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });

    let recoveryRetryCount: number | null | undefined;
    taskStore.updateTask.mockImplementation((_id: string, patch: Record<string, unknown>) => {
      if ("recoveryRetryCount" in patch) recoveryRetryCount = patch.recoveryRetryCount as number | null;
      return Promise.resolve();
    });

    for (let cycle = 0; cycle < 3; cycle++) {
      taskStore.getTask.mockResolvedValue({
        id: "FN-1", title: "t", description: "d", column: "drafting",
        dependencies: [], steps: [], log: [], recoveryRetryCount,
      });
      await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });
    }

    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-1", "drafting", {
      preserveProgress: true,
      preserveStatus: true,
    });
    expect(taskStore.moveTask).not.toHaveBeenCalledWith("FN-1", "todo", expect.anything());
  });

  it("still requeues to todo when the workflow cannot be resolved (regression floor)", async () => {
    /* Conservative fallback: an unresolvable workflow must behave exactly as it
       did before this conversion rather than guessing a column. */
    taskStore.getWorkflowDefinition = vi.fn(async () => null);
    taskStore.getTask.mockResolvedValue({
      id: "FN-1", title: "t", description: "d", column: "todo", dependencies: [], steps: [], log: [],
    });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValueOnce(new Error("nope"));
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });

    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(taskStore.moveTask).toHaveBeenCalledWith("FN-1", "todo", { preserveProgress: true });
  });
});
