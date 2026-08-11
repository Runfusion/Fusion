import { describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTaskMergeBlocker } from "@fusion/core";
import { seedMergeLaneState } from "./_project-engine-merge-lane-fixture.js";

const mocks = vi.hoisted(() => ({
  runAiMerge: vi.fn(),
  actualRunAiMerge: undefined as typeof import("../merge/merger-ai.js").runAiMerge | undefined,
}));

vi.mock("../merge/merger-ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/merger-ai.js")>();
  mocks.actualRunAiMerge = actual.runAiMerge;
  return { ...actual, runAiMerge: mocks.runAiMerge };
});

import { landWorkspaceTask, writeTransientMergeStatus } from "../merge/merger-ai.js";
import { ProjectEngine } from "../project-engine.js";

const mergeStatuses = ["merging", "merging-pr", "merging-fix", "reviewing", "landing"];

function makeEngine(status: string | null, mergeConfirmed = false) {
  const task = {
    id: "FN-8912",
    status,
    mergeDetails: mergeConfirmed ? { mergeConfirmed: true } : undefined,
  };
  const store = {
    getTask: vi.fn().mockResolvedValue(task),
    updateTask: vi.fn(async (_id: string, patch: { status: null }) => {
      task.status = patch.status;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
  };
  const engine = Object.create(ProjectEngine.prototype) as {
    runtime: { getTaskStore(): typeof store };
    clearAbortedMergeStamp(taskId: string): Promise<void>;
    reconcileClaimedMergeStamp(taskId: string): Promise<void>;
  };
  engine.runtime = { getTaskStore: () => store };
  return { engine, store, task };
}

describe("runAiMerge transient status write authority", () => {
  /*
  FNXC:MergeReliability 2026-08-10-00:03:
  Exercise the real workspace closure rather than only the extracted helper: its `finally` is the
  dangerous orphan surface because it clears status after an abort. The per-generation fence must
  make both the initial stamp and that finally clear no-ops after the merge race loses.
  */
  it("suppresses the real workspace path's finally clear after its generation aborts", async () => {
    const controller = new AbortController();
    const store = {
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      // Abort after the real closure writes its initial stamp, so its production finally executes.
      updateTask: vi.fn(async (_id: string, patch: { status: string | null }) => {
        if (patch.status === "merging") controller.abort();
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceTask = {
      id: "FN-8912-workspace-fence",
      column: "in-review",
      branch: "fusion/fn-8912-workspace-fence",
      workspaceWorktrees: { repo: { worktreePath: "/tmp/repo", branch: "fusion/fn-8912-workspace-fence" } },
      steps: [],
      log: [],
    };

    await expect(landWorkspaceTask(store as any, workspaceTask as any, "/tmp", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "MergeAbortedError" });

    expect(store.updateTask).toHaveBeenCalledExactlyOnceWith(workspaceTask.id, { status: "merging" });
  });

  it("suppresses the real single-repo closure's post-abort work after its initial stamp", async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "fusion-merge-abort-status-"));
    try {
      execSync("git init -b main", { cwd: rootDir, stdio: "pipe" });
      execSync('git config user.email "test@example.com" && git config user.name "Test"', { cwd: rootDir, stdio: "pipe" });
      writeFileSync(path.join(rootDir, "README.md"), "test\n");
      execSync("git add README.md && git commit -m init && git checkout -b fusion/fn-8912-single && git checkout main", { cwd: rootDir, stdio: "pipe" });

      const controller = new AbortController();
      const task = { id: "FN-8912-single", column: "in-review", branch: "fusion/fn-8912-single", comments: [], steeringComments: [], steps: [], log: [] };
      const store = {
        getTask: vi.fn(async () => task),
        getSettings: vi.fn(async () => ({ autoMerge: true })),
        updateTask: vi.fn(async (_id: string, patch: { status: string | null }) => {
          if (patch.status === "merging") controller.abort();
        }),
        logEntry: vi.fn().mockResolvedValue(undefined),
        appendAgentLog: vi.fn().mockResolvedValue(undefined),
      };

      await expect(mocks.actualRunAiMerge!(store as any, rootDir, task.id, { manual: true, signal: controller.signal }))
        .rejects.toMatchObject({ name: "MergeAbortedError" });
      expect(store.updateTask).toHaveBeenCalledExactlyOnceWith(task.id, { status: "merging" });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it.each(["merging", "landing", null] as const)("suppresses %s writes from an aborted generation", async (status) => {
    const controller = new AbortController();
    const store = { updateTask: vi.fn().mockResolvedValue(undefined) };
    controller.abort();

    await writeTransientMergeStatus(store as any, "FN-8912", controller.signal, status);

    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it.each(["merging", "landing", null] as const)("allows %s writes from the live generation", async (status) => {
    const controller = new AbortController();
    const store = { updateTask: vi.fn().mockResolvedValue(undefined) };

    await writeTransientMergeStatus(store as any, "FN-8912", controller.signal, status);

    expect(store.updateTask).toHaveBeenCalledExactlyOnceWith("FN-8912", { status });
  });
});

describe("ProjectEngine aborted merge stamp cleanup", () => {
  it("does not instantiate a merge body when cancellation arrives during claimed-stamp reconciliation", async () => {
    const engine = Object.create(ProjectEngine.prototype) as {
      runAbortableMergeBody<T>(bodyFactory: () => Promise<T>, signal: AbortSignal, taskId: string): Promise<T>;
    };
    const controller = new AbortController();
    const bodyFactory = vi.fn(async () => undefined);
    controller.abort();

    await expect(engine.runAbortableMergeBody(bodyFactory, controller.signal, "FN-8912"))
      .rejects.toMatchObject({ name: "MergeAbortedError" });
    expect(bodyFactory).not.toHaveBeenCalled();
  });

  it.each(mergeStatuses)("clears the aborted %s stamp before callers retry", async (status) => {
    const { engine, store, task } = makeEngine(status);

    await engine.clearAbortedMergeStamp("FN-8912");

    expect(task.status).toBeNull();
    expect(store.updateTask).toHaveBeenCalledWith("FN-8912", { status: null });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-8912",
      `Auto-recovered: cleared stale '${status}' status`,
      "MergeAborted",
    );
  });

  it("reconciles an orphaned stamp under a newly claimed generation", async () => {
    const { engine, store, task } = makeEngine("landing");

    await engine.reconcileClaimedMergeStamp("FN-8912");

    expect(task.status).toBeNull();
    expect(store.updateTask).toHaveBeenCalledWith("FN-8912", { status: null });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-8912",
      "Auto-recovered: reconciled orphaned 'landing' merge status",
      "MergeQueue",
    );
  });

  it("does not clear terminal or confirmed state", async () => {
    for (const [status, confirmed] of [["failed", false], ["merging", true]] as const) {
      const { engine, store, task } = makeEngine(status, confirmed);
      await engine.clearAbortedMergeStamp("FN-8912");
      expect(task.status).toBe(status);
      expect(store.updateTask).not.toHaveBeenCalled();
    }
  });

  it.each(mergeStatuses)("clears a manual abort's %s stamp before its rejection handler starts a successor merge", async (initialStatus) => {
    mocks.runAiMerge.mockReset();
    const task = {
      id: "FN-8912",
      column: "in-review",
      // Start unstamped so the pump-side reconcile is a deliberate no-op. The first body then
      // creates the merge-active stamp that the abort branch, rather than the pump, must clear.
      status: null as string | null,
      paused: false,
      userPaused: false,
      branch: "fusion/fn-8912",
      priority: "normal",
      mergeRetries: 0,
      steps: [],
      workflowStepResults: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const store = {
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
      logEntry: vi.fn(async () => undefined),
      getRootDir: vi.fn(() => "/tmp/fn-8912"),
      listTasks: vi.fn(async () => []),
      getActiveMergingTask: vi.fn(async () => null),
      emit: vi.fn(),
    };
    const engine = seedMergeLaneState(Object.create(ProjectEngine.prototype) as any, {
      mergeBodySettleTimeoutMs: 1,
    });
    engine.config = { workingDirectory: "/tmp/fn-8912" };
    engine.options = {};
    engine.runtime = { getTaskStore: () => store, getPluginRunner: () => undefined };

    let firstSignal: AbortSignal | undefined;
    let firstSetStatus: ((status: string | null) => Promise<unknown>) | undefined;
    let successorObservedBlocker: string | undefined;
    let finishSuccessor: (() => void) | undefined;
    const successorBody = new Promise<void>((resolve) => {
      finishSuccessor = resolve;
    });
    mocks.runAiMerge
      .mockImplementationOnce(async (_store: unknown, _cwd: string, _taskId: string, options: { signal?: AbortSignal }) => {
        firstSignal = options.signal;
        // This is the exact transient-status writer shape captured by runAiMerge's production
        // closure. Keep the first body alive after its race loses so its later writer is an
        // outlived generation, not a synthetic post-test store mutation.
        firstSetStatus = (status) => writeTransientMergeStatus(store as any, task.id, options.signal, status);
        await firstSetStatus(initialStatus);
        return await new Promise<never>(() => undefined);
      })
      .mockImplementationOnce(async () => {
        successorObservedBlocker = getTaskMergeBlocker(task as any, { manual: true });
        await successorBody;
        return {
          task,
          branch: task.branch,
          merged: false,
          worktreeRemoved: false,
          branchDeleted: false,
        };
      });

    const first = ProjectEngine.prototype.onMerge.call(engine, task.id);
    // Model routeGraphMergeFailureToRetry's ordering: its resolver rejection handler performs
    // awaited store work before requesting the bounded successor merge.
    const retryFromRejectedResolver = first.catch(async () => {
      await store.logEntry(task.id, "workflow merge failure routed to bounded retry");
      await store.getTask(task.id);
      return ProjectEngine.prototype.onMerge.call(engine, task.id);
    });
    await vi.waitFor(() => expect(mocks.runAiMerge).toHaveBeenCalledTimes(1));
    expect(firstSignal?.aborted).toBe(false);
    expect(task.status).toBe(initialStatus);

    expect(ProjectEngine.prototype.abortActiveMerge.call(engine, task.id, "test-timeout")).toBe(true);
    await vi.waitFor(() => expect(task.status).toBeNull());

    // The retry begins from the real manual resolver rejection after its awaited round trips.
    // The drain loop's trailing finally must already have released the dead generation's lane.
    await vi.waitFor(() => expect(mocks.runAiMerge).toHaveBeenCalledTimes(2));
    const successor = retryFromRejectedResolver;
    expect(successorObservedBlocker).toBeUndefined();
    expect(mocks.runAiMerge.mock.calls[1]?.[3]).toMatchObject({ manual: true });

    // Keep the successor live while the orphan writes. This proves the dead generation cannot
    // either restamp it or let its old task-id-keyed cleanup tear down the successor's lane.
    expect(engine.activeMergeTaskId).toBe(task.id);
    expect(engine.mergeActive.has(task.id)).toBe(true);
    expect(engine.manualMergeResolvers.has(task.id)).toBe(true);
    task.status = "merging";
    const writesBeforeOrphan = store.updateTask.mock.calls.length;
    await firstSetStatus?.("landing");
    await firstSetStatus?.(null);
    await firstSetStatus?.("merging");
    expect(task.status).toBe("merging");
    expect(store.updateTask).toHaveBeenCalledTimes(writesBeforeOrphan);
    expect(engine.activeMergeTaskId).toBe(task.id);
    expect(engine.mergeActive.has(task.id)).toBe(true);

    finishSuccessor?.();
    await expect(successor).resolves.toMatchObject({ task, merged: false });
  });

  it.each(["merging", "landing"] as const)("runs the direct pump reconcile before the body observes an orphaned %s stamp", async (status) => {
    mocks.runAiMerge.mockReset();
    const task = {
      id: "FN-8912-direct-reconcile",
      column: "in-review",
      status: status as string | null,
      paused: false,
      userPaused: false,
      branch: "fusion/fn-8912-direct-reconcile",
      priority: "normal",
      mergeRetries: 0,
      steps: [],
      workflowStepResults: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const store = {
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
      logEntry: vi.fn(async () => undefined),
      getRootDir: vi.fn(() => "/tmp/fn-8912"),
      listTasks: vi.fn(async () => []),
      getActiveMergingTask: vi.fn(async () => null),
      emit: vi.fn(),
    };
    const engine = seedMergeLaneState(Object.create(ProjectEngine.prototype) as any);
    engine.config = { workingDirectory: "/tmp/fn-8912" };
    engine.options = {};
    engine.runtime = { getTaskStore: () => store, getPluginRunner: () => undefined };
    let observedBlocker: string | undefined;
    mocks.runAiMerge.mockImplementationOnce(async () => {
      observedBlocker = getTaskMergeBlocker(task as any, { manual: true });
      return { task, branch: task.branch, merged: false, worktreeRemoved: false, branchDeleted: false };
    });

    await expect(ProjectEngine.prototype.onMerge.call(engine, task.id)).resolves.toMatchObject({ task, merged: false });

    expect(observedBlocker).toBeUndefined();
    expect(task.status).toBeNull();
    expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: null });
  });

  it("runs the PR pump reconcile before its production dispatch body", async () => {
    const task = {
      id: "FN-8912-pr-reconcile",
      column: "in-review",
      status: "merging" as string | null,
      paused: false,
      userPaused: false,
      branch: "fusion/fn-8912-pr-reconcile",
      priority: "normal",
      mergeRetries: 0,
      steps: [],
      workflowStepResults: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const store = {
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
      logEntry: vi.fn(async () => undefined),
      getRootDir: vi.fn(() => "/tmp/fn-8912"),
      listTasks: vi.fn(async () => []),
      getActiveMergingTask: vi.fn(async () => null),
      emit: vi.fn(),
    };
    let observedBlocker: string | undefined;
    const engine = seedMergeLaneState(Object.create(ProjectEngine.prototype) as any);
    engine.config = { workingDirectory: "/tmp/fn-8912" };
    engine.options = {
      getMergeStrategy: () => "pull-request",
      processPullRequestMerge: vi.fn(async () => {
        observedBlocker = getTaskMergeBlocker(task as any, { manual: true });
        return "waiting";
      }),
    };
    engine.runtime = { getTaskStore: () => store, getPluginRunner: () => undefined };

    await expect(ProjectEngine.prototype.onMerge.call(engine, task.id)).resolves.toMatchObject({ task, merged: false });

    expect(observedBlocker).toBeUndefined();
    expect(task.status).toBeNull();
  });

  it.each(mergeStatuses)("clears the %s stamp through the no-manual-resolver abort arm", async (status) => {
    mocks.runAiMerge.mockReset();
    const task = {
      id: "FN-8912-auto-abort",
      column: "in-review",
      status,
      paused: false,
      userPaused: false,
      branch: "fusion/fn-8912-auto-abort",
      priority: "normal",
      mergeRetries: 0,
      steps: [],
      workflowStepResults: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const store = {
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
      logEntry: vi.fn(async () => undefined),
      getRootDir: vi.fn(() => "/tmp/fn-8912"),
      listTasks: vi.fn(async () => []),
      getActiveMergingTask: vi.fn(async () => null),
      emit: vi.fn(),
    };
    const engine = seedMergeLaneState(Object.create(ProjectEngine.prototype) as any, {
      mergeQueue: [task.id],
    });
    engine.config = { workingDirectory: "/tmp/fn-8912" };
    engine.options = {};
    engine.runtime = { getTaskStore: () => store, getPluginRunner: () => undefined };
    mocks.runAiMerge.mockImplementationOnce(async () => {
      const err = new Error("test abort");
      err.name = "MergeAbortedError";
      throw err;
    });

    await (engine as any).drainMergeQueue();

    expect(task.status).toBeNull();
    expect(engine.manualMergeResolvers.has(task.id)).toBe(false);
    expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: null });
  });
});
