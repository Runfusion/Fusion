import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node modules
// Route async `exec` through the `execSync` mock so existing tests that set up
// mockedExecSync.mockImplementation for verification keep working unchanged.
vi.mock("node:child_process", async () => {
  const { promisify: utilPromisify } = await import("node:util");
  const execSyncFn = vi.fn();
   
  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "object" && opts !== null ? opts : {};
    try {
      const out = execSyncFn(cmd, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err) {
      if (typeof callback === "function") {
        const error = err as { stdout?: string; stderr?: string };
        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
      }
    }
  });
  // Mirror real child_process.exec: promisify resolves to { stdout, stderr }.
   
  execFn[utilPromisify.custom] = (cmd: string, opts?: any) =>
    new Promise((resolve, reject) => {
       
      execFn(cmd, opts, (err: any, stdout: string, stderr: string) => {
        if (err) {
          (err as Record<string, unknown>).stdout = stdout;
          (err as Record<string, unknown>).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  return { execSync: execSyncFn, exec: execFn };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
  };
});

vi.mock("../worktree-pool.js", () => ({
  WorktreePool: vi.fn(),
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  scanOrphanedBranches: vi.fn().mockResolvedValue([]),
}));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn((_name: string) => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { SelfHealingManager } from "../self-healing.js";
import type { TaskStore, Settings, Task } from "@fusion/core";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { scanOrphanedBranches } from "../worktree-pool.js";
import { createLogger } from "../logger.js";

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedScanOrphanedBranches = vi.mocked(scanOrphanedBranches);
const mockedCreateLogger = vi.mocked(createLogger);

type MockLogger = {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function getSelfHealingLogger(): MockLogger {
  const idx = mockedCreateLogger.mock.calls.findIndex(([name]) => name === "self-healing");
  if (idx === -1) {
    throw new Error("self-healing logger was not created");
  }
  return mockedCreateLogger.mock.results[idx]?.value as MockLogger;
}

// ── Mock helpers ────────────────────────────────────────────────────

/** TaskStore mock backed by a real EventEmitter so settings:updated works. */
function createMockStore(overrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const store = Object.assign(emitter, {
    getSettings: vi.fn().mockResolvedValue({
      autoUnpauseEnabled: true,
      autoUnpauseBaseDelayMs: 100,
      autoUnpauseMaxDelayMs: 800,
      maxStuckKills: 6,
      maintenanceIntervalMs: 0,
      maxWorktrees: 4,
      globalPause: true, // default: paused (for auto-unpause tests)
    } as unknown as Settings),
    updateSettings: vi.fn().mockResolvedValue({} as Settings),
    getTask: vi.fn().mockResolvedValue({
      id: "FN-001",
      stuckKillCount: 0,
    } as unknown as Task),
    updateTask: vi.fn().mockResolvedValue({} as Task),
    logEntry: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    mergeTask: vi.fn().mockResolvedValue(undefined),
    archiveTaskAndCleanup: vi.fn().mockResolvedValue({} as Task),
    walCheckpoint: vi.fn().mockReturnValue({ busy: 0, log: 5, checkpointed: 5 }),
    listTasks: vi.fn().mockResolvedValue([]),
    getRootDir: vi.fn().mockReturnValue("/tmp/test-project"),
    clearStaleBaseBranchReferences: vi.fn().mockReturnValue([]),
    ...overrides,
  }) as unknown as TaskStore & EventEmitter;
  return store;
}

describe("SelfHealingManager", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    store = createMockStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  // ── Auto-unpause ─────────────────────────────────────────────────

  describe("auto-unpause", () => {
    it("does not schedule unpause when globalPauseReason is 'manual'", async () => {
      manager.start();

      store.emit("settings:updated", {
        settings: {
          globalPause: true,
          globalPauseReason: "manual",
          autoUnpauseEnabled: true,
          autoUnpauseBaseDelayMs: 100,
          autoUnpauseMaxDelayMs: 800,
        },
        previous: { globalPause: false },
      });

      await vi.advanceTimersByTimeAsync(500);

      expect(store.updateSettings).not.toHaveBeenCalled();
    });

    it("auto-unpauses when globalPauseReason is 'rate-limit'", async () => {
      manager.start();

      store.emit("settings:updated", {
        settings: {
          globalPause: true,
          globalPauseReason: "rate-limit",
          autoUnpauseEnabled: true,
          autoUnpauseBaseDelayMs: 100,
          autoUnpauseMaxDelayMs: 800,
        },
        previous: { globalPause: false },
      });

      await vi.advanceTimersByTimeAsync(150);

      expect(store.updateSettings).toHaveBeenCalledWith({
        globalPause: false,
        globalPauseReason: undefined,
      });
    });

    it("auto-unpauses when globalPauseReason is undefined (backward compat)", async () => {
      manager.start();

      store.emit("settings:updated", {
        settings: { globalPause: true, autoUnpauseEnabled: true, autoUnpauseBaseDelayMs: 100, autoUnpauseMaxDelayMs: 800 },
        previous: { globalPause: false },
      });

      await vi.advanceTimersByTimeAsync(150);

      expect(store.updateSettings).toHaveBeenCalledWith({
        globalPause: false,
        globalPauseReason: undefined,
      });
    });

    it("does not schedule unpause when autoUnpauseEnabled is false", async () => {
      manager.start();

      store.emit("settings:updated", {
        settings: { globalPause: true, autoUnpauseEnabled: false },
        previous: { globalPause: false },
      });

      await vi.advanceTimersByTimeAsync(500);

      expect(store.updateSettings).not.toHaveBeenCalled();
    });

    it("does not fire when already unpaused before timer", async () => {
      // When the timer fires, getSettings returns globalPause: false
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        globalPause: false,
        maintenanceIntervalMs: 0,
      } as unknown as Settings);

      manager.start();

      store.emit("settings:updated", {
        settings: { globalPause: true, autoUnpauseEnabled: true, autoUnpauseBaseDelayMs: 100, autoUnpauseMaxDelayMs: 800 },
        previous: { globalPause: false },
      });

      await vi.advanceTimersByTimeAsync(150);

      expect(store.updateSettings).not.toHaveBeenCalled();
    });

    it("escalates backoff when pause re-triggers within 60s", async () => {
      manager.start();

      // First pause
      store.emit("settings:updated", {
        settings: { globalPause: true, autoUnpauseEnabled: true, autoUnpauseBaseDelayMs: 100, autoUnpauseMaxDelayMs: 800 },
        previous: { globalPause: false },
      });

      await vi.advanceTimersByTimeAsync(150);
      expect(store.updateSettings).toHaveBeenCalledTimes(1);

      // Simulate successful unpause
      store.emit("settings:updated", {
        settings: { globalPause: false },
        previous: { globalPause: true },
      });

      // Immediately re-trigger pause (within 60s window)
      store.emit("settings:updated", {
        settings: { globalPause: true, autoUnpauseEnabled: true, autoUnpauseBaseDelayMs: 100, autoUnpauseMaxDelayMs: 800 },
        previous: { globalPause: false },
      });

      // Escalated delay = 200ms. At 150ms it should NOT have fired yet.
      await vi.advanceTimersByTimeAsync(150);
      expect(store.updateSettings).toHaveBeenCalledTimes(1);

      // At 250ms total (100ms more) it should fire
      await vi.advanceTimersByTimeAsync(100);
      expect(store.updateSettings).toHaveBeenCalledTimes(2);
    });

    it("cancels timer on manual unpause (true→false)", async () => {
      manager.start();

      store.emit("settings:updated", {
        settings: { globalPause: true, autoUnpauseEnabled: true, autoUnpauseBaseDelayMs: 200, autoUnpauseMaxDelayMs: 800 },
        previous: { globalPause: false },
      });

      // Manual unpause before timer fires
      store.emit("settings:updated", {
        settings: { globalPause: false },
        previous: { globalPause: true },
      });

      await vi.advanceTimersByTimeAsync(300);

      expect(store.updateSettings).not.toHaveBeenCalled();
    });

    it("ignores false→false transitions", async () => {
      manager.start();

      store.emit("settings:updated", {
        settings: { globalPause: false },
        previous: { globalPause: false },
      });

      await vi.advanceTimersByTimeAsync(500);

      expect(store.updateSettings).not.toHaveBeenCalled();
    });
  });

  // ── Stuck kill budget ─────────────────────────────────────────────

  describe("checkStuckBudget", () => {
    it("returns true and increments count when within budget", async () => {
      manager.start();

      const result = await manager.checkStuckBudget("FN-001");

      expect(result).toBe(true);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { stuckKillCount: 1 });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        expect.stringContaining("Stuck kill 1/6"),
      );
    });

    it("returns true for subsequent kills within budget", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-001",
        stuckKillCount: 2,
      } as unknown as Task);

      manager.start();

      const result = await manager.checkStuckBudget("FN-001");

      expect(result).toBe(true);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { stuckKillCount: 3 });
    });

    it("moves task to in-review when stuck-kill budget is exhausted", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-001",
        stuckKillCount: 6,
      } as unknown as Task);

      manager.start();

      const result = await manager.checkStuckBudget("FN-001");

      expect(result).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
        stuckKillCount: 7,
        status: "failed",
        error: expect.stringContaining("exceeded maximum of 6"),
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        expect.stringContaining("moved to in-review"),
      );
    });

    it("respects custom maxStuckKills setting", async () => {
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        maxStuckKills: 1,
        maintenanceIntervalMs: 0,
      } as unknown as Settings);
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-001",
        stuckKillCount: 1,
      } as unknown as Task);

      manager.start();

      const result = await manager.checkStuckBudget("FN-001");

      expect(result).toBe(false);
    });

    it("returns true on error (safe fallback)", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB error"));

      manager.start();

      const result = await manager.checkStuckBudget("FN-001");

      expect(result).toBe(true);
    });

    it("handles undefined stuckKillCount as 0", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-001",
      } as unknown as Task);

      manager.start();

      const result = await manager.checkStuckBudget("FN-001");

      expect(result).toBe(true);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { stuckKillCount: 1 });
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("starts and stops without error", () => {
      manager.start();
      manager.stop();
    });

    it("cleans up timers on stop", async () => {
      manager.start();

      store.emit("settings:updated", {
        settings: { globalPause: true, autoUnpauseEnabled: true, autoUnpauseBaseDelayMs: 500, autoUnpauseMaxDelayMs: 800 },
        previous: { globalPause: false },
      });

      manager.stop();

      await vi.advanceTimersByTimeAsync(1000);
      expect(store.updateSettings).not.toHaveBeenCalled();
    });

    it("does not respond to events after stop", async () => {
      manager.start();
      manager.stop();

      store.emit("settings:updated", {
        settings: { globalPause: true, autoUnpauseEnabled: true, autoUnpauseBaseDelayMs: 100, autoUnpauseMaxDelayMs: 800 },
        previous: { globalPause: false },
      });

      await vi.advanceTimersByTimeAsync(200);
      expect(store.updateSettings).not.toHaveBeenCalled();
    });

    it("runStartupRecovery invokes the startup recovery subset", async () => {
      const recoverNoProgressNoTaskDoneFailures = vi.spyOn(manager, "recoverNoProgressNoTaskDoneFailures").mockResolvedValue(1);
      const recoverCompletedTasks = vi.spyOn(manager, "recoverCompletedTasks").mockResolvedValue(1);
      const recoverMisclassifiedFailures = vi.spyOn(manager, "recoverMisclassifiedFailures").mockResolvedValue(1);
      const recoverPartialProgressNoTaskDoneFailures = vi.spyOn(manager, "recoverPartialProgressNoTaskDoneFailures").mockResolvedValue(1);
      const recoverOrphanedExecutions = vi.spyOn(manager, "recoverOrphanedExecutions").mockResolvedValue(1);
      const recoverApprovedTriageTasks = vi.spyOn(manager, "recoverApprovedTriageTasks").mockResolvedValue(1);

      await manager.runStartupRecovery();

      expect(recoverNoProgressNoTaskDoneFailures).toHaveBeenCalledTimes(1);
      expect(recoverCompletedTasks).toHaveBeenCalledTimes(1);
      expect(recoverMisclassifiedFailures).toHaveBeenCalledTimes(1);
      expect(recoverPartialProgressNoTaskDoneFailures).toHaveBeenCalledTimes(1);
      expect(recoverOrphanedExecutions).toHaveBeenCalledTimes(1);
      expect(recoverApprovedTriageTasks).toHaveBeenCalledTimes(1);
    });
  });

  describe("recoverNoProgressNoTaskDoneFailures", () => {
    it("requeues clean in-progress no-task_done failures with no step progress", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: () => new Set<string>(),
      });
      vi.spyOn(managerWithRecovery as any, "hasRecoverableGitWork").mockReturnValue(false);

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-1473",
          column: "in-progress",
          status: "failed",
          error: "Agent finished without calling task_done (after retry)",
          paused: false,
          steps: [],
        },
      ]);

      const result = await managerWithRecovery.recoverNoProgressNoTaskDoneFailures();

      expect(result).toBe(1);
      expect(store.listTasks).toHaveBeenCalledWith({ column: "in-progress", slim: true });
      expect(store.updateTask).toHaveBeenCalledWith("FN-1473", {
        status: "stuck-killed",
        worktree: null,
        branch: null,
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-1473",
        expect.stringContaining("no-progress no-task_done failure"),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-1473", "todo");

      managerWithRecovery.stop();
    });

    it("skips no-task_done failures with step progress", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: () => new Set<string>(),
      });
      vi.spyOn(managerWithRecovery as any, "hasRecoverableGitWork").mockReturnValue(false);

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-1473",
          column: "in-progress",
          status: "failed",
          error: "Agent finished without calling task_done (after retry)",
          paused: false,
          steps: [{ status: "done" }, { status: "pending" }],
        },
      ]);

      const result = await managerWithRecovery.recoverNoProgressNoTaskDoneFailures();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-1473", expect.anything());
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-1473", "todo");

      managerWithRecovery.stop();
    });

    it("skips when git work should be preserved", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: () => new Set<string>(),
      });
      vi.spyOn(managerWithRecovery as any, "hasRecoverableGitWork").mockReturnValue(true);

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-1473",
          column: "in-progress",
          status: "failed",
          error: "Agent finished without calling task_done (after retry)",
          paused: false,
          steps: [{ status: "pending" }],
        },
      ]);

      const result = await managerWithRecovery.recoverNoProgressNoTaskDoneFailures();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-1473", expect.anything());
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-1473", "todo");

      managerWithRecovery.stop();
    });

    it("treats dirty worktrees as recoverable git work", async () => {
      const task = {
        id: "FN-1473",
        worktree: "/tmp/test-project/.worktrees/fn-1473",
        branch: "fusion/fn-1473",
      } as Task;
      mockedExistsSync.mockReturnValue(true);
      mockedExecSync.mockImplementation((command) => {
        if (String(command) === "git status --porcelain") {
          return " M packages/engine/src/executor.ts\n" as any;
        }
        return "" as any;
      });

      expect(await (manager as any).hasRecoverableGitWork(task)).toBe(true);
      mockedExecSync.mockClear();
    });
  });

  describe("silent catch logging", () => {
    it("logs warn when interrupted-merge worktree removal fails", async () => {
      const warn = getSelfHealingLogger().warn;
      warn.mockClear();

      const task = {
        id: "FN-123",
        worktree: "/tmp/test-project/.worktrees/fn-123",
        branch: "fusion/fn-123",
      } as Task;

      mockedExistsSync.mockReset();
      mockedExistsSync.mockReturnValueOnce(true);
      mockedExecSync.mockReset();
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error("cannot remove worktree");
      });

      await (manager as any).cleanupInterruptedMergeArtifacts(task);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to remove interrupted-merge worktree ${task.worktree} for ${task.id}: cannot remove worktree`,
        ),
      );

      mockedExecSync.mockClear();
      mockedExistsSync.mockReset();
    });

    it("logs warn when interrupted-merge branch deletion fails", async () => {
      const warn = getSelfHealingLogger().warn;
      warn.mockClear();

      const task = {
        id: "FN-124",
        branch: "fusion/fn-124",
      } as Task;

      mockedExistsSync.mockReset();
      mockedExecSync.mockReset();
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error("cannot delete branch");
      });

      await (manager as any).cleanupInterruptedMergeArtifacts(task);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to delete interrupted-merge branch fusion/fn-124 for FN-124: cannot delete branch`,
        ),
      );

      mockedExecSync.mockClear();
      mockedExistsSync.mockReset();
    });
  });

  // ── cleanupOrphanedBranches ────────────────────────────────────────

  describe("cleanupOrphanedBranches", () => {
    it("returns 0 when no orphaned branches found", async () => {
      mockedScanOrphanedBranches.mockResolvedValueOnce([]);

      const result = await manager.cleanupOrphanedBranches();

      expect(result).toBe(0);
      expect(mockedExecSync).not.toHaveBeenCalled();
    });

    it("deletes orphaned branches with safe delete (-d)", async () => {
      mockedScanOrphanedBranches.mockResolvedValueOnce(["fusion/fn-001", "fusion/fn-002"]);

      const result = await manager.cleanupOrphanedBranches();

      expect(result).toBe(2);
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git branch -d "fusion/fn-001"'),
        expect.objectContaining({ cwd: "/tmp/test-project" }),
      );
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git branch -d "fusion/fn-002"'),
        expect.objectContaining({ cwd: "/tmp/test-project" }),
      );
    });

    it("falls back to force delete (-D) when safe delete fails", async () => {
      mockedScanOrphanedBranches.mockResolvedValueOnce(["fusion/fn-003"]);

      // Safe delete fails
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error("not fully merged");
      });
      // Force delete succeeds
      mockedExecSync.mockImplementationOnce(() => Buffer.from(""));

      const result = await manager.cleanupOrphanedBranches();

      expect(result).toBe(1);
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git branch -d "fusion/fn-003"'),
        expect.any(Object),
      );
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git branch -D "fusion/fn-003"'),
        expect.any(Object),
      );
    });

    it("counts only successfully deleted branches", async () => {
      mockedScanOrphanedBranches.mockResolvedValueOnce(["fusion/fn-004", "fusion/fn-005"]);

      // First branch: safe delete succeeds
      mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
      // Second branch: both safe and force delete fail
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error("not fully merged");
      });
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error("branch not found");
      });

      const result = await manager.cleanupOrphanedBranches();

      expect(result).toBe(1);
    });

    it("returns 0 when scanOrphanedBranches throws", async () => {
      mockedScanOrphanedBranches.mockRejectedValueOnce(new Error("git error"));

      const result = await manager.cleanupOrphanedBranches();

      expect(result).toBe(0);
    });
  });

  // ── Auto-archive ────────────────────────────────────────────────────

  describe("archiveStaleDoneTasks", () => {
    it("skips when auto-archive is disabled", async () => {
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoArchiveDoneTasksEnabled: false,
      } as unknown as Settings);

      const result = await manager.archiveStaleDoneTasks();

      expect(result).toBe(0);
      expect(store.listTasks).not.toHaveBeenCalled();
      expect(store.archiveTaskAndCleanup).not.toHaveBeenCalled();
    });

    it("archives stale done tasks with cleanup using the configured age", async () => {
      vi.setSystemTime(new Date("2026-01-04T00:00:00.000Z"));
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoArchiveDoneTasksEnabled: true,
        autoArchiveDoneAfterMs: 24 * 60 * 60 * 1000,
      } as unknown as Settings);
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-001",
          column: "done",
          columnMovedAt: "2026-01-02T23:59:00.000Z",
          updatedAt: "2026-01-02T23:59:00.000Z",
        },
        {
          id: "FN-002",
          column: "done",
          columnMovedAt: "2026-01-03T12:00:00.000Z",
          updatedAt: "2026-01-03T12:00:00.000Z",
        },
      ]);

      const result = await manager.archiveStaleDoneTasks();

      expect(result).toBe(1);
      expect(store.listTasks).toHaveBeenCalledWith({ slim: true, includeArchived: false });
      expect(store.archiveTaskAndCleanup).toHaveBeenCalledWith("FN-001");
      expect(store.archiveTaskAndCleanup).not.toHaveBeenCalledWith("FN-002");
    });
  });

  // ── Completed task recovery ─────────────────────────────────────────

  describe("recoverCompletedTasks", () => {
    it("recovers tasks with all steps done that are stuck in in-progress", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverCompletedTask: recoverFn,
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-001",
          column: "in-progress",
          paused: false,
          steps: [
            { status: "done" },
            { status: "done" },
            { status: "skipped" },
          ],
        },
      ]);

      const result = await managerWithRecovery.recoverCompletedTasks();

      expect(result).toBe(1);
      expect(store.listTasks).toHaveBeenCalledWith({ column: "in-progress", slim: true });
      expect(recoverFn).toHaveBeenCalledWith(
        expect.objectContaining({ id: "FN-001" }),
      );

      managerWithRecovery.stop();
    });

    it("skips tasks that are actively executing", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getExecuting = vi.fn().mockReturnValue(new Set(["FN-001"]));

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverCompletedTask: recoverFn,
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-001",
          column: "in-progress",
          paused: false,
          steps: [{ status: "done" }, { status: "done" }],
        },
      ]);

      const result = await managerWithRecovery.recoverCompletedTasks();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks with incomplete steps", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverCompletedTask: recoverFn,
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-002",
          column: "in-progress",
          paused: false,
          steps: [
            { status: "done" },
            { status: "in-progress" },
            { status: "pending" },
          ],
        },
      ]);

      const result = await managerWithRecovery.recoverCompletedTasks();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips paused tasks", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverCompletedTask: recoverFn,
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-003",
          column: "in-progress",
          paused: true,
          steps: [{ status: "done" }, { status: "done" }],
        },
      ]);

      const result = await managerWithRecovery.recoverCompletedTasks();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks with no steps", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverCompletedTask: recoverFn,
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-004",
          column: "in-progress",
          paused: false,
          steps: [],
        },
      ]);

      const result = await managerWithRecovery.recoverCompletedTasks();

      expect(result).toBe(0);

      managerWithRecovery.stop();
    });

    it("returns 0 when no recoverCompletedTask callback is provided", async () => {
      // Default manager has no recovery callback
      const result = await manager.recoverCompletedTasks();
      expect(result).toBe(0);
    });

    it("counts only successfully recovered tasks", async () => {
      const recoverFn = vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverCompletedTask: recoverFn,
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-005",
          column: "in-progress",
          paused: false,
          steps: [{ status: "done" }],
        },
        {
          id: "FN-006",
          column: "in-progress",
          paused: false,
          steps: [{ status: "done" }],
        },
      ]);

      const result = await managerWithRecovery.recoverCompletedTasks();

      expect(result).toBe(1);
      expect(recoverFn).toHaveBeenCalledTimes(2);

      managerWithRecovery.stop();
    });

    it("returns 0 when listTasks throws", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverCompletedTask: recoverFn,
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DB error"));

      const result = await managerWithRecovery.recoverCompletedTasks();

      expect(result).toBe(0);

      managerWithRecovery.stop();
    });
  });

  describe("recoverMisclassifiedFailures", () => {
    it("clears failed status when all steps are done and error is no-task_done", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-300",
          column: "in-review",
          status: "failed",
          error: "Agent finished without calling task_done (after retry)",
          steps: [{ status: "done" }, { status: "done" }, { status: "skipped" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMisclassifiedFailures();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-300", {
        status: null,
        error: null,
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-300",
        expect.stringContaining("Auto-recovered"),
      );

      managerWithRecovery.stop();
    });

    it("skips tasks where steps are not all done", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-301",
          column: "in-review",
          status: "failed",
          error: "Agent finished without calling task_done (after retry)",
          steps: [{ status: "done" }, { status: "in-progress" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMisclassifiedFailures();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks with different error messages", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-302",
          column: "in-review",
          status: "failed",
          error: "Workflow step failed",
          steps: [{ status: "done" }, { status: "done" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMisclassifiedFailures();

      expect(result).toBe(0);

      managerWithRecovery.stop();
    });
  });

  describe("recoverPartialProgressNoTaskDoneFailures", () => {
    it("requeues partial-progress no-task_done failures with bounded retry count", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-2164",
          column: "in-review",
          status: "failed",
          error: "Agent finished without calling task_done (after retry)",
          paused: false,
          steps: [{ status: "done" }, { status: "pending" }, { status: "pending" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverPartialProgressNoTaskDoneFailures();

      expect(result).toBe(1);
      expect(store.listTasks).toHaveBeenCalledWith({ column: "in-review", slim: true });
      expect(store.updateTask).toHaveBeenCalledWith("FN-2164", {
        status: null,
        error: null,
        sessionFile: null,
        taskDoneRetryCount: 1,
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-2164",
        expect.stringContaining("Auto-retry 1/3"),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-2164", "todo");

      managerWithRecovery.stop();
    });

    it("skips tasks whose retry count has reached the max", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-2164",
          column: "in-review",
          status: "failed",
          error: "Agent finished without calling task_done (after retry)",
          paused: false,
          taskDoneRetryCount: 3,
          steps: [{ status: "done" }, { status: "pending" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverPartialProgressNoTaskDoneFailures();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks where all steps are already done (handled by misclassified recovery)", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-2164",
          column: "in-review",
          status: "failed",
          error: "Agent finished without calling task_done (after retry)",
          paused: false,
          steps: [{ status: "done" }, { status: "done" }, { status: "skipped" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverPartialProgressNoTaskDoneFailures();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks with zero step progress (handled by no-progress recovery)", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-2164",
          column: "in-review",
          status: "failed",
          error: "Agent finished without calling task_done (after retry)",
          paused: false,
          steps: [{ status: "pending" }, { status: "pending" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverPartialProgressNoTaskDoneFailures();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks with unrelated failure reasons", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-2164",
          column: "in-review",
          status: "failed",
          error: "Workflow step failed",
          paused: false,
          steps: [{ status: "done" }, { status: "pending" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverPartialProgressNoTaskDoneFailures();

      expect(result).toBe(0);

      managerWithRecovery.stop();
    });
  });

  describe("recoverMergedReviewTasks", () => {
    it("finalizes stale merging tasks when a task commit already landed", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
      });
      const staleUpdatedAt = new Date(Date.now() - 61_000).toISOString();

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-1673",
          column: "in-review",
          status: "merging",
          error: null,
          paused: false,
          worktree: "/tmp/test-project/.worktrees/fn-1673",
          branch: "fusion/fn-1673",
          baseCommitSha: "base123",
          updatedAt: staleUpdatedAt,
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [],
          mergeDetails: undefined,
          log: [],
        },
      ]);
      mockedExistsSync.mockReturnValue(true);
      mockedExecSync.mockImplementation((command) => {
        const cmd = String(command);
        if (cmd.includes("git log")) {
          return "979ba2c04\u001ffeat(FN-1673): add editable AI suggestion drafts before acceptance\n" as any;
        }
        if (cmd.includes("git show --shortstat")) {
          return " 1 file changed, 2 insertions(+), 2 deletions(-)\n" as any;
        }
        return "" as any;
      });

      const result = await managerWithRecovery.recoverInterruptedMergingTasks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-1673", {
        status: null,
        error: null,
        mergeRetries: 0,
        mergeDetails: expect.objectContaining({
          commitSha: "979ba2c04",
          mergeCommitMessage: "feat(FN-1673): add editable AI suggestion drafts before acceptance",
          mergeConfirmed: true,
          filesChanged: 1,
          insertions: 2,
          deletions: 2,
        }),
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-1673", "done");
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-1673",
        expect.stringContaining("stale merge status finalized from landed commit 979ba2c"),
      );

      managerWithRecovery.stop();
    });

    it("finalizes stale merging tasks when baseCommitSha was advanced past the landed commit", async () => {
      // Reproduces the case where the merger fast-forward-rebased the task branch
      // and updated baseCommitSha to the new HEAD; the bounded `base..HEAD` range
      // is empty even though the merge commit is in HEAD's history.
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
      });
      const staleUpdatedAt = new Date(Date.now() - 61_000).toISOString();

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-2221",
          column: "in-review",
          status: "merging",
          error: null,
          paused: false,
          worktree: "/tmp/test-project/.worktrees/amber-lotus",
          branch: "fusion/fn-2221",
          baseCommitSha: "headsha0",
          updatedAt: staleUpdatedAt,
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [],
          mergeDetails: undefined,
          log: [],
        },
      ]);
      mockedExistsSync.mockReturnValue(true);
      mockedExecSync.mockImplementation((command) => {
        const cmd = String(command);
        if (cmd.includes("git log") && cmd.includes("headsha0..HEAD")) {
          return "" as any; // bounded range is empty (baseCommitSha === HEAD)
        }
        if (cmd.includes("git log") && cmd.includes("HEAD")) {
          return "3b212b928feat(FN-2221): constrain setup wizard modal shell\n" as any;
        }
        if (cmd.includes("git show --shortstat")) {
          return " 2 files changed, 154 insertions(+), 0 deletions(-)\n" as any;
        }
        return "" as any;
      });

      const result = await managerWithRecovery.recoverInterruptedMergingTasks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-2221", {
        status: null,
        error: null,
        mergeRetries: 0,
        mergeDetails: expect.objectContaining({
          commitSha: "3b212b928",
          mergeCommitMessage: "feat(FN-2221): constrain setup wizard modal shell",
          mergeConfirmed: true,
          filesChanged: 2,
          insertions: 154,
          deletions: 0,
        }),
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-2221", "done");
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-2221",
        expect.stringContaining("stale merge status finalized from landed commit 3b212b9"),
      );

      managerWithRecovery.stop();
    });

    it("clears stale merging status for retry when no landed commit is found", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
      });
      const staleUpdatedAt = new Date(Date.now() - 61_000).toISOString();

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-1674",
          column: "in-review",
          status: "merging",
          error: null,
          updatedAt: staleUpdatedAt,
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [],
          log: [],
        },
      ]);
      mockedExecSync.mockImplementation((command) => {
        if (String(command).includes("git log")) return "" as any;
        return "" as any;
      });

      const result = await managerWithRecovery.recoverInterruptedMergingTasks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-1674", {
        status: null,
        error: null,
      });
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-1674", "done");
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-1674",
        expect.stringContaining("stale merge status cleared"),
      );

      managerWithRecovery.stop();
    });

    it("does not recover fresh merging tasks before the stuck timeout", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-1675",
          column: "in-review",
          status: "merging",
          error: null,
          updatedAt: new Date().toISOString(),
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverInterruptedMergingTasks();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("does not recover stale merging tasks when stuck detection is disabled", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 0,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-1676",
          column: "in-review",
          status: "merging",
          error: null,
          updatedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverInterruptedMergingTasks();

      expect(result).toBe(0);
      expect(store.listTasks).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("merges eligible in-review tasks that still have an unmerged worktree", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-352",
          column: "in-review",
          paused: false,
          status: null,
          error: null,
          worktree: "/tmp/test-project/.worktrees/fn-352",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(result).toBe(1);
      expect(store.mergeTask).toHaveBeenCalledWith("FN-352");
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-352",
        expect.stringContaining("eligible in-review task was merged"),
      );

      managerWithRecovery.stop();
    });

    it("skips paused in-review tasks even when otherwise mergeable", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-352-paused",
          column: "in-review",
          paused: true,
          status: "paused",
          error: null,
          worktree: "/tmp/test-project/.worktrees/fn-352-paused",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(result).toBe(0);
      expect(store.mergeTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("ignores in-review tasks that are not yet mergeable", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-353",
          column: "in-review",
          paused: false,
          status: null,
          error: null,
          worktree: "/tmp/test-project/.worktrees/fn-353",
          steps: [{ name: "Ship it", status: "in-progress" }],
          workflowStepResults: [],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(result).toBe(0);
      expect(store.mergeTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("moves stale in-review tasks with incomplete steps back to todo for retry", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 1_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-1572",
          column: "in-review",
          paused: false,
          status: null,
          error: null,
          worktree: "/tmp/test-project/.worktrees/fn-1572",
          updatedAt: new Date(Date.now() - 5_000).toISOString(),
          steps: [
            { name: "Preflight", status: "done" },
            { name: "Testing & Verification", status: "in-progress" },
          ],
          workflowStepResults: [],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverStaleIncompleteReviewTasks();

      expect(result).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-1572",
        expect.stringContaining("in-review task still had incomplete steps"),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-1572", "todo");

      managerWithRecovery.stop();
    });

    it("does not move fresh in-review tasks with incomplete steps", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-1573",
          column: "in-review",
          paused: false,
          status: null,
          updatedAt: new Date().toISOString(),
          steps: [{ name: "Testing", status: "in-progress" }],
          workflowStepResults: [],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverStaleIncompleteReviewTasks();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("moves merged in-review tasks to done and clears transient merge state", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-350",
          column: "in-review",
          status: "failed",
          error: "Invalid transition: 'todo' → 'done'. Valid targets: in-progress, triage",
          mergeRetries: 3,
          mergeDetails: {
            mergeConfirmed: true,
            mergedAt: "2026-01-01T00:00:00.000Z",
          },
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergedReviewTasks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-350", {
        status: null,
        error: null,
        mergeRetries: 0,
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-350", "done");
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-350",
        expect.stringContaining("merge already confirmed"),
      );

      managerWithRecovery.stop();
    });

    it("ignores in-review tasks without confirmed merge metadata", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-351",
          column: "in-review",
          mergeDetails: {
            mergeConfirmed: false,
          },
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergedReviewTasks();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });
  });

  describe("recoverReviewTasksWithFailedPreMergeSteps", () => {
    const baseTask = {
      id: "FN-1572",
      column: "in-review" as const,
      paused: false,
      status: null as string | null,
      worktree: "/tmp/test-project/.worktrees/fn-1572",
      steps: [
        { name: "Preflight", status: "done" as const },
        { name: "Implementation", status: "done" as const },
      ],
      workflowStepResults: [
        {
          workflowStepId: "WS-004",
          workflowStepName: "Browser Verification",
          phase: "pre-merge" as const,
          status: "failed" as const,
          output: "SSE reconnect leaks /api/events connections when view toggles.",
          startedAt: "2026-04-17T21:08:24.135Z",
          completedAt: "2026-04-17T21:35:32.036Z",
        },
      ],
      postReviewFixCount: 0,
      log: [],
    };

    it("sends a review task back for fix when a pre-merge workflow step failed and budget remains", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverFailedPreMergeStep: recoverFn,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        maxPostReviewFixes: 1,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...baseTask }]);

      const result = await managerWithRecovery.recoverReviewTasksWithFailedPreMergeSteps();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-1572", { postReviewFixCount: 1 });
      expect(recoverFn).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-1572" }));
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-1572",
        expect.stringContaining("Auto-reviving in-review task"),
      );

      managerWithRecovery.stop();
    });

    it("skips tasks whose postReviewFixCount has reached maxPostReviewFixes", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverFailedPreMergeStep: recoverFn,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        maxPostReviewFixes: 2,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...baseTask, postReviewFixCount: 2 },
      ]);

      const result = await managerWithRecovery.recoverReviewTasksWithFailedPreMergeSteps();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("no-ops when recoverFailedPreMergeStep callback is not supplied", async () => {
      const managerWithoutCallback = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...baseTask }]);

      const result = await managerWithoutCallback.recoverReviewTasksWithFailedPreMergeSteps();

      expect(result).toBe(0);
      expect(store.listTasks).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithoutCallback.stop();
    });

    it("skips paused tasks", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverFailedPreMergeStep: recoverFn,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        maxPostReviewFixes: 1,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...baseTask, paused: true, status: "paused" },
      ]);

      const result = await managerWithRecovery.recoverReviewTasksWithFailedPreMergeSteps();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks without a worktree (cannot re-execute safely)", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverFailedPreMergeStep: recoverFn,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        maxPostReviewFixes: 1,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...baseTask, worktree: undefined },
      ]);

      const result = await managerWithRecovery.recoverReviewTasksWithFailedPreMergeSteps();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks already executing (avoid double-send-back while a run is in flight)", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverFailedPreMergeStep: recoverFn,
        getExecutingTaskIds: () => new Set(["FN-1572"]),
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        maxPostReviewFixes: 1,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...baseTask }]);

      const result = await managerWithRecovery.recoverReviewTasksWithFailedPreMergeSteps();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("leaves tasks with non-pre-merge blockers alone (e.g. incomplete steps)", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverFailedPreMergeStep: recoverFn,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        maxPostReviewFixes: 1,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          ...baseTask,
          // Task has a failed WS *and* an incomplete step — the "incomplete
          // steps" blocker wins in getTaskMergeBlocker, so this scan should
          // defer to recoverStaleIncompleteReviewTasks instead.
          steps: [
            { name: "Preflight", status: "done" as const },
            { name: "Implementation", status: "in-progress" as const },
          ],
        },
      ]);

      const result = await managerWithRecovery.recoverReviewTasksWithFailedPreMergeSteps();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("disables itself when maxPostReviewFixes is 0", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverFailedPreMergeStep: recoverFn,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        maxPostReviewFixes: 0,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...baseTask }]);

      const result = await managerWithRecovery.recoverReviewTasksWithFailedPreMergeSteps();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });
  });

  describe("recoverOrphanedExecutions", () => {
    it("requeues in-progress tasks whose reserved worktree is missing", async () => {
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-200",
          column: "in-progress",
          paused: false,
          worktree: undefined,
          steps: [{ status: "in-progress" }],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedExecutions();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-200", {
        status: "stuck-killed",
        worktree: null,
        branch: null,
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-200",
        "Auto-recovered orphaned executor task — missing worktree/session, moved back to todo",
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-200", "todo");

      managerWithRecovery.stop();
    });

    it("skips orphan recovery for actively executing tasks", async () => {
      const getExecuting = vi.fn().mockReturnValue(new Set(["FN-201"]));
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-201",
          column: "in-progress",
          paused: false,
          worktree: "/tmp/test-project/.worktrees/missing-tree",
          steps: [{ status: "in-progress" }],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedExecutions();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks that are already complete", async () => {
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-202",
          column: "in-progress",
          paused: false,
          worktree: "/tmp/test-project/.worktrees/missing-tree",
          steps: [{ status: "done" }],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedExecutions();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks still within the grace window", async () => {
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-203",
          column: "in-progress",
          paused: false,
          worktree: "/tmp/test-project/.worktrees/missing-tree",
          steps: [{ status: "in-progress" }],
          updatedAt: "2026-01-01T00:04:30.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedExecutions();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("recovers tasks with existing worktree but no active session after grace period", async () => {
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());
      const mockedExistsSync = vi.mocked(existsSync);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-210",
          column: "in-progress",
          paused: false,
          worktree: "/tmp/test-project/.worktrees/active-tree",
          steps: [{ status: "done" }, { status: "in-progress" }, { status: "pending" }],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      // Worktree directory exists on disk
      mockedExistsSync.mockImplementation((p) =>
        p === "/tmp/test-project/.worktrees/active-tree" ? true : false,
      );

      // 10 minutes past — well beyond the 5-minute grace period
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedExecutions();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-210", {
        status: "stuck-killed",
        worktree: null,
        branch: null,
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-210",
        expect.stringContaining("worktree exists but no active session"),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-210", "todo");

      managerWithRecovery.stop();
    });

    it("skips tasks with existing worktree within the extended grace period", async () => {
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());
      const mockedExistsSync = vi.mocked(existsSync);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-211",
          column: "in-progress",
          paused: false,
          worktree: "/tmp/test-project/.worktrees/active-tree",
          steps: [{ status: "in-progress" }],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      mockedExistsSync.mockImplementation((p) =>
        p === "/tmp/test-project/.worktrees/active-tree" ? true : false,
      );

      // Only 2 minutes past — within the 5-minute grace period for existing worktrees
      vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedExecutions();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });
  });

  describe("recoverApprovedTriageTasks", () => {
    it("recovers approved planning triage tasks that are not actively processing", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getPlanning = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverApprovedTriageTask: recoverFn,
        getPlanningTaskIds: getPlanning,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-100",
          column: "triage",
          status: "planning",
          paused: false,
          log: [
            { action: "Spec review requested" },
            { action: "Spec review: APPROVE" },
          ],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverApprovedTriageTasks();

      expect(result).toBe(1);
      expect(recoverFn).toHaveBeenCalledWith(
        expect.objectContaining({ id: "FN-100" }),
      );

      managerWithRecovery.stop();
    });

    it("skips tasks that are still actively being specified", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getPlanning = vi.fn().mockReturnValue(new Set(["FN-101"]));

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverApprovedTriageTask: recoverFn,
        getPlanningTaskIds: getPlanning,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-101",
          column: "triage",
          status: "planning",
          paused: false,
          log: [{ action: "Spec review: APPROVE" }],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverApprovedTriageTasks();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips planning triage tasks whose latest review is not APPROVE", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getPlanning = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverApprovedTriageTask: recoverFn,
        getPlanningTaskIds: getPlanning,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-102",
          column: "triage",
          status: "planning",
          paused: false,
          log: [
            { action: "Spec review: APPROVE" },
            { action: "Spec review requested" },
            { action: "Spec review: REVISE" },
          ],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverApprovedTriageTasks();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });
  });

  describe("recoverOrphanedPlanningTasks", () => {
    it("clears status for orphaned planning tasks without approval", async () => {
      const getPlanning = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getPlanningTaskIds: getPlanning,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-200",
          column: "triage",
          status: "planning",
          paused: false,
          log: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedPlanningTasks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-200", { status: null });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-200",
        "Auto-recovered orphaned planning task — agent session lost, cleared for re-planning",
      );

      managerWithRecovery.stop();
    });

    it("skips tasks that are still actively being specified", async () => {
      const getPlanning = vi.fn().mockReturnValue(new Set(["FN-201"]));

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getPlanningTaskIds: getPlanning,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-201",
          column: "triage",
          status: "planning",
          paused: false,
          log: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedPlanningTasks();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks that have an approved spec (handled by recoverApprovedTriageTasks)", async () => {
      const getPlanning = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getPlanningTaskIds: getPlanning,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-202",
          column: "triage",
          status: "planning",
          paused: false,
          log: [
            { action: "Spec review requested" },
            { action: "Spec review: APPROVE" },
          ],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedPlanningTasks();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips paused tasks", async () => {
      const getPlanning = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getPlanningTaskIds: getPlanning,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-203",
          column: "triage",
          status: "planning",
          paused: true,
          log: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedPlanningTasks();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips tasks within the grace period", async () => {
      const getPlanning = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getPlanningTaskIds: getPlanning,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-204",
          column: "triage",
          status: "planning",
          paused: false,
          log: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      // Only 30s later — within the 60s grace period
      vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));

      const result = await managerWithRecovery.recoverOrphanedPlanningTasks();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });
  });
});

