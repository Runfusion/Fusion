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

FNXC:OverlapWaitSynchronization 2026-10-09-16:12 (RUFU-330):
That up-front claim -> complete shape is no longer the contract, and the file above proves it: the
heartbeat reads no overlap-wait list any more (`resolvePendingOverlapWaits` is not called from
agent-heartbeat.ts), so every assertion written against it can only ever see zero calls.
MergeRebuild0919 (FNXC:MergeRebuild0919 2026-09-19-21:45 in agent-heartbeat.ts) deliberately dropped
the inline resolver in favour of the acquisition-owned delivery: `acquireTaskWorktree` returns
`overlapResumeDelivery`, the briefing is appended from THAT object, and the episodes are
acknowledged only after the transport actually sent it (`dispatchHeartbeatTransportWithOverlapAck`
-> `acknowledgeOverlapResumeContext`). The drop is load-bearing, not incidental: running both
resolvers would append the briefing twice and claim the same episodes from two owners.
So these cases drive the live seam instead of the deleted one, and the single-owner decision is now
pinned rather than assumed — the heartbeat must never claim an episode itself. The
ack-after-success / retry / next-generation behaviour stays owned by
__tests__/agent-heartbeat-worktree.test.ts; what is pinned here is the framing half (what lands in
the prompt) and the two refusals that file does not express: no delivery means no store traffic at
all, and a store without the completion method must not break the run.
*/
describe("heartbeat overlap-wait resolution", () => {
  let store: any;
  let taskStore: any;
  const agent: Agent = { id: "a1", name: "A", role: "executor", state: "active", taskId: "FN-1", createdAt: "", updatedAt: "", metadata: {} } as any;

  /** A ready episode exactly as the acquisition seam hands one over: owned, receipted, revisioned. */
  function deliveredEpisode(episodeId: string, blockerTaskId: string, revision: number) {
    return {
      phase: "ready" as const,
      episodeId,
      revision,
      owner: "acquisition:FN-1",
      receipt: {
        decision: "briefing",
        freshness: "proven",
        commonFiles: ["src/shared.ts"],
        deliveryProofs: [],
        decisionFingerprint: `${episodeId}-generation`,
        briefing: `OVERLAP_WAIT_SYNCHRONIZATION:\n${blockerTaskId} delivered src/shared.ts`,
        decidedAt: "2026-09-01T00:00:00.000Z",
      },
    };
  }

  /** Install an acquisition whose delivery carries `context` + `episodes` (the production shape). */
  function acquireWithDelivery(delivery: { context: string; episodes: unknown[] } | undefined) {
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockResolvedValue({
      worktreePath: "/tmp/wt",
      branch: "fusion/fn-1",
      source: "existing",
      hydrated: false,
      isResume: true,
      ...(delivery ? { overlapResumeDelivery: delivery } : {}),
    } as any);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(piModule, "createFnAgent").mockResolvedValue({ session: { prompt: vi.fn(), dispose: vi.fn() } } as any);
    acquireWithDelivery(undefined);

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
      // The heartbeat lane is a consumer of an already-claimed episode, never a claimant. The seam
      // may still be reachable on the store, so a claim call here would be a real second owner.
      claimTaskOverlapWait: vi.fn(async () => {
        throw new Error("heartbeat must not claim overlap-wait episodes; the acquisition seam owns the claim");
      }),
      completeTaskOverlapWait: vi.fn(async (input: any) => ({ ...input, phase: "delivered" })),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the acquisition-owned briefing into the prompt and acknowledges the episode after sending", async () => {
    const episode = deliveredEpisode("episode-1", "FN-A", 4);
    acquireWithDelivery({ context: episode.receipt.briefing, episodes: [episode] });

    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(taskStore.claimTaskOverlapWait).not.toHaveBeenCalled();
    const created = await vi.mocked(piModule.createFnAgent).mock.results[0]!.value;
    expect(created.session.prompt).toHaveBeenCalledWith(expect.stringContaining("## Overlap wait synchronization"));
    expect(created.session.prompt).toHaveBeenCalledWith(expect.stringContaining("FN-A delivered src/shared.ts"));
    // The acknowledgement is the acquisition's claim, not one the heartbeat invented: owner and
    // revision are carried through so a superseded episode cannot be completed under this run.
    expect(taskStore.completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "FN-1",
      episodeId: "episode-1",
      expectedRevision: 4,
      owner: "acquisition:FN-1",
      phase: "delivered",
    }));
    expect(taskStore.completeTaskOverlapWait.mock.invocationCallOrder[0]).toBeGreaterThan(
      created.session.prompt.mock.invocationCallOrder[0],
    );
  });

  it("does not touch the prompt or the store when the task has no pending overlap waits", async () => {
    acquireWithDelivery(undefined);

    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" });

    expect(taskStore.claimTaskOverlapWait).not.toHaveBeenCalled();
    expect(taskStore.completeTaskOverlapWait).not.toHaveBeenCalled();
    const created = await vi.mocked(piModule.createFnAgent).mock.results[0]!.value;
    expect(created.session.prompt).not.toHaveBeenCalledWith(expect.stringContaining("Overlap wait synchronization"));
  });

  it("tolerates a store without overlap-wait methods (older test doubles / stores)", async () => {
    const episode = deliveredEpisode("episode-legacy", "FN-A", 2);
    acquireWithDelivery({ context: episode.receipt.briefing, episodes: [episode] });
    delete taskStore.completeTaskOverlapWait;

    const monitor = new HeartbeatMonitor({ store, taskStore, rootDir: "/repo" });
    await expect(monitor.executeHeartbeat({ agentId: "a1", source: "on_demand" })).resolves.toBeDefined();

    // The briefing is still carried (the delivery is in hand); only the acknowledgement is skipped,
    // so an episode simply stays retryable rather than the run dying on a missing store method.
    const created = await vi.mocked(piModule.createFnAgent).mock.results[0]!.value;
    expect(created.session.prompt).toHaveBeenCalledWith(expect.stringContaining("## Overlap wait synchronization"));
  });
});
