import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SELF_OWNED_MIN_IDLE_MS, activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { registerPlanningLivenessProbe } from "../agents/planning-liveness.js";
import { ActiveSessionWorktreeRemovalError } from "../worktree/worktree-backend.js";
import { reconcileTaskResetSessionRoot, removeTaskResetWorktree, ResetWorktreeForeignSessionError } from "../worktree/remove-reset-worktree.js";

const PATH = "/tmp/fn-151-reset-worktree";
const TASK = "FN-151";

afterEach(() => {
  activeSessionRegistry.clear();
  executingTaskLock.release(TASK);
});

function input(overrides: Partial<Parameters<typeof removeTaskResetWorktree>[0]> = {}) {
  return {
    worktreePath: PATH,
    rootDir: "/tmp",
    settings: {},
    taskId: TASK,
    now: () => Date.now() + DEFAULT_SELF_OWNED_MIN_IDLE_MS + 1,
    remove: vi.fn().mockResolvedValue({ removed: true, classification: "removed" }),
    ...overrides,
  };
}

describe("reconcileTaskResetSessionRoot", () => {
  it("resolves when the coordinator has no registry entry", async () => {
    await expect(reconcileTaskResetSessionRoot({ sessionRootPath: PATH, taskId: TASK })).resolves.toBeUndefined();
  });

  it("reconciles an aged dead self-owned coordinator entry", async () => {
    activeSessionRegistry.registerPath(PATH, { taskId: TASK, kind: "executor", ownerKey: TASK });

    await reconcileTaskResetSessionRoot({
      sessionRootPath: PATH,
      taskId: TASK,
      now: () => Date.now() + DEFAULT_SELF_OWNED_MIN_IDLE_MS + 1,
    });

    expect(activeSessionRegistry.lookupByPath(PATH)).toBeNull();
  });

  it("refuses a live self-owned coordinator entry and leaves it registered", async () => {
    activeSessionRegistry.registerPath(PATH, { taskId: TASK, kind: "planning", ownerKey: `planning:${TASK}` });
    const unregister = registerPlanningLivenessProbe((id) => id === TASK);
    try {
      await expect(reconcileTaskResetSessionRoot({
        sessionRootPath: PATH,
        taskId: TASK,
        now: () => Date.now() + DEFAULT_SELF_OWNED_MIN_IDLE_MS + 1,
      })).rejects.toBeInstanceOf(ActiveSessionWorktreeRemovalError);
      expect(activeSessionRegistry.lookupByPath(PATH)?.taskId).toBe(TASK);
    } finally {
      unregister();
    }
  });

  it("reports a foreign coordinator holder", async () => {
    activeSessionRegistry.registerPath(PATH, { taskId: "FN-OTHER", kind: "workflow-step", ownerKey: "FN-OTHER#workflow-step" });

    const rejection = reconcileTaskResetSessionRoot({ sessionRootPath: PATH, taskId: TASK });

    await expect(rejection).rejects.toMatchObject({
      details: { holderTaskId: "FN-OTHER", holderKind: "workflow-step" },
    });
    await expect(rejection).rejects.toBeInstanceOf(ResetWorktreeForeignSessionError);
  });

  it("waits once for a recent coordinator entry by default", async () => {
    activeSessionRegistry.registerPath(PATH, { taskId: TASK, kind: "executor", ownerKey: TASK });
    let now = Date.now();
    const wait = vi.fn().mockImplementation(async (ms: number) => { now += ms + 1; });

    await reconcileTaskResetSessionRoot({ sessionRootPath: PATH, taskId: TASK, now: () => now, wait });

    expect(wait).toHaveBeenCalledOnce();
    expect(activeSessionRegistry.lookupByPath(PATH)).toBeNull();
  });

  it("immediately refuses a recent point-of-use entry without waiting", async () => {
    activeSessionRegistry.registerPath(PATH, { taskId: TASK, kind: "executor", ownerKey: TASK });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(reconcileTaskResetSessionRoot({
      sessionRootPath: PATH,
      taskId: TASK,
      settleTooRecent: false,
      wait,
    })).rejects.toBeInstanceOf(ActiveSessionWorktreeRemovalError);

    expect(wait).not.toHaveBeenCalled();
    expect(activeSessionRegistry.lookupByPath(PATH)?.taskId).toBe(TASK);
  });
});

describe("removeTaskResetWorktree", () => {
  it("reconciles an aged dead self-owned planning entry before removal", async () => {
    activeSessionRegistry.registerPath(PATH, { taskId: TASK, kind: "planning", ownerKey: `planning:${TASK}` });
    const options = input();
    await expect(removeTaskResetWorktree(options)).resolves.toMatchObject({ removed: true });
    expect(activeSessionRegistry.lookupByPath(PATH)).toBeNull();
    expect(options.remove).toHaveBeenCalledOnce();
  });

  it("waits once for a recent stale entry and then removes it", async () => {
    activeSessionRegistry.registerPath(PATH, { taskId: TASK, kind: "planning", ownerKey: `planning:${TASK}` });
    let now = Date.now();
    const wait = vi.fn().mockImplementation(async (ms: number) => { now += ms + 1; });
    const options = input({ now: () => now, wait });
    await removeTaskResetWorktree(options);
    expect(wait).toHaveBeenCalledWith(expect.any(Number));
    expect(wait.mock.calls[0][0]).toBeLessThanOrEqual(DEFAULT_SELF_OWNED_MIN_IDLE_MS);
    expect(options.remove).toHaveBeenCalledOnce();
  });

  it("refuses an aged live planning holder without removing it", async () => {
    activeSessionRegistry.registerPath(PATH, { taskId: TASK, kind: "planning", ownerKey: `planning:${TASK}` });
    const unregister = registerPlanningLivenessProbe((id) => id === TASK);
    const options = input();
    try {
      await expect(removeTaskResetWorktree(options)).rejects.toBeInstanceOf(ActiveSessionWorktreeRemovalError);
      expect(activeSessionRegistry.lookupByPath(PATH)?.kind).toBe("planning");
      expect(options.remove).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it("refuses a foreign holder without calling removal", async () => {
    activeSessionRegistry.registerPath(PATH, { taskId: "FN-OTHER", kind: "planning", ownerKey: "planning:FN-OTHER" });
    const options = input();
    await expect(removeTaskResetWorktree(options)).rejects.toBeInstanceOf(ResetWorktreeForeignSessionError);
    expect(options.remove).not.toHaveBeenCalled();
  });

  it("re-applies liveness gates before its single post-removal race retry", async () => {
    const remove = vi.fn()
      .mockImplementationOnce(async () => {
        activeSessionRegistry.registerPath(PATH, { taskId: TASK, kind: "planning", ownerKey: `planning:${TASK}` });
        throw new ActiveSessionWorktreeRemovalError({ worktreePath: PATH, taskId: TASK, kind: "planning", ownerKey: `planning:${TASK}`, reason: "task-reset" as never });
      });
    const unregister = registerPlanningLivenessProbe((id) => id === TASK);
    try {
      await expect(removeTaskResetWorktree(input({ remove }))).rejects.toBeInstanceOf(ActiveSessionWorktreeRemovalError);
      expect(remove).toHaveBeenCalledOnce();
    } finally { unregister(); }
  });
});
