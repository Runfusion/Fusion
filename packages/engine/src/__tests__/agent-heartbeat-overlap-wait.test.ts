import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, AgentHeartbeatRun } from "@fusion/core";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import * as worktreeAcquisition from "../worktree/worktree-acquisition.js";
import * as piModule from "../pi.js";

/*
FNXC:OverlapWaitSynchronization 2026-09-18-01:50:
Reimplemented for FN-332's heartbeat-side wiring: a heartbeat-driven implementation session is
another resume path, so it must resolve pending overlap-wait episodes the same way
executor/execute-workflow-graph.ts does before its own graph nodes run — see
resolvePendingOverlapWaits call in agent-heartbeat.ts. Unlike the excluded original's split claim
-> send -> acknowledge flow (execution/overlap-resume-context.ts, out of this reimplementation's
scope), this integration resolves and completes each episode up front and only carries the
resulting briefing text into the prompt, so there is nothing left to acknowledge after send.
*/
describe("heartbeat overlap-wait resolution", () => {
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

  it("appends a resolved briefing to the execution prompt and completes the episode", async () => {
    const episode = {
      projectId: "p", taskId: "FN-1", episodeId: "episode-1", blockerTaskId: "FN-A",
      observedAt: "2026-09-01T00:00:00.000Z", phase: "observed" as const, revision: 1, attempt: 0,
      observation: { deliveries: [{ blockerTaskId: "FN-A", repository: ".", landedSha: "sha-1", evidence: "merge-details" as const, paths: [{ repository: ".", path: "src/shared.ts", status: "modified" as const }] }] },
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    taskStore.listTaskOverlapWaits = vi.fn(async () => [episode]);
    taskStore.claimTaskOverlapWait = vi.fn(async () => ({ ...episode, phase: "analyzing", revision: 2 }));
    taskStore.completeTaskOverlapWait = vi.fn(async (input: any) => ({ ...episode, ...input, phase: "delivered" }));

    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(taskStore.claimTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ taskId: "FN-1", episodeId: "episode-1", owner: "heartbeat:a1" }));
    expect(taskStore.completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ taskId: "FN-1", episodeId: "episode-1", phase: "delivered" }));
    expect(piModule.createFnAgent).toHaveBeenCalled();
    const created = await vi.mocked(piModule.createFnAgent).mock.results[0]!.value;
    expect(created.session.prompt).toHaveBeenCalledWith(expect.stringContaining("## Overlap wait synchronization"));
    expect(created.session.prompt).toHaveBeenCalledWith(expect.stringContaining("FN-A delivered src/shared.ts"));
  });

  it("does not touch the prompt or the store when the task has no pending overlap waits", async () => {
    taskStore.listTaskOverlapWaits = vi.fn(async () => []);
    taskStore.claimTaskOverlapWait = vi.fn();
    taskStore.completeTaskOverlapWait = vi.fn();

    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(taskStore.claimTaskOverlapWait).not.toHaveBeenCalled();
    const created = await vi.mocked(piModule.createFnAgent).mock.results[0]!.value;
    expect(created.session.prompt).not.toHaveBeenCalledWith(expect.stringContaining("Overlap wait synchronization"));
  });

  it("tolerates a store without overlap-wait methods (older test doubles / stores)", async () => {
    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await expect(monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" })).resolves.toBeDefined();
  });
});
