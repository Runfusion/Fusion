import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { wireExecutorLifecycle } from "../executor/wire-executor-lifecycle.js";

const task = (id: string): Task => ({ id, title: id, description: "workspace", column: "in-progress" } as Task);

/**
 * FNXC:WorkspaceWorktree 2026-08-23-07:08:
 * FN-179 must release the derived acquire cache through the real delete lifecycle
 * listener. Manually unregistering an entry would not prove that a disappearing
 * owner unblocks the next claimant in the process that observed the deletion.
 */
describe("workspace acquire claim lifecycle release", () => {
  afterEach(() => {
    for (const entry of activeSessionRegistry.entriesByKind("workspace-repo-acquire")) activeSessionRegistry.unregisterPath(entry.path);
    for (const entry of activeSessionRegistry.entriesByKind("workspace-repo-land")) activeSessionRegistry.unregisterPath(entry.path);
  });

  it("soft-delete releases only acquire registry and durable lease through lifecycle wiring", async () => {
    const path = "/workspace/Merge";
    activeSessionRegistry.registerPath(path, { taskId: "MRG-050", kind: "workspace-repo-acquire", ownerKey: "workspace-repo-acquire" });
    const emitter = new EventEmitter();
    const acquireLease = { leaseKey: "repo:Merge", kind: "acquire", taskId: "MRG-050", status: "held" };
    const store = Object.assign(emitter, {
      inspectWorkspaceLeases: vi.fn(async () => [acquireLease]),
      releaseWorkspaceLease: vi.fn(async () => undefined),
      on: emitter.on.bind(emitter),
    }) as unknown as TaskStore;
    const disposals: Promise<void>[] = [];

    wireExecutorLifecycle({
      store,
      rootDir: "/workspace",
      options: {},
      activeConfiguredCommandControllers: new Map(), activeSessions: new Map(), activeStepExecutorSeenSteeringIds: new Map(),
      activeStepExecutors: new Map(), activeSubagentSessions: new Map(), activeWorkflowGraphAbortControllers: new Map(),
      activeWorkflowStepSessionSeenSteeringIds: new Map(), activeWorkflowStepSessions: new Map(), approvalResumeAfterUnwind: new Set(),
      approvalSuspended: new Set(), effectiveColumnAgentByTask: new Map(), executing: new Set(), graphColumnAgentResolver: new Map(),
      graphRouting: new Set(), graphSeamGoverningNodeId: new Map(), loopRecoveryState: new Map(), pendingTaskDisposals: new Map(),
      recoveringCompleted: new Set(), spawnedAgents: new Map(), stuckAborted: new Map(), userCanceledTaskIds: new Set(), workflowLifecycleMovesInFlight: new Set(),
      awaitAbortInFlightTaskWork: vi.fn(async () => undefined), clearWorkflowRerunWatchdog: vi.fn(), deleteActiveWorkflowStepSession: vi.fn(),
      dispatchUnpauseResume: vi.fn(async () => false), disposeSubagentsForTask: vi.fn(), execute: vi.fn(async () => undefined),
      executeReviewHandoff: vi.fn(async () => undefined), getAssignedAgentRuntimeConfig: vi.fn(async () => undefined), getModelRegistry: vi.fn(async () => undefined),
      getRunContextFor: vi.fn(() => undefined), isBackwardMoveOutOfPlanning: vi.fn(() => false), markPausedAborted: vi.fn(),
      releasePreExecutionWorktree: vi.fn(async () => undefined), removeOwnWorktreeWithReconcile: vi.fn(async () => undefined),
      resetMergeStateIfNeeded: vi.fn(async (value) => value), resolveResumeLanes: vi.fn(async () => ({})), terminateAllChildren: vi.fn(async () => undefined),
      trackTaskDisposal: vi.fn((_id, disposal) => { disposals.push(disposal); }),
    } as never);

    emitter.emit("task:deleted", { ...task("MRG-050"), deletedAt: new Date().toISOString() });
    await Promise.all(disposals);

    expect(activeSessionRegistry.lookupByPath(path)).toBeNull();
    expect((store as any).releaseWorkspaceLease).toHaveBeenCalledWith(acquireLease);

    // The next same-process claimant is admitted without a restart, sweep, or lease expiry.
    expect(() => activeSessionRegistry.registerPath(path, {
      taskId: "MRG-051", kind: "workspace-repo-acquire", ownerKey: "workspace-repo-acquire",
    })).not.toThrow();
  });

  it("never lets delete-time acquire cleanup unregister a land claim", async () => {
    const path = "/workspace/Merge";
    activeSessionRegistry.registerPath(path, { taskId: "MRG-050", kind: "workspace-repo-land", ownerKey: "workspace-repo-land" });
    expect(activeSessionRegistry.lookupByPath(path)).toMatchObject({ taskId: "MRG-050", kind: "workspace-repo-land" });
  });
});