describe("stale triage processing eviction before recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls evictStaleTriageProcessing before recoverApprovedTriageTasks", async () => {
    const store = createMockStore();
    const evictFn = vi.fn().mockReturnValue(new Set<string>());
    const recoverFn = vi.fn().mockResolvedValue(true);
    const getPlanning = vi.fn().mockReturnValue(new Set(["FN-100"]));

    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      recoverApprovedTriageTask: recoverFn,
      getPlanningTaskIds: getPlanning,
      evictStaleTriageProcessing: evictFn,
    });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-100",
        column: "triage",
        status: "planning",
        paused: false,
        log: [{ action: "Spec review: APPROVE" }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

    // FN-100 is in planningIds — would normally be skipped.
    // But evictStaleTriageProcessing was called first (even though it evicted nothing here).
    await manager.recoverApprovedTriageTasks();

    // Eviction was called before the recovery check
    expect(evictFn).toHaveBeenCalledTimes(1);

    manager.stop();
  });

  it("recovers approved task after eviction removes it from planningIds", async () => {
    const store = createMockStore();
    let planningIds = new Set(["FN-100"]);
    const evictFn = vi.fn().mockImplementation(() => {
      // Simulate eviction removing FN-100 from the processing set
      planningIds = new Set<string>();
      return new Set(["FN-100"]);
    });
    const recoverFn = vi.fn().mockResolvedValue(true);
    const getPlanning = vi.fn().mockImplementation(() => planningIds);

    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      recoverApprovedTriageTask: recoverFn,
      getPlanningTaskIds: getPlanning,
      evictStaleTriageProcessing: evictFn,
    });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-100",
        column: "triage",
        status: "planning",
        paused: false,
        log: [{ action: "Spec review: APPROVE" }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

    const result = await manager.recoverApprovedTriageTasks();

    // After eviction cleared the planning set, the task was recovered
    expect(result).toBe(1);
    expect(recoverFn).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-100" }),
    );

    manager.stop();
  });

  it("calls evictStaleTriageProcessing before recoverOrphanedPlanningTasks", async () => {
    const store = createMockStore();
    const evictFn = vi.fn().mockReturnValue(new Set<string>());
    const getPlanning = vi.fn().mockReturnValue(new Set(["FN-101"]));

    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getPlanningTaskIds: getPlanning,
      evictStaleTriageProcessing: evictFn,
    });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-101",
        column: "triage",
        status: "planning",
        paused: false,
        log: [{ action: "Spec review: REVISE" }],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

    await manager.recoverOrphanedPlanningTasks();

    expect(evictFn).toHaveBeenCalledTimes(1);

    manager.stop();
  });
});

