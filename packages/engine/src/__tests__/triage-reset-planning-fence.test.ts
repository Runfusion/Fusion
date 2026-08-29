import { describe, expect, it, vi } from "vitest";
import { disposeTaskBeforeReset, type Task, type TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { PLANNING_RESET_HOLD_MS, PlanningResetFence } from "../planning-reset-fence.js";
import { TriageProcessor } from "../triage.js";

/*
FNXC:TaskReset 2026-08-22-18:10:
The planner fence is deliberately synchronous: Reset must cancel a planner that may be waiting for
its non-reentrant lifecycle lock without awaiting that planner's settlement.
*/
describe("Triage planning reset fence", () => {
  it("invalidates a captured attempt and holds new admission until publication clears it", () => {
    let now = 1_000;
    const fence = new PlanningResetFence(() => now);
    const generation = fence.currentGeneration("FN-151");

    fence.cancelPlanning("FN-151");

    expect(fence.isStale("FN-151", generation)).toBe(true);
    expect(fence.isResetHoldActive("FN-151")).toBe(true);
    now += PLANNING_RESET_HOLD_MS + 1;
    expect(fence.isResetHoldActive("FN-151")).toBe(false);
    fence.clearHold("FN-151");
    expect(fence.isResetHoldActive("FN-151")).toBe(false);
  });

  it("does not republish a recovered worktree artifact queued behind Reset", async () => {
    const task = {
      id: "FN-151-QUEUED-ARTIFACT",
      description: "reset planner",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    let releaseReset!: () => void;
    let enteredQueue!: () => void;
    const resetPublication = new Promise<void>((resolve) => { releaseReset = resolve; });
    const entered = new Promise<void>((resolve) => { enteredQueue = resolve; });
    const updateTaskUnlocked = vi.fn();
    const store = {
      on: vi.fn(),
      off: vi.fn(),
      withPlanningLifecycleLock: vi.fn(async (_id: string, work: () => Promise<void>) => {
        enteredQueue();
        await resetPublication;
        await work();
      }),
      withTaskLock: vi.fn(async (_id: string, work: () => Promise<unknown>) => await work()),
      updateTaskUnlocked,
      isBackendMode: vi.fn(() => false),
    } as unknown as TaskStore;
    const processor = new TriageProcessor(store, "/tmp/fn-151-root");
    const generation = (processor as unknown as { resetFence: PlanningResetFence }).resetFence.currentGeneration(task.id);

    try {
      const publish = (processor as unknown as {
        persistResetFencedPlanningArtifact: (task: Task, generation: number, content: string, mirror: boolean) => Promise<boolean>;
      }).persistResetFencedPlanningArtifact(task, generation, "# Discarded plan", false);
      await entered;
      await disposeTaskBeforeReset(store, task);
      releaseReset();

      await expect(publish).resolves.toBe(false);
      expect(updateTaskUnlocked).not.toHaveBeenCalled();
    } finally {
      processor.stop();
    }
  });

  it("fences a live TriageProcessor session without awaiting its lifecycle-lock finalize", async () => {
    const task = {
      id: "FN-151-RESET-FENCE",
      description: "reset planner",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    const worktree = "/tmp/fn-151-reset-fence";
    const neverSettles = new Promise<never>(() => undefined);
    const store = {
      on: vi.fn(),
      off: vi.fn(),
      withPlanningLifecycleLock: vi.fn(() => neverSettles),
    } as unknown as TaskStore;
    const processor = new TriageProcessor(store, "/tmp/fn-151-root");
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn(() => { throw new Error("synthetic dispose failure"); });
    (processor as unknown as { activeSessions: Map<string, unknown> }).activeSessions.set(task.id, { abort, dispose });
    activeSessionRegistry.registerPath(worktree, { taskId: task.id, kind: "planning", ownerKey: `planning:${task.id}` });
    activeSessionRegistry.registerPath(`${worktree}-executor`, { taskId: task.id, kind: "executor", ownerKey: task.id });
    activeSessionRegistry.registerPath(`${worktree}-foreign`, { taskId: "FN-OTHER", kind: "planning", ownerKey: "planning:FN-OTHER" });

    try {
      await expect(disposeTaskBeforeReset(store, task)).resolves.toBeUndefined();
      expect(abort).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(store.withPlanningLifecycleLock).not.toHaveBeenCalled();
      expect(activeSessionRegistry.lookupByPath(worktree)).toBeNull();
      expect(activeSessionRegistry.lookupByPath(`${worktree}-executor`)?.kind).toBe("executor");
      expect(activeSessionRegistry.lookupByPath(`${worktree}-foreign`)?.taskId).toBe("FN-OTHER");
      expect((processor as unknown as { activeSessions: Map<string, unknown> }).activeSessions.has(task.id)).toBe(false);
    } finally {
      processor.stop();
      activeSessionRegistry.unregisterPath(worktree);
      activeSessionRegistry.unregisterPath(`${worktree}-executor`);
      activeSessionRegistry.unregisterPath(`${worktree}-foreign`);
    }
  });
});