// ── Maintenance cycle concurrency ──────────────────────────────────

describe("maintenance cycle concurrency", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        autoUnpauseEnabled: false,
        maintenanceIntervalMs: 0, // disable interval so we only test runMaintenance() directly
        maxWorktrees: 4,
      } as unknown as Settings),
      listTasks: vi.fn().mockResolvedValue([]),
      walCheckpoint: vi.fn().mockReturnValue({ busy: 0, log: 0, checkpointed: 0 }),
    });
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  it("skips cycle when already running", async () => {
    // Use a deferred to keep the first cycle "running" while we call runMaintenance again
    let resolvePrune: (value: number) => void;
    const prunePromise = new Promise<number>((resolve) => {
      resolvePrune = resolve;
    });

    const pruneSpy = (vi.spyOn(manager as any, "pruneWorktrees").mockImplementation(async () => {
      return prunePromise;
    }) as any);

    // Start first cycle — it will wait on prunePromise
    const firstCycleDone = (manager as any).runMaintenance();

    // Advance time so the first cycle proceeds and sets maintenanceRunning = true
    await vi.advanceTimersByTimeAsync(1);

    // Call runMaintenance again — should be skipped because maintenanceRunning is true
    (manager as any).runMaintenance();

    // Second cycle should be skipped (pruneWorktrees only called once)
    const pruneCallCount = pruneSpy.mock.calls.length;

    // Now resolve the first cycle
    resolvePrune!(0);
    await firstCycleDone;

    expect(pruneCallCount).toBe(1);
  });

  it("resets maintenanceRunning flag on error", async () => {
    const error = new Error("simulated failure");
    (vi.spyOn(manager as any, "pruneWorktrees").mockRejectedValue(error) as any);

    await (manager as any).runMaintenance();

    expect((manager as any).maintenanceRunning).toBe(false);
  });

  it("resets maintenanceRunning flag on success", async () => {
    (vi.spyOn(manager as any, "pruneWorktrees").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "cleanupOrphans").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "cleanupOrphanedBranches").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "enforceWorktreeCap").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverCompletedTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverStaleIncompleteReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverInterruptedMergingTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverMergeableReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverMergedReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverMisclassifiedFailures").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverNoProgressNoTaskDoneFailures").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverPartialProgressNoTaskDoneFailures").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverOrphanedExecutions").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverApprovedTriageTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverOrphanedPlanningTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "archiveStaleDoneTasks").mockResolvedValue(0) as any);

    await (manager as any).runMaintenance();

    expect((manager as any).maintenanceRunning).toBe(false);
  });

  it("runs batch 1 operations in sequence (with isolation — one failure doesn't block others)", async () => {
    let runningCount = 0;
    let maxConcurrent = 0;
    let executionOrder: string[] = [];

    const makeSlow = (label: string) =>
      (vi.spyOn(manager as any, label).mockImplementation(async () => {
        executionOrder.push(label);
        runningCount++;
        maxConcurrent = Math.max(maxConcurrent, runningCount);
        await vi.advanceTimersByTimeAsync(10);
        runningCount--;
        return 0;
      }) as any);

    makeSlow("pruneWorktrees");
    makeSlow("cleanupOrphans");
    makeSlow("cleanupOrphanedBranches");
    makeSlow("enforceWorktreeCap");
    // checkpointWal is synchronous, no need to mock

    await (manager as any).runMaintenance();

    // Operations run sequentially (one at a time), not in parallel.
    // This is intentional — each step is isolated so one failure doesn't
    // block or race with the others.
    expect(maxConcurrent).toBe(1);
    // All operations should have run
    expect(executionOrder).toContain("pruneWorktrees");
    expect(executionOrder).toContain("cleanupOrphans");
    expect(executionOrder).toContain("cleanupOrphanedBranches");
    expect(executionOrder).toContain("enforceWorktreeCap");
  });

  it("runs batch 2 operations in sequence (with isolation — one failure doesn't block others)", async () => {
    let runningCount = 0;
    let maxConcurrent = 0;
    let executionOrder: string[] = [];

    const makeSlow = (label: string) =>
      (vi.spyOn(manager as any, label).mockImplementation(async () => {
        executionOrder.push(label);
        runningCount++;
        maxConcurrent = Math.max(maxConcurrent, runningCount);
        await vi.advanceTimersByTimeAsync(10);
        runningCount--;
        return 0;
      }) as any);

    makeSlow("recoverCompletedTasks");
    makeSlow("recoverStaleIncompleteReviewTasks");
    makeSlow("recoverInterruptedMergingTasks");
    makeSlow("recoverMergeableReviewTasks");
    makeSlow("recoverMergedReviewTasks");
    makeSlow("recoverMisclassifiedFailures");
    makeSlow("recoverNoProgressNoTaskDoneFailures");
    makeSlow("recoverPartialProgressNoTaskDoneFailures");
    makeSlow("recoverOrphanedExecutions");
    makeSlow("recoverApprovedTriageTasks");
    makeSlow("recoverOrphanedPlanningTasks");

    await (manager as any).runMaintenance();

    // Operations run sequentially (one at a time), not in parallel.
    expect(maxConcurrent).toBe(1);
    // All operations should have run (including last one)
    expect(executionOrder[executionOrder.length - 1]).toBe("recoverOrphanedPlanningTasks");
  });

  it("one failing batch 2 operation does not abort the batch", async () => {
    const batch2Operations = [
      "recoverCompletedTasks",
      "recoverStaleIncompleteReviewTasks",
      "recoverInterruptedMergingTasks",
      "recoverMergeableReviewTasks",
      "recoverMergedReviewTasks",
      "recoverMisclassifiedFailures",
      "recoverNoProgressNoTaskDoneFailures",
      "recoverPartialProgressNoTaskDoneFailures",
      "recoverOrphanedExecutions",
      "recoverApprovedTriageTasks",
      "recoverOrphanedPlanningTasks",
    ] as const;

    // Make one operation fail
    (vi.spyOn(manager as any, "recoverCompletedTasks").mockRejectedValue(new Error("db error")) as any);

    // Make all others succeed
    for (const op of batch2Operations.slice(1)) {
      (vi.spyOn(manager as any, op as string).mockResolvedValue(0) as any);
    }

    // Mock batch 1 and 3 as well
    (vi.spyOn(manager as any, "pruneWorktrees").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "cleanupOrphans").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "cleanupOrphanedBranches").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "enforceWorktreeCap").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "archiveStaleDoneTasks").mockResolvedValue(0) as any);

    // Should not throw — Promise.allSettled handles failures
    await expect((manager as any).runMaintenance()).resolves.toBeUndefined();
  });
});
