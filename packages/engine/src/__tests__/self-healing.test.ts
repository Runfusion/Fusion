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
  // execFile mirrors exec: join argv into the command string so tests keep
  // programming outputs via execSyncFn(cmd) regardless of which API the
  // production code uses (the coordinator moved to argv-based execFile).
   
  const execFileFn: any = vi.fn((file: string, args: any, opts: any, cb: any) => {
    const argv = Array.isArray(args) ? args : [];
    const cmd = [file, ...argv].join(" ");
    const optsArg = Array.isArray(args) ? opts : args;
    const cbArg = Array.isArray(args) ? cb : opts;
    return execFn(cmd, optsArg, cbArg);
  });
   
  execFileFn[utilPromisify.custom] = (file: string, args?: any, opts?: any) =>
    (execFn[utilPromisify.custom] as any)([file, ...(Array.isArray(args) ? args : [])].join(" "), opts);
  return { execSync: execSyncFn, exec: execFn, execFile: execFileFn };
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
  // FN-4811: Must mirror the production `RemovalReason` const in worktree-backend.ts
  // exactly — every key referenced as `RemovalReason.X` in production code (self-healing,
  // executor, merger) needs to resolve here, otherwise removeWorktree({ reason: undefined })
  // gets passed through and the gate logic fails with confusing 'reason is undefined' errors.
  RemovalReason: {
    HardCancel: "hard-cancel",
    ExecutorTransientRetry: "executor-transient-retry",
    ExecutorStuckKilled: "executor-stuck-killed",
    ExecutorDispose: "executor-dispose",
    StepSessionCleanup: "step-session-cleanup",
    MergerPostMerge: "merger-post-merge",
    MergerCleanup: "merger-cleanup",
    SelfHealingReclaim: "self-healing-reclaim",
    SelfHealingStaleActiveBranch: "self-healing-stale-active-branch",
    SelfHealingBranchConflict: "self-healing-branch-conflict",
    SelfHealingIdleSweep: "self-healing-idle-sweep",
    PoolPrune: "pool-prune",
  },
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  scanOrphanedBranches: vi.fn().mockResolvedValue([]),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  isUsableTaskWorktree: vi.fn().mockResolvedValue(true),
  classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: false, classification: "missing", reason: "test-default" }),
  getRegisteredWorktreePaths: vi.fn().mockResolvedValue(new Set<string>()),
  getRegisteredWorktreeBranchMap: vi.fn().mockResolvedValue(new Map<string, string>()),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  resolveWorktreeBackend: vi.fn(),
}));

const { selfHealingLoggerMock } = vi.hoisted(() => ({
  selfHealingLoggerMock: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn((_name: string) => selfHealingLoggerMock),
  schedulerLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../merger.js", () => ({
  classifyOwnedLandedEvidence: vi.fn(),
}));

import { SelfHealingManager, isBranchAheadOfBase, MAX_AUTO_MERGE_RETRIES } from "../self-healing.js";
import type { TaskStore, Settings, Task, AgentStore, Agent, NotificationProvider } from "@fusion/core";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTaskWorktree, getRegisteredWorktreeBranchMap, getRegisteredWorktreePaths, isUsableTaskWorktree, removeWorktree, resolveWorktreeBackend, scanIdleWorktrees, scanOrphanedBranches } from "../worktree-pool.js";
import { activeSessionRegistry, executingTaskLock } from "../active-session-registry.js";
import * as branchConflictModule from "../branch-conflicts.js";
import { createLogger } from "../logger.js";
import { NotificationService } from "../notification/notification-service.js";
import { classifyOwnedLandedEvidence } from "../merger.js";

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedIsUsableTaskWorktree = vi.mocked(isUsableTaskWorktree);
const mockedClassifyTaskWorktree = vi.mocked(classifyTaskWorktree);
const mockedGetRegisteredWorktreePaths = vi.mocked(getRegisteredWorktreePaths);
const mockedGetRegisteredWorktreeBranchMap = vi.mocked(getRegisteredWorktreeBranchMap);
const mockedRemoveWorktree = vi.mocked(removeWorktree);
const mockedResolveWorktreeBackend = vi.mocked(resolveWorktreeBackend);
const mockedScanIdleWorktrees = vi.mocked(scanIdleWorktrees);
const mockedScanOrphanedBranches = vi.mocked(scanOrphanedBranches);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedCreateLogger = vi.mocked(createLogger);
const mockedClassifyOwnedLandedEvidence = vi.mocked(classifyOwnedLandedEvidence);

type MockLogger = {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function getSelfHealingLogger(): MockLogger {
  return selfHealingLoggerMock;
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
    handoffToReview: vi.fn().mockResolvedValue(undefined),
    enqueueMergeQueue: vi.fn().mockResolvedValue(undefined),
    mergeTask: vi.fn().mockResolvedValue(undefined),
    archiveTaskAndCleanup: vi.fn().mockResolvedValue({} as Task),
    walCheckpoint: vi.fn().mockReturnValue({ busy: 0, log: 5, checkpointed: 5 }),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue({ id: "FN-RESCUE", lineageId: "lin-rescue" }),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getRunAuditEvents: vi.fn().mockReturnValue([]),
    getBootstrappedAt: vi.fn().mockReturnValue(null),
    getRootDir: vi.fn().mockReturnValue("/tmp/test-project"),
    clearStaleExecutionStartBranchReferences: vi.fn().mockReturnValue([]),
    ...overrides,
  }) as unknown as TaskStore & EventEmitter;
  return store;
}

describe("SelfHealingManager", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
    store = createMockStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    mockedRemoveWorktree.mockResolvedValue(undefined);
    mockedClassifyTaskWorktree.mockResolvedValue({ ok: false, classification: "missing", reason: "test-default" });
    mockedGetRegisteredWorktreePaths.mockResolvedValue(new Set<string>());
    mockedGetRegisteredWorktreeBranchMap.mockResolvedValue(new Map<string, string>());
    mockedClassifyOwnedLandedEvidence.mockResolvedValue({ kind: "proven-no-op", baseRef: "main", ownDiffEmpty: true });
  });

  afterEach(() => {
    manager.stop();
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
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

    it("walks stuck kills from 0 to max+1 and terminalizes deterministically", async () => {
      let killCount = 0;
      (store.getTask as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        id: "FN-001",
        stuckKillCount: killCount,
      } as unknown as Task));
      (store.updateTask as ReturnType<typeof vi.fn>).mockImplementation(async (_taskId: string, patch: Partial<Task>) => {
        if (typeof patch.stuckKillCount === "number") killCount = patch.stuckKillCount;
      });

      manager.start();

      for (let i = 1; i <= 6; i++) {
        const result = await manager.checkStuckBudget("FN-001", "inactivity");
        expect(result).toBe(true);
        expect(killCount).toBe(i);
      }

      const terminal = await manager.checkStuckBudget("FN-001", "loop");
      expect(terminal).toBe(false);
      expect(killCount).toBe(7);
      expect(store.updateTask).toHaveBeenLastCalledWith("FN-001", {
        stuckKillCount: 7,
        status: "failed",
        error: "STUCK_LOOP_EXHAUSTED: stuck kill budget exhausted (7/6) after last reason=loop.",
      });
      expect(store.handoffToReview).toHaveBeenLastCalledWith("FN-001", expect.objectContaining({
        ownerAgentId: null,
        evidence: expect.objectContaining({ reason: "stuck-loop-exhausted", agentId: "self-healing" }),
      }));
      expect(store.logEntry).toHaveBeenLastCalledWith(
        "FN-001",
        "STUCK_LOOP_EXHAUSTED: stuck kill budget exhausted (7/6), last reason=loop. No further automatic retries will run. Manually retry, pause, or move the task to triage to resume work.",
      );
    });

    it("re-queues incomplete stuck-loop exhaustion in todo without review handoff", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-001",
        column: "in-progress",
        stuckKillCount: 6,
        steps: [
          { name: "Preflight", status: "done" },
          { name: "Delivery", status: "in-progress" },
        ],
      } as unknown as Task);

      manager.start();

      const result = await manager.checkStuckBudget("FN-001", "loop");

      expect(result).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { stuckKillCount: 7 });
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", {
        preserveProgress: true,
        preserveStatus: true,
        moveSource: "engine",
        recoveryRehome: true,
      });
      expect(store.updateTask).toHaveBeenLastCalledWith("FN-001", expect.objectContaining({
        stuckKillCount: 7,
        paused: false,
        userPaused: false,
        pausedReason: null,
        status: "queued",
      }));
      expect(store.handoffToReview).not.toHaveBeenCalled();
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "STUCK_LOOP_EXHAUSTED: incomplete task exhausted stuck kill budget (7/6), last reason=loop. Re-queued in todo with progress preserved; scheduler may retry without manual unpause.",
      );
    });

    it("falls back to executor requeue when todo parking fails", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-001",
        column: "in-progress",
        stuckKillCount: 6,
        steps: [
          { name: "Preflight", status: "done" },
          { name: "Delivery", status: "in-progress" },
        ],
      } as unknown as Task);
      (store.moveTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("database is busy"));

      manager.start();

      const result = await manager.checkStuckBudget("FN-001", "loop");

      expect(result).toBe(true);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { stuckKillCount: 7 });
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", {
        preserveProgress: true,
        preserveStatus: true,
        moveSource: "engine",
        recoveryRehome: true,
      });
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", expect.objectContaining({
        paused: false,
        userPaused: false,
        pausedReason: null,
        status: "queued",
      }));
      expect(store.handoffToReview).not.toHaveBeenCalled();
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "STUCK_LOOP_EXHAUSTED: incomplete task exhausted stuck kill budget (7/6), last reason=loop. Failed to move task to todo (database is busy); falling back to executor stuck-kill requeue.",
      );
    });

    it("logs post-move requeue patch failures without executor fallback", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-001",
        column: "in-progress",
        stuckKillCount: 6,
        steps: [
          { name: "Preflight", status: "done" },
          { name: "Delivery", status: "in-progress" },
        ],
      } as unknown as Task);
      (store.updateTask as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({} as Task)
        .mockRejectedValueOnce(new Error("write conflict"));

      manager.start();

      const result = await manager.checkStuckBudget("FN-001", "loop");

      expect(result).toBe(false);
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", {
        preserveProgress: true,
        preserveStatus: true,
        moveSource: "engine",
        recoveryRehome: true,
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "STUCK_LOOP_EXHAUSTED: incomplete task moved to todo with progress preserved, but post-move requeue patch failed (write conflict); scheduler retry may wait for the next state repair pass.",
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "STUCK_LOOP_EXHAUSTED: incomplete task exhausted stuck kill budget (7/6), last reason=loop. Re-queued in todo with progress preserved; scheduler may retry without manual unpause.",
      );
      expect(store.handoffToReview).not.toHaveBeenCalled();
    });

    it("terminalizes no-progress churn without incrementing stuck kill budget", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-001",
        lineageId: "lin-001",
        stuckKillCount: 3,
      } as unknown as Task);

      manager.start();

      const result = await manager.checkStuckBudget("FN-001", "no-progress-churn", {
        ignoredStepUpdateCount: 25,
      });

      expect(result).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
        status: "failed",
        error: "STUCK_NO_PROGRESS_CHURN: detected 25 ignored step-update rebuffs after compact-and-resume failed to recover progress. Task is likely too large; decompose via fn_task_create child tasks or rescope. No further automatic retries will run.",
      });
      expect(store.handoffToReview).toHaveBeenCalledWith("FN-001", expect.objectContaining({
        ownerAgentId: null,
        evidence: expect.objectContaining({ reason: "stuck-no-progress-churn", agentId: "self-healing" }),
      }));
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "STUCK_NO_PROGRESS_CHURN: detected 25 ignored step-update rebuffs after compact-and-resume failed to recover progress. No further automatic retries will run. Pause the task, manually decompose the work via fn_task_create child tasks, or move it to triage to rescope.",
      );
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        domain: "database",
        mutationType: "task:stuck-no-progress-churn-terminalized",
        target: "FN-001",
        metadata: expect.objectContaining({
          taskId: "FN-001",
          ignoredStepUpdateCount: 25,
          stuckKillStreak: 3,
          lastReason: "no-progress-churn",
        }),
      }));
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
      expect(store.updateTask).not.toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ error: expect.stringContaining("STUCK_LOOP_EXHAUSTED:") }),
      );
    });

    it("keeps task failed and logs warning when moveTask(in-review) fails at exhaustion", async () => {
      (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "FN-001",
        stuckKillCount: 6,
      } as unknown as Task);
      (store.handoffToReview as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("concurrent move"));

      manager.start();

      const result = await manager.checkStuckBudget("FN-001", "loop");

      expect(result).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
        stuckKillCount: 7,
        status: "failed",
        error: "STUCK_LOOP_EXHAUSTED: stuck kill budget exhausted (7/6) after last reason=loop.",
      });
      expect(getSelfHealingLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining("handoffTaskToReview failed (concurrent move)"),
      );
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
      vi.mocked(store.getSettings).mockResolvedValue({
        globalPause: false,
        enginePaused: false,
      } as unknown as Settings);
      const recoverNoProgressNoTaskDoneFailures = vi.spyOn(manager, "recoverNoProgressNoTaskDoneFailures").mockResolvedValue(1);
      const recoverCompletedTasks = vi.spyOn(manager, "recoverCompletedTasks").mockResolvedValue(1);
      const recoverStuckMergeDeadlocks = vi.spyOn(manager, "recoverStuckMergeDeadlocks").mockResolvedValue(1);
      const recoverMisclassifiedFailures = vi.spyOn(manager, "recoverMisclassifiedFailures").mockResolvedValue(1);
      const recoverPartialProgressNoTaskDoneFailures = vi.spyOn(manager, "recoverPartialProgressNoTaskDoneFailures").mockResolvedValue(1);
      const recoverOrphanedExecutions = vi.spyOn(manager, "recoverOrphanedExecutions").mockResolvedValue(1);
      const recoverApprovedTriageTasks = vi.spyOn(manager, "recoverApprovedTriageTasks").mockResolvedValue(1);
      const recoverOrphanedAgents = vi.spyOn(manager, "recoverOrphanedAgents").mockResolvedValue(1);
      const recoverAgentsRunningOnInactiveTasks = vi.spyOn(manager, "recoverAgentsRunningOnInactiveTasks").mockResolvedValue(1);
      const clearStaleBlockedBy = vi.spyOn(manager, "clearStaleBlockedBy").mockResolvedValue(1);
      const surfaceInReviewStalls = vi.spyOn(manager, "surfaceInReviewStalls").mockResolvedValue(1);
      const surfaceInReviewStalled = vi.spyOn(manager, "surfaceInReviewStalled").mockResolvedValue(1);
      const surfaceStalePausedReviews = vi.spyOn(manager, "surfaceStalePausedReviews").mockResolvedValue(1);
      const surfaceStalePausedTodos = vi.spyOn(manager, "surfaceStalePausedTodos").mockResolvedValue(1);

      await manager.runStartupRecovery();

      expect(recoverNoProgressNoTaskDoneFailures).toHaveBeenCalledTimes(1);
      expect(recoverCompletedTasks).toHaveBeenCalledTimes(1);
      expect(recoverStuckMergeDeadlocks).toHaveBeenCalledTimes(1);
      expect(recoverMisclassifiedFailures).toHaveBeenCalledTimes(1);
      expect(recoverPartialProgressNoTaskDoneFailures).toHaveBeenCalledTimes(1);
      expect(recoverOrphanedExecutions).toHaveBeenCalledTimes(1);
      expect(recoverApprovedTriageTasks).toHaveBeenCalledTimes(1);
      expect(recoverOrphanedAgents).toHaveBeenCalledTimes(1);
      expect(recoverAgentsRunningOnInactiveTasks).toHaveBeenCalledTimes(1);
      expect(clearStaleBlockedBy).toHaveBeenCalledTimes(1);
      expect(surfaceInReviewStalls).toHaveBeenCalledTimes(1);
      expect(surfaceInReviewStalled).toHaveBeenCalledTimes(1);
      expect(surfaceStalePausedReviews).toHaveBeenCalledTimes(1);
      expect(surfaceStalePausedTodos).toHaveBeenCalledTimes(1);
    });

    it("runStartupRecovery clears stale blockedBy rows", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({
        globalPause: false,
        enginePaused: false,
      } as unknown as Settings);
      vi.mocked(store.listTasks).mockResolvedValue([
        { id: "A", column: "todo", blockedBy: "B", paused: false, mergeRetries: 0, dependencies: [] } as unknown as Task,
        { id: "B", column: "done", blockedBy: null, paused: false, mergeRetries: 0, dependencies: [] } as unknown as Task,
      ]);

      await manager.runStartupRecovery();

      expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, overlapBlockedBy: null, status: null });
      expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("Auto-recovered (FN-5488): cleared stale blockedBy"));
    });

    it("runStartupRecovery skips while enginePaused is active", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({
        globalPause: false,
        enginePaused: true,
      } as unknown as Settings);
      const recoverCompletedTasks = vi.spyOn(manager, "recoverCompletedTasks").mockResolvedValue(1);

      await manager.runStartupRecovery();

      expect(recoverCompletedTasks).not.toHaveBeenCalled();
    });

    it("runStartupRecovery skips while globalPause is active", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({
        globalPause: true,
        enginePaused: false,
      } as unknown as Settings);
      vi.mocked(store.listTasks).mockResolvedValue([
        { id: "A", column: "todo", blockedBy: "B", paused: false, mergeRetries: 0, dependencies: [] } as unknown as Task,
        { id: "B", column: "done", blockedBy: null, paused: false, mergeRetries: 0, dependencies: [] } as unknown as Task,
      ]);

      await manager.runStartupRecovery();

      expect(store.updateTask).not.toHaveBeenCalledWith("A", { blockedBy: null, overlapBlockedBy: null, status: null });
    });
  });

  describe("recoverOrphanedAgents", () => {
    function createMockAgentStore(agents: Agent[]): AgentStore {
      return {
        listAgents: vi.fn().mockResolvedValue(agents),
        updateAgentState: vi.fn().mockResolvedValue(undefined),
        updateAgent: vi.fn().mockResolvedValue(undefined),
      } as unknown as AgentStore;
    }

    it("returns 0 when no agentStore", async () => {
      const result = await manager.recoverOrphanedAgents();
      expect(result).toBe(0);
    });

    it("skips agents with valid manager", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        { id: "manager-1", state: "active", updatedAt: new Date(now).toISOString() } as Agent,
        { id: "report-1", state: "error", reportsTo: "manager-1", updatedAt: new Date(now - 120_000).toISOString() } as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgent).not.toHaveBeenCalled();
      managerWithAgents.stop();
    });

    it("recovers orphaned agent in transient error state", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        {
          id: "orphan-1",
          state: "error",
          lastError: "socket hang up",
          metadata: {},
          updatedAt: new Date(now - 120_000).toISOString(),
        } as Agent,
      ]);
      const restartDurableAgentHeartbeat = vi.fn().mockResolvedValue(true);
      const managerWithAgents = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        agentStore,
        restartDurableAgentHeartbeat,
      });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(1);
      expect(agentStore.updateAgentState).toHaveBeenCalledWith("orphan-1", "active");
      expect(agentStore.updateAgent).toHaveBeenLastCalledWith("orphan-1", { lastError: undefined });
      expect(agentStore.updateAgent).toHaveBeenCalledWith(
        "orphan-1",
        expect.objectContaining({
          metadata: expect.objectContaining({
            durableErrorRecovery: expect.objectContaining({
              attempts: 1,
              exhausted: false,
              lastReason: "transient-error",
            }),
          }),
        }),
      );
      expect(restartDurableAgentHeartbeat).toHaveBeenCalledWith("orphan-1", { reason: "transient-error", attempt: 1 });
      managerWithAgents.stop();
    });

    it("skips agents within grace period", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        { id: "orphan-1", state: "error", lastError: "socket hang up", updatedAt: new Date(now - 10_000).toISOString() } as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgent).not.toHaveBeenCalled();
      managerWithAgents.stop();
    });

    it("skips non-transient/operator-actionable durable errors", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        { id: "agent-perm", state: "error", lastError: "invalid api key", updatedAt: new Date(now - 120_000).toISOString() } as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgentState).not.toHaveBeenCalled();
      managerWithAgents.stop();
    });

    it("suppresses stale worktree missing-module durable errors from transient auto-restart", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const warn = getSelfHealingLogger().warn;
      warn.mockClear();
      const now = Date.now();
      const missingPath = "/Users/me/Projects/kb/.worktrees/deleted/node_modules/@runfusion/fusion/dist/bin.js";
      const agentStore = createMockAgentStore([
        {
          id: "agent-stale-path",
          state: "error",
          lastError:
            `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${missingPath}' imported from /Users/me/Projects/kb/.worktrees/deleted/packages/engine/src/pi.ts`,
          updatedAt: new Date(now - 120_000).toISOString(),
        } as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgentState).not.toHaveBeenCalled();
      expect(agentStore.updateAgent).toHaveBeenCalledWith(
        "agent-stale-path",
        expect.objectContaining({
          metadata: expect.objectContaining({
            durableErrorRecovery: expect.objectContaining({
              lastReason: "stale-path-module-resolution",
              lastMissingModulePath: missingPath,
              consecutiveMissingModulePathCount: 1,
            }),
          }),
        }),
      );
      expect(getSelfHealingLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining("Suppressed durable-agent auto-restart for agent-stale-path: stale module-resolution"),
      );
      managerWithAgents.stop();
    });

    it("emits stronger stale-process hint when same missing-module path repeats 3 times", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const warn = getSelfHealingLogger().warn;
      warn.mockClear();
      const now = Date.now();
      const missingPath = "/Users/me/Projects/kb/.worktrees/deleted/node_modules/@runfusion/fusion/dist/bin.js";
      const agentStore = createMockAgentStore([
        {
          id: "agent-stale-repeat",
          state: "error",
          lastError:
            `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${missingPath}' imported from /Users/me/Projects/kb/.worktrees/deleted/packages/engine/src/pi.ts`,
          updatedAt: new Date(now - 120_000).toISOString(),
          metadata: {
            durableErrorRecovery: {
              lastMissingModulePath: missingPath,
              consecutiveMissingModulePathCount: 2,
            },
          },
        } as unknown as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgent).toHaveBeenCalledWith(
        "agent-stale-repeat",
        expect.objectContaining({
          metadata: expect.objectContaining({
            durableErrorRecovery: expect.objectContaining({
              lastMissingModulePath: missingPath,
              consecutiveMissingModulePathCount: 3,
            }),
          }),
        }),
      );
      expect(getSelfHealingLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining("FN-4013 tracks systemic prevention"),
      );
      managerWithAgents.stop();
    });

    it("resets stale missing-module consecutive count when a different path appears", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const oldPath = "/Users/me/Projects/kb/.worktrees/deleted-a/node_modules/@runfusion/fusion/dist/bin.js";
      const newPath = "/Users/me/Projects/kb/.worktrees/deleted-b/node_modules/@runfusion/fusion/dist/bin.js";
      const agentStore = createMockAgentStore([
        {
          id: "agent-stale-reset",
          state: "error",
          lastError:
            `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${newPath}' imported from /Users/me/Projects/kb/.worktrees/deleted-b/packages/engine/src/pi.ts`,
          updatedAt: new Date(now - 120_000).toISOString(),
          metadata: {
            durableErrorRecovery: {
              lastMissingModulePath: oldPath,
              consecutiveMissingModulePathCount: 2,
            },
          },
        } as unknown as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgent).toHaveBeenCalledWith(
        "agent-stale-reset",
        expect.objectContaining({
          metadata: expect.objectContaining({
            durableErrorRecovery: expect.objectContaining({
              lastMissingModulePath: newPath,
              consecutiveMissingModulePathCount: 1,
            }),
          }),
        }),
      );
      managerWithAgents.stop();
    });

    it("suppresses transient recovery while cooldown is active", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        {
          id: "agent-cooldown",
          state: "error",
          lastError: "socket hang up",
          updatedAt: new Date(now - 120_000).toISOString(),
          metadata: { durableErrorRecovery: { attempts: 2, nextRetryAt: new Date(now + 5 * 60_000).toISOString() } },
        } as unknown as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        agentStore,
      });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgent).not.toHaveBeenCalled();
      managerWithAgents.stop();
    });

    it("suppresses transient recovery when active agent execution is present", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        { id: "agent-active", state: "error", lastError: "socket hang up", updatedAt: new Date(now - 120_000).toISOString() } as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        agentStore,
        hasActiveAgentExecution: (agentId) => agentId === "agent-active",
      });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgentState).not.toHaveBeenCalled();
      managerWithAgents.stop();
    });

    it("suppresses transient recovery when retry budget is exhausted", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        {
          id: "agent-exhausted",
          state: "error",
          lastError: "socket hang up",
          updatedAt: new Date(now - 120_000).toISOString(),
          metadata: { durableErrorRecovery: { attempts: 4 } },
        } as unknown as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        agentStore,
      });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgentState).not.toHaveBeenCalled();
      expect(agentStore.updateAgent).toHaveBeenCalledWith(
        "agent-exhausted",
        expect.objectContaining({
          metadata: expect.objectContaining({
            durableErrorRecovery: expect.objectContaining({
              exhausted: true,
              lastReason: "retry-budget-exhausted",
            }),
          }),
        }),
      );
      managerWithAgents.stop();
    });

    it("skips ephemeral agents", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        {
          id: "ephemeral-1",
          name: "ephemeral-1",
          role: "executor",
          state: "error",
          createdAt: new Date(now - 240_000).toISOString(),
          updatedAt: new Date(now - 120_000).toISOString(),
          metadata: { agentKind: "task-worker" },
        } as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgent).not.toHaveBeenCalled();
      managerWithAgents.stop();
    });

    it("recovers agent whose manager was deleted", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        { id: "orphan-2", state: "running", reportsTo: "missing-manager", updatedAt: new Date(now - 120_000).toISOString() } as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(1);
      expect(agentStore.updateAgentState).toHaveBeenCalledWith("orphan-2", "active");
      expect(agentStore.updateAgent).toHaveBeenCalledWith("orphan-2", { lastError: undefined });
      managerWithAgents.stop();
    });

    it("ignores agents in healthy states", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        { id: "agent-a", state: "active", updatedAt: new Date(now - 120_000).toISOString() } as Agent,
        { id: "agent-b", state: "idle", updatedAt: new Date(now - 120_000).toISOString() } as Agent,
        { id: "agent-c", state: "paused", updatedAt: new Date(now - 120_000).toISOString() } as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgent).not.toHaveBeenCalled();
      managerWithAgents.stop();
    });

    it("runStartupRecovery includes orphaned agents step", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({
        globalPause: false,
        enginePaused: false,
      } as unknown as Settings);
      const recoverOrphanedAgents = vi.spyOn(manager, "recoverOrphanedAgents").mockResolvedValue(1);

      await manager.runStartupRecovery();

      expect(recoverOrphanedAgents).toHaveBeenCalledTimes(1);
    });
  });

  describe("recoverAgentsRunningOnInactiveTasks", () => {
    it("recovers durable running agents linked to todo tasks", async () => {
      const now = Date.now();
      const agents: Agent[] = [
        {
          id: "agent-recover",
          state: "running",
          taskId: "FN-TODO",
          updatedAt: new Date(now - 120_000).toISOString(),
        } as Agent,
        {
          id: "agent-keep",
          state: "running",
          taskId: "FN-IP",
          updatedAt: new Date(now - 120_000).toISOString(),
        } as Agent,
      ];

      const getTask = vi.fn(async (taskId: string) => {
        if (taskId === "FN-TODO") return { id: "FN-TODO", column: "todo" } as Task;
        if (taskId === "FN-IP") return { id: "FN-IP", column: "in-progress" } as Task;
        return null;
      });

      const agentStore = {
        listAgents: vi.fn(async () => agents),
        getActiveHeartbeatRun: vi.fn(async () => null),
        updateAgentState: vi.fn(async (agentId: string, state: Agent["state"]) => {
          const agent = agents.find((candidate) => candidate.id === agentId);
          if (agent) agent.state = state;
        }),
        syncExecutionTaskLink: vi.fn(async (agentId: string, taskId?: string) => {
          const agent = agents.find((candidate) => candidate.id === agentId);
          if (agent) agent.taskId = taskId;
        }),
      } as unknown as AgentStore;

      const managerWithAgents = new SelfHealingManager(
        createMockStore({ getTask }),
        { rootDir: "/tmp/test-project", agentStore },
      );

      const recovered = await managerWithAgents.recoverAgentsRunningOnInactiveTasks();

      expect(recovered).toBe(1);
      expect(agentStore.updateAgentState).toHaveBeenCalledWith("agent-recover", "active");
      expect(agentStore.syncExecutionTaskLink).toHaveBeenCalledWith("agent-recover", undefined);
      expect(agentStore.updateAgentState).not.toHaveBeenCalledWith("agent-keep", "active");
      managerWithAgents.stop();
    });
  });

  describe("recoverStaleHeartbeatRuns", () => {
    function createMockAgentStore(activeRuns: Array<{ id: string; agentId: string; startedAt: string; processPid?: number; status?: string }>): {
      store: AgentStore;
      ended: Array<{ runId: string; status: string }>;
      saved: Array<Partial<{ id: string; status: string; stderrExcerpt: string }>>;
    } {
      const ended: Array<{ runId: string; status: string }> = [];
      const saved: Array<Partial<{ id: string; status: string; stderrExcerpt: string }>> = [];
      const detailById = new Map<string, any>();
      for (const r of activeRuns) {
        detailById.set(r.id, { id: r.id, agentId: r.agentId, startedAt: r.startedAt, endedAt: null, status: r.status ?? "active", processPid: r.processPid });
      }
      const agentStore = {
        listActiveHeartbeatRuns: vi.fn().mockResolvedValue(
          activeRuns.map((r) => ({ id: r.id, agentId: r.agentId, startedAt: r.startedAt, endedAt: null, status: "active" as const, processPid: r.processPid })),
        ),
        getRunDetail: vi.fn().mockImplementation((_agentId: string, runId: string) => Promise.resolve(detailById.get(runId) ?? null)),
        saveRun: vi.fn().mockImplementation((run: any) => {
          saved.push({ id: run.id, status: run.status, stderrExcerpt: run.stderrExcerpt });
          return Promise.resolve();
        }),
        endHeartbeatRun: vi.fn().mockImplementation((runId: string, status: string) => {
          ended.push({ runId, status });
          return Promise.resolve();
        }),
      } as unknown as AgentStore;
      return { store: agentStore, ended, saved };
    }

    it("returns 0 when no agentStore is configured", async () => {
      const result = await manager.recoverStaleHeartbeatRuns();
      expect(result).toBe(0);
    });

    it("terminates active runs whose processPid does not match this process", async () => {
      const { store: agentStore, ended, saved } = createMockAgentStore([
        { id: "run-orphan", agentId: "agent-a", startedAt: new Date().toISOString(), processPid: 999_999 },
      ]);
      const m = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await m.recoverStaleHeartbeatRuns();

      expect(result).toBe(1);
      expect(ended).toEqual([{ runId: "run-orphan", status: "terminated" }]);
      expect(saved[0]?.status).toBe("terminated");
      expect(saved[0]?.stderrExcerpt).toMatch(/Auto-recovered orphaned heartbeat run/);
      m.stop();
    });

    it("leaves young runs from the current process alone", async () => {
      const { store: agentStore, ended } = createMockAgentStore([
        { id: "run-mine", agentId: "agent-b", startedAt: new Date().toISOString(), processPid: process.pid },
      ]);
      const m = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await m.recoverStaleHeartbeatRuns();

      expect(result).toBe(0);
      expect(ended).toEqual([]);
      m.stop();
    });

    it("terminates legacy active runs that have no recorded processPid", async () => {
      const { store: agentStore, ended } = createMockAgentStore([
        { id: "run-legacy", agentId: "agent-c", startedAt: new Date().toISOString() },
      ]);
      const m = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await m.recoverStaleHeartbeatRuns();

      expect(result).toBe(1);
      expect(ended[0]?.runId).toBe("run-legacy");
      m.stop();
    });

    it("terminates current-process runs that exceed the max-age threshold", async () => {
      const tooOld = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(); // 7h ago
      const { store: agentStore, ended } = createMockAgentStore([
        { id: "run-stuck", agentId: "agent-d", startedAt: tooOld, processPid: process.pid },
      ]);
      const m = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await m.recoverStaleHeartbeatRuns();

      expect(result).toBe(1);
      expect(ended[0]?.runId).toBe("run-stuck");
      m.stop();
    });

    it("runStartupRecovery includes the stale heartbeat runs step", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({
        globalPause: false,
        enginePaused: false,
      } as unknown as Settings);
      const spy = vi.spyOn(manager, "recoverStaleHeartbeatRuns").mockResolvedValue(0);

      await manager.runStartupRecovery();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    // Documents the race between recovery and a concurrent live startRun().
    // Sequence: recovery loads the stale row, then a fresh startRun() saves a
    // brand-new run for the same agent, then recovery calls endHeartbeatRun()
    // on the stale row. The new run must remain untouched — recovery must
    // only terminate the run id it sampled, never the agent's "any active
    // run." Otherwise we'd kill the very run we just spawned.
    it("only terminates the sampled run id even if a fresh run is started concurrently", async () => {
      const oldStarted = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
      const ended: Array<{ runId: string; status: string }> = [];
      const saved: Array<{ id: string; status: string }> = [];

      const agentStore = {
        listActiveHeartbeatRuns: vi.fn().mockResolvedValue([
          { id: "run-stale", agentId: "agent-x", startedAt: oldStarted, endedAt: null, status: "active", processPid: 999_999 },
        ]),
        // Simulate the live process spawning a NEW run after recovery sampled the stale one
        // but before it called endHeartbeatRun. getRunDetail still returns the stale row
        // because the new run has a different id.
        getRunDetail: vi.fn().mockImplementation((_agentId: string, runId: string) => {
          if (runId === "run-stale") {
            return Promise.resolve({ id: "run-stale", agentId: "agent-x", startedAt: oldStarted, endedAt: null, status: "active", processPid: 999_999 });
          }
          return Promise.resolve(null);
        }),
        saveRun: vi.fn().mockImplementation((run: any) => {
          saved.push({ id: run.id, status: run.status });
          return Promise.resolve();
        }),
        endHeartbeatRun: vi.fn().mockImplementation((runId: string, status: string) => {
          ended.push({ runId, status });
          return Promise.resolve();
        }),
      } as unknown as AgentStore;

      const m = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });
      const result = await m.recoverStaleHeartbeatRuns();

      expect(result).toBe(1);
      expect(ended).toEqual([{ runId: "run-stale", status: "terminated" }]);
      // The hypothetical concurrent run-fresh must not have been touched.
      expect(ended.some((e) => e.runId === "run-fresh")).toBe(false);
      expect(saved.every((s) => s.id === "run-stale")).toBe(true);
      m.stop();
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
          error: "Agent finished without calling fn_task_done (after retry)",
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
      expect(store.moveTask).toHaveBeenCalledWith("FN-1473", "todo", { moveSource: "engine", recoveryRehome: true });

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
          error: "Agent finished without calling fn_task_done (after retry)",
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
          error: "Agent finished without calling fn_task_done (after retry)",
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
      mockedRemoveWorktree.mockReset();
      mockedRemoveWorktree.mockRejectedValueOnce(new Error("cannot remove worktree"));

      await (manager as any).cleanupInterruptedMergeArtifacts(task);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to remove interrupted-merge worktree ${task.worktree} for ${task.id}: cannot remove worktree`,
        ),
      );

      mockedRemoveWorktree.mockClear();
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

  // ── Auto-archive ────────────────────────────────────────────────────

  describe("archiveStaleDoneTasks", () => {
    it("skips when auto-archive is disabled and doneAutoArchiveDays is 0", async () => {
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoArchiveDoneTasksEnabled: false,
        doneAutoArchiveDays: 0,
      } as unknown as Settings);

      const result = await manager.archiveStaleDoneTasks();

      expect(result).toBe(0);
      expect(store.listTasks).not.toHaveBeenCalled();
      expect(store.archiveTaskAndCleanup).not.toHaveBeenCalled();
    });

    it("archives stale done tasks with cleanup using the configured ms age when doneAutoArchiveDays is 0", async () => {
      vi.setSystemTime(new Date("2026-01-04T00:00:00.000Z"));
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoArchiveDoneTasksEnabled: true,
        autoArchiveDoneAfterMs: 24 * 60 * 60 * 1000,
        doneAutoArchiveDays: 0,
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

    it("uses doneAutoArchiveDays threshold and logs task age", async () => {
      vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoArchiveDoneTasksEnabled: true,
        autoArchiveDoneAfterMs: 48 * 60 * 60 * 1000,
        doneAutoArchiveDays: 30,
      } as unknown as Settings);
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-030",
          column: "done",
          columnMovedAt: "2026-01-29T00:00:00.000Z",
          updatedAt: "2026-01-29T00:00:00.000Z",
        },
        {
          id: "FN-031",
          column: "done",
          columnMovedAt: "2026-01-31T00:00:00.000Z",
          updatedAt: "2026-01-31T00:00:00.000Z",
        },
      ]);

      const result = await manager.archiveStaleDoneTasks();

      expect(result).toBe(1);
      expect(store.archiveTaskAndCleanup).toHaveBeenCalledWith("FN-030");
      expect(store.archiveTaskAndCleanup).not.toHaveBeenCalledWith("FN-031");
      expect(getSelfHealingLogger().log).toHaveBeenCalledWith(
        "auto-archive: archived FN-030 (age 31d, threshold 30d)",
      );
    });

    it("doneAutoArchiveDays takes precedence over autoArchiveDoneAfterMs", async () => {
      vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoArchiveDoneTasksEnabled: true,
        autoArchiveDoneAfterMs: 60 * 60 * 1000,
        doneAutoArchiveDays: 30,
      } as unknown as Settings);
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-AGE-29",
          column: "done",
          columnMovedAt: "2026-01-31T00:00:00.000Z",
          updatedAt: "2026-01-31T00:00:00.000Z",
        },
      ]);

      const result = await manager.archiveStaleDoneTasks();

      expect(result).toBe(0);
      expect(store.archiveTaskAndCleanup).not.toHaveBeenCalled();
    });

    it.each([
      { label: "negative", doneAutoArchiveDays: -1 },
      { label: "non-integer", doneAutoArchiveDays: 2.5 },
    ])("falls back to ms retention when doneAutoArchiveDays is $label", async ({ doneAutoArchiveDays }) => {
      vi.setSystemTime(new Date("2026-01-04T00:00:00.000Z"));
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoArchiveDoneTasksEnabled: true,
        autoArchiveDoneAfterMs: 24 * 60 * 60 * 1000,
        doneAutoArchiveDays,
      } as unknown as Settings);
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-FALLBACK",
          column: "done",
          columnMovedAt: "2026-01-02T23:59:00.000Z",
          updatedAt: "2026-01-02T23:59:00.000Z",
        },
      ]);

      const result = await manager.archiveStaleDoneTasks();

      expect(result).toBe(1);
      expect(store.archiveTaskAndCleanup).toHaveBeenCalledWith("FN-FALLBACK");
    });

    it("skips stale done tasks that have active dependents", async () => {
      vi.setSystemTime(new Date("2026-01-04T00:00:00.000Z"));
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoArchiveDoneTasksEnabled: true,
        autoArchiveDoneAfterMs: 24 * 60 * 60 * 1000,
      } as unknown as Settings);
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-100",
          column: "done",
          columnMovedAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          dependencies: [],
        },
        {
          id: "FN-101",
          column: "done",
          columnMovedAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          dependencies: [],
        },
        {
          id: "FN-200",
          column: "todo",
          dependencies: ["FN-100"],
        },
        {
          id: "FN-201",
          column: "done",
          columnMovedAt: "2026-01-03T23:00:00.000Z",
          updatedAt: "2026-01-03T23:00:00.000Z",
          dependencies: ["FN-101"],
        },
      ]);

      const result = await manager.archiveStaleDoneTasks();

      expect(result).toBe(1);
      expect(store.archiveTaskAndCleanup).toHaveBeenCalledWith("FN-101");
      expect(store.archiveTaskAndCleanup).not.toHaveBeenCalledWith("FN-100");
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

  describe("FN-5627: recoverTransientMergeFailures", () => {
    function setupTransientRecoveryStore(opts: {
      tasks: Array<Record<string, unknown>>;
      settings?: Record<string, unknown>;
    }): TaskStore & EventEmitter {
      const taskMap = new Map(opts.tasks.map((t) => [t.id as string, t]));
      return createMockStore({
        getSettings: vi.fn().mockResolvedValue({
          autoMerge: true,
          globalPause: false,
          enginePaused: false,
          ...(opts.settings ?? {}),
        } as unknown as Settings),
        listTasks: vi.fn().mockResolvedValue(opts.tasks),
        getTask: vi.fn((id: string) => Promise.resolve(taskMap.get(id) as Task | undefined)),
        updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
          const existing = taskMap.get(id) ?? {};
          const merged = { ...existing, ...updates };
          if (updates.mergeDetails !== undefined) {
            merged.mergeDetails = updates.mergeDetails;
          }
          taskMap.set(id, merged);
          return merged as Task;
        }),
      });
    }

    it("resets mergeRetries and re-enqueues lease-handoff-target-not-queued failures", async () => {
      const transientStore = setupTransientRecoveryStore({
        tasks: [
          {
            id: "FN-5628",
            column: "in-review",
            paused: false,
            status: "failed",
            mergeRetries: 3,
            error: "Merge handoff refused (lease-handoff-failed): target-not-queued",
            mergeDetails: undefined,
          },
        ],
      });
      const requeueForAutoMerge = vi.fn();
      const mgr = new SelfHealingManager(transientStore, {
        rootDir: "/tmp/test-project",
        requeueForAutoMerge,
      });

      const recovered = await mgr.recoverTransientMergeFailures();

      expect(recovered).toBe(1);
      expect(requeueForAutoMerge).toHaveBeenCalledWith("FN-5628");
      const updateCalls = (transientStore.updateTask as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[string, Partial<Task>]>;
      const recoveryCall = updateCalls.find((call) => call[0] === "FN-5628" && call[1].status === null);
      expect(recoveryCall).toBeDefined();
      expect(recoveryCall![1].mergeRetries).toBe(0);
      expect(recoveryCall![1].error).toBeNull();
      expect((recoveryCall![1] as { mergeDetails?: { transientRecoveryCount?: number } }).mergeDetails?.transientRecoveryCount).toBe(1);

      mgr.stop();
    });

    it("still re-enqueues when workflow recovery event publication fails", async () => {
      const transientStore = setupTransientRecoveryStore({
        tasks: [
          {
            id: "FN-5629",
            column: "in-review",
            paused: false,
            status: "failed",
            mergeRetries: 3,
            error: "Merge handoff refused (lease-handoff-failed): target-not-queued",
            mergeDetails: undefined,
          },
        ],
      });
      Object.assign(transientStore, {
        upsertWorkflowWorkItem: vi.fn(() => {
          throw new Error("terminal recovery item");
        }),
      });
      const requeueForAutoMerge = vi.fn();
      const mgr = new SelfHealingManager(transientStore, {
        rootDir: "/tmp/test-project",
        requeueForAutoMerge,
      });

      const recovered = await mgr.recoverTransientMergeFailures();

      expect(recovered).toBe(1);
      expect(requeueForAutoMerge).toHaveBeenCalledWith("FN-5629");
      mgr.stop();
    });

    it("recovers same-SHA spurious concurrent-advance failures (pre-FN-5627 legacy)", async () => {
      const transientStore = setupTransientRecoveryStore({
        tasks: [
          {
            id: "FN-5632",
            column: "in-review",
            paused: false,
            status: "failed",
            mergeRetries: 3,
            error: "Integration branch main advanced concurrently (expected 5b5da2c24fa006b46139ce4566b764126c6b84ca, observed 5b5da2c24fa006b46139ce4566b764126c6b84ca) while applying 283b290aec527f9ba4244f2935700a2823dd106b for FN-5632",
            mergeDetails: undefined,
          },
        ],
      });
      const requeueForAutoMerge = vi.fn();
      const mgr = new SelfHealingManager(transientStore, {
        rootDir: "/tmp/test-project",
        requeueForAutoMerge,
      });

      const recovered = await mgr.recoverTransientMergeFailures();

      expect(recovered).toBe(1);
      expect(requeueForAutoMerge).toHaveBeenCalledWith("FN-5632");
      mgr.stop();
    });

    it("does NOT recover genuine concurrent-advance failures (different SHAs)", async () => {
      const transientStore = setupTransientRecoveryStore({
        tasks: [
          {
            id: "FN-genuine",
            column: "in-review",
            paused: false,
            status: "failed",
            mergeRetries: 3,
            // Different SHAs — a real concurrent advance happened. Don't auto-recover.
            error: "Integration branch main advanced concurrently (expected aaa1111aaa1111aaa1111aaa1111aaa1111aaaa, observed bbb2222bbb2222bbb2222bbb2222bbb2222bbbb) while applying ccc3333ccc3333ccc3333ccc3333ccc3333cccc for FN-genuine",
          },
        ],
      });
      const requeueForAutoMerge = vi.fn();
      const mgr = new SelfHealingManager(transientStore, {
        rootDir: "/tmp/test-project",
        requeueForAutoMerge,
      });

      const recovered = await mgr.recoverTransientMergeFailures();

      expect(recovered).toBe(0);
      expect(requeueForAutoMerge).not.toHaveBeenCalled();
      mgr.stop();
    });

    it("does NOT recover non-transient merge failures (verification, conflict, etc.)", async () => {
      const transientStore = setupTransientRecoveryStore({
        tasks: [
          {
            id: "FN-verify",
            column: "in-review",
            paused: false,
            status: "failed",
            mergeRetries: 3,
            error: "Verification failed: pnpm test exit 1",
          },
        ],
      });
      const requeueForAutoMerge = vi.fn();
      const mgr = new SelfHealingManager(transientStore, {
        rootDir: "/tmp/test-project",
        requeueForAutoMerge,
      });

      const recovered = await mgr.recoverTransientMergeFailures();

      expect(recovered).toBe(0);
      expect(requeueForAutoMerge).not.toHaveBeenCalled();
      mgr.stop();
    });

    it("parks task as failed once budget is exhausted (transientRecoveryCount >= 2)", async () => {
      const transientStore = setupTransientRecoveryStore({
        tasks: [
          {
            id: "FN-exhausted",
            column: "in-review",
            paused: false,
            status: "failed",
            mergeRetries: 3,
            error: "Merge handoff refused (lease-handoff-failed): target-not-queued",
            mergeDetails: { transientRecoveryCount: 2 },
          },
        ],
      });
      const requeueForAutoMerge = vi.fn();
      const mgr = new SelfHealingManager(transientStore, {
        rootDir: "/tmp/test-project",
        requeueForAutoMerge,
      });

      const recovered = await mgr.recoverTransientMergeFailures();

      expect(recovered).toBe(0);
      expect(requeueForAutoMerge).not.toHaveBeenCalled();
      // updateTask called to add budget-exhausted marker to error
      const updateCalls = (transientStore.updateTask as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[string, Partial<Task>]>;
      const markerCall = updateCalls.find((call) => call[0] === "FN-exhausted" && typeof call[1].error === "string" && (call[1].error as string).includes("[transient-recovery-budget-exhausted]"));
      expect(markerCall).toBeDefined();
      mgr.stop();
    });

    it("is a no-op when autoMerge is disabled", async () => {
      const transientStore = setupTransientRecoveryStore({
        tasks: [
          {
            id: "FN-no-automerge",
            column: "in-review",
            paused: false,
            status: "failed",
            mergeRetries: 3,
            error: "Merge handoff refused (lease-handoff-failed): target-not-queued",
          },
        ],
        settings: { autoMerge: false },
      });
      const requeueForAutoMerge = vi.fn();
      const mgr = new SelfHealingManager(transientStore, {
        rootDir: "/tmp/test-project",
        requeueForAutoMerge,
      });

      const recovered = await mgr.recoverTransientMergeFailures();

      expect(recovered).toBe(0);
      expect(requeueForAutoMerge).not.toHaveBeenCalled();
      mgr.stop();
    });
  });

  describe("recoverStrandedCompletedTodoTasks", () => {
    it("promotes completed todo tasks and calls recover fn once per qualifying task", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverCompletedTask: recoverFn,
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-101",
          column: "todo",
          paused: false,
          error: null,
          reviewLevel: 2,
          steps: [{ status: "done" }, { status: "skipped" }],
        },
      ]);

      const result = await managerWithRecovery.recoverStrandedCompletedTodoTasks();

      expect(result).toBe(1);
      expect(store.listTasks).toHaveBeenCalledWith({ column: "todo", slim: true });
      expect(recoverFn).toHaveBeenCalledTimes(1);
      expect(recoverFn).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-101" }));

      managerWithRecovery.stop();
    });

    it("leaves incomplete/error/executing todo tasks untouched", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getExecuting = vi.fn().mockReturnValue(new Set<string>(["FN-105"]));

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverCompletedTask: recoverFn,
        getExecutingTaskIds: getExecuting,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-103",
          column: "todo",
          paused: false,
          error: null,
          steps: [{ status: "done" }, { status: "pending" }],
        },
        {
          id: "FN-104",
          column: "todo",
          paused: false,
          error: "failed earlier",
          steps: [{ status: "done" }],
        },
        {
          id: "FN-105",
          column: "todo",
          paused: false,
          error: null,
          steps: [{ status: "done" }],
        },
      ]);

      const result = await managerWithRecovery.recoverStrandedCompletedTodoTasks();

      expect(result).toBe(0);
      expect(recoverFn).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("recovers blockedBy todo tasks when all steps are complete", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverCompletedTask: recoverFn,
        getExecutingTaskIds: () => new Set<string>(),
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-106",
          column: "todo",
          paused: false,
          blockedBy: "FN-001",
          status: "queued",
          error: null,
          reviewLevel: 0,
          steps: [{ status: "done" }, { status: "done" }],
        },
      ]);

      const result = await managerWithRecovery.recoverStrandedCompletedTodoTasks();

      expect(result).toBe(1);
      expect(recoverFn).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-106" }));

      managerWithRecovery.stop();
    });
  });

  describe("recoverMissingWorktreeReviewFailures", () => {
    beforeEach(() => {
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false });
    });

    it("does not hard-code unusable-worktree assertion literals in self-healing", async () => {
      const source = await readFile(new URL("../self-healing.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/Refusing to start coding agent/);
    });

    it("requeues failed in-review tasks with unusable-worktree session-start errors", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-3900",
          column: "in-review",
          paused: false,
          status: "failed",
          worktree: "/tmp/project/.worktrees/fn-3900-stale",
          branch: "fusion/fn-3900",
          sessionFile: "/tmp/project/.fusion/sessions/fn-3900.json",
          error: "Refusing to start coding agent in missing worktree: /tmp/other/.worktrees/fn-3900",
          steps: [{ status: "done" }, { status: "pending" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMissingWorktreeReviewFailures();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-3900", {
        status: null,
        error: null,
        worktreeSessionRetryCount: 1,
        worktree: "/tmp/project/.worktrees/fn-3900-stale",
        branch: "fusion/fn-3900",
        sessionFile: null,
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-3900",
        expect.stringContaining("unusable worktree"),
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-3900",
        expect.stringContaining("/tmp/project/.worktrees/fn-3900-stale"),
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-3900",
        expect.stringContaining("session-start unusable-worktree assertion"),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-3900", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });

      managerWithRecovery.stop();
    });

    it("requeues incomplete-worktree failures and clears stale worktree metadata", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-4559",
          column: "in-review",
          paused: false,
          status: "failed",
          worktree: "/tmp/project/.worktrees/noble-eagle-stale",
          branch: "fusion/FN-4559",
          sessionFile: "/tmp/project/.fusion/sessions/FN-4559.json",
          error: "Refusing to start coding agent in incomplete worktree: /tmp/project/.worktrees/noble-eagle",
          steps: [{ status: "done" }, { status: "pending" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMissingWorktreeReviewFailures();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-4559", {
        status: null,
        error: null,
        worktreeSessionRetryCount: 1,
        worktree: "/tmp/project/.worktrees/noble-eagle-stale",
        branch: "fusion/FN-4559",
        sessionFile: null,
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-4559",
        expect.stringContaining("Auto-recovered"),
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-4559",
        expect.stringContaining("session-start unusable-worktree assertion"),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-4559", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });

      managerWithRecovery.stop();
    });

    it("requeues unregistered-worktree failures", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-4560",
          column: "in-review",
          paused: false,
          status: "failed",
          worktree: "/tmp/project/.worktrees/fn-4560",
          branch: "fusion/FN-4560",
          sessionFile: "/tmp/project/.fusion/sessions/FN-4560.json",
          error: "Refusing to start coding agent in unregistered git worktree: /tmp/project/.worktrees/fn-4560",
          steps: [{ status: "done" }, { status: "pending" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMissingWorktreeReviewFailures();

      expect(result).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-4560",
        expect.stringContaining("session-start unusable-worktree assertion"),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-4560", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });

      managerWithRecovery.stop();
    });

    it("requeues zero-progress unusable-worktree failures with cleared git/session metadata", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-4651",
          column: "in-review",
          paused: false,
          status: "failed",
          worktree: "/tmp/project/.worktrees/fn-4651",
          branch: "fusion/FN-4651",
          sessionFile: "/tmp/project/.fusion/sessions/FN-4651.json",
          error: "Refusing to start coding agent in missing worktree: /tmp/project/.worktrees/fn-4651",
          steps: [{ status: "pending" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMissingWorktreeReviewFailures();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-4651", {
        status: null,
        error: null,
        worktreeSessionRetryCount: 1,
        worktree: null,
        branch: null,
        sessionFile: null,
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-4651",
        expect.stringContaining("Auto-recovered (no-progress): session-start refused unusable worktree"),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-4651", "todo", { moveSource: "engine", recoveryRehome: true });

      managerWithRecovery.stop();
    });

    it("escalates when unusable-worktree retry cap is exhausted", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-4651-CAP",
          column: "in-review",
          paused: false,
          status: "failed",
          worktreeSessionRetryCount: 3,
          worktree: "/tmp/project/.worktrees/fn-4651-cap",
          branch: "fusion/FN-4651-CAP",
          sessionFile: "/tmp/project/.fusion/sessions/FN-4651-CAP.json",
          error: "Refusing to start coding agent in unregistered git worktree: /tmp/project/.worktrees/fn-4651-cap",
          steps: [{ status: "pending" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMissingWorktreeReviewFailures();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-4651-CAP",
        "Auto-recovery exhausted (3/3) for unusable-worktree session-start failure — leaving in-review for human inspection",
      );

      managerWithRecovery.stop();
    });

    it("does not requeue non-matching in-review failures", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-3901",
          column: "in-review",
          paused: false,
          status: "failed",
          error: "Deterministic test verification failed",
          steps: [{ status: "done" }, { status: "pending" }],
          log: [],
        },
        {
          id: "FN-3902",
          column: "in-review",
          paused: true,
          status: "failed",
          error: "Refusing to start coding agent in missing worktree: /tmp/project/.worktrees/fn-3902",
          steps: [{ status: "done" }, { status: "pending" }],
          log: [],
        },
        {
          id: "FN-3903",
          column: "in-review",
          paused: false,
          status: "queued",
          error: "Refusing to start coding agent in incomplete worktree: /tmp/project/.worktrees/fn-3903",
          steps: [{ status: "pending" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMissingWorktreeReviewFailures();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();

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
          error: "Agent finished without calling fn_task_done (after retry)",
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
          error: "Agent finished without calling fn_task_done (after retry)",
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

    it("does not clear errors on paused tasks (respects user investigate intent)", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-303",
          column: "in-review",
          status: "failed",
          paused: true,
          error: "Agent finished without calling fn_task_done",
          steps: [{ status: "done" }, { status: "done" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMisclassifiedFailures();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });
  });

  describe("recoverPartialProgressNoTaskDoneFailures", () => {
    beforeEach(() => {
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false });
    });

    it("requeues partial-progress no-task_done failures with bounded retry count", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-2164",
          column: "in-review",
          status: "failed",
          error: "Agent finished without calling fn_task_done (after retry)",
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
      expect(store.moveTask).toHaveBeenCalledWith("FN-2164", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });

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
          error: "Agent finished without calling fn_task_done (after retry)",
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
          error: "Agent finished without calling fn_task_done (after retry)",
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
          error: "Agent finished without calling fn_task_done (after retry)",
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
    beforeEach(() => {
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false, taskStuckTimeoutMs: 1_000 });
    });

    it("finalizes stale merging tasks when a task commit already landed", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
      });
      const staleUpdatedAt = new Date(Date.now() - 6 * 60_000).toISOString();

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

    it("finds landed commit via Fusion-Task-Id trailer when subject lacks the task ID", async () => {
      // includeTaskIdInCommit=false: commit subject is `feat: ...` with no
      // task ID. Recovery must locate the commit via the trailer in the body.
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
      });
      const staleUpdatedAt = new Date(Date.now() - 61_000).toISOString();

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-2900",
          column: "in-review",
          status: "merging",
          error: null,
          paused: false,
          worktree: "/tmp/test-project/.worktrees/fn-2900",
          branch: "fusion/fn-2900",
          baseCommitSha: "base999",
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
          // Recovery searches by trailer first; only the trailer-grep result
          // returns a match. Subject grep would be empty (no task ID in subj).
          if (cmd.includes("Fusion-Task-Id: FN-2900")) {
            return "trailerSha123feat: ship something opaque\n" as any;
          }
          // Ownership-verification body fetch (FN-5441/5446): the real commit
          // located via trailer grep carries the anchored trailer in its body,
          // so commitOwnedByTask accepts it though the subject lacks the task ID.
          if (cmd.includes("--format=%b") && cmd.includes("trailerSha123")) {
            return "Fusion-Task-Id: FN-2900\n" as any;
          }
          if (cmd.includes("--fixed-strings")) return "" as any;
        }
        if (cmd.includes("git show --shortstat")) {
          return " 2 files changed, 5 insertions(+), 1 deletion(-)\n" as any;
        }
        return "" as any;
      });

      const result = await managerWithRecovery.recoverInterruptedMergingTasks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-2900", {
        status: null,
        error: null,
        mergeRetries: 0,
        mergeDetails: expect.objectContaining({
          commitSha: "trailerSha123",
          mergeConfirmed: true,
        }),
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-2900", "done");

      managerWithRecovery.stop();
    });

    it("uses rebase range shortstat and propagates rebaseBaseSha when mergeDetails provides it", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
      });
      const staleUpdatedAt = new Date(Date.now() - 61_000).toISOString();

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-2901",
          column: "in-review",
          status: "merging",
          error: null,
          paused: false,
          worktree: "/tmp/test-project/.worktrees/fn-2901",
          branch: "fusion/fn-2901",
          baseCommitSha: "base901",
          updatedAt: staleUpdatedAt,
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [],
          mergeDetails: { rebaseBaseSha: "rebasebase901" },
          log: [],
        },
      ]);
      mockedExistsSync.mockReturnValue(true);
      mockedExecSync.mockImplementation((command) => {
        const cmd = String(command);
        if (cmd.includes("git log") && cmd.includes("Fusion-Task-Id: FN-2901")) {
          return "rangeSha901\u001ffeat: ship something opaque\n" as any;
        }
        // Ownership-verification body fetch (FN-5441/5446): real trailer-grep
        // hit carries the anchored trailer in its body.
        if (cmd.includes("git log") && cmd.includes("--format=%b") && cmd.includes("rangeSha901")) {
          return "Fusion-Task-Id: FN-2901\n" as any;
        }
        if (cmd.includes("git diff --shortstat") && cmd.includes("rebasebase901..rangeSha901")) {
          return " 4 files changed, 104 insertions(+), 1 deletion(-)\n" as any;
        }
        return "" as any;
      });

      const result = await managerWithRecovery.recoverInterruptedMergingTasks();

      expect(result).toBe(1);
      expect(mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes("git diff --shortstat") && String(cmd).includes("rebasebase901..rangeSha901"))).toBe(true);
      expect(mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes("git show --shortstat") && String(cmd).includes("rangeSha901"))).toBe(false);
      expect(store.updateTask).toHaveBeenCalledWith("FN-2901", {
        status: null,
        error: null,
        mergeRetries: 0,
        mergeDetails: expect.objectContaining({
          commitSha: "rangeSha901",
          rebaseBaseSha: "rebasebase901",
          filesChanged: 4,
          insertions: 104,
          deletions: 1,
        }),
      });

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

    it("does not recover paused merging tasks even when past the stuck timeout", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-1677",
          column: "in-review",
          status: "merging",
          paused: true,
          error: null,
          updatedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
          steps: [{ name: "Ship it", status: "done" }],
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

    it("clears stale merging statuses with no active merger", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        globalPause: false,
        enginePaused: false,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-3829-stale",
          column: "in-review",
          paused: false,
          status: "merging",
          updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverStaleMergingStatus();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-3829-stale", { status: null });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-3829-stale",
        expect.stringContaining("cleared stale 'merging' status"),
      );

      managerWithRecovery.stop();
    });

    it("FN-4084: stale merging recovery clears mergeActive via callback", async () => {
      const clearMergeActive = vi.fn();
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        clearMergeActive,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        globalPause: false,
        enginePaused: false,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-4084-stale",
          column: "in-review",
          paused: false,
          status: "merging-pr",
          updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverStaleMergingStatus();

      expect(result).toBe(1);
      expect(clearMergeActive).toHaveBeenCalledTimes(1);
      expect(clearMergeActive).toHaveBeenCalledWith("FN-4084-stale");

      managerWithRecovery.stop();
    });

    it("keeps transient merge status when task is actively merging", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getActiveMergeTaskId: () => "FN-3829-active",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        globalPause: false,
        enginePaused: false,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-3829-active",
          column: "in-review",
          paused: false,
          status: "merging-pr",
          updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverStaleMergingStatus();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-3829-active", { status: null });

      managerWithRecovery.stop();
    });

    it("keeps fresh transient merge status within the default age window", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        globalPause: false,
        enginePaused: false,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-3829-fresh",
          column: "in-review",
          paused: false,
          status: "merging",
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverStaleMergingStatus();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-3829-fresh", { status: null });

      managerWithRecovery.stop();
    });

    it("merges eligible in-review tasks that still have an unmerged worktree", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
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

    it("routes through enqueueMerge when wired so mergeStrategy is honored", async () => {
      const enqueueMerge = vi.fn().mockReturnValue(true);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        enqueueMerge,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-352-pr",
          column: "in-review",
          paused: false,
          status: null,
          error: null,
          worktree: "/tmp/test-project/.worktrees/fn-352-pr",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(result).toBe(1);
      expect(enqueueMerge).toHaveBeenCalledWith("FN-352-pr");
      expect(store.mergeTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("FN-4084: recoverMergeableReviewTasks escalates after repeated no-op re-enqueues", async () => {
      const enqueueMerge = vi.fn().mockReturnValue(false);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        enqueueMerge,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-4084-starved",
          column: "in-review",
          paused: false,
          status: null,
          error: null,
          mergeRetries: 0,
          worktree: "/tmp/test-project/.worktrees/fn-4084-starved",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      expect(await managerWithRecovery.recoverMergeableReviewTasks()).toBe(0);
      expect(await managerWithRecovery.recoverMergeableReviewTasks()).toBe(0);
      expect(await managerWithRecovery.recoverMergeableReviewTasks()).toBe(1);

      expect(enqueueMerge).toHaveBeenCalledTimes(3);
      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-4084-starved",
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("Auto-merge starvation: 3 consecutive enqueue attempts"),
        }),
      );
      expect(store.logEntry).toHaveBeenCalledTimes(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-4084-starved",
        expect.stringContaining("Auto-merge starvation"),
      );
      expect(store.logEntry).not.toHaveBeenCalledWith(
        "FN-4084-starved",
        expect.stringContaining("re-enqueued for merge"),
      );

      managerWithRecovery.stop();
    });

    it("FN-4084: recoverMergeableReviewTasks resets starvation counters after successful enqueue", async () => {
      const enqueueMerge = vi.fn().mockReturnValue(true);
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        enqueueMerge,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-4084-healthy",
          column: "in-review",
          paused: false,
          status: null,
          error: null,
          mergeRetries: 0,
          worktree: "/tmp/test-project/.worktrees/fn-4084-healthy",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      for (let i = 0; i < 5; i++) {
        expect(await managerWithRecovery.recoverMergeableReviewTasks()).toBe(1);
      }

      expect(enqueueMerge).toHaveBeenCalledTimes(5);
      expect(store.updateTask).not.toHaveBeenCalledWith(
        "FN-4084-healthy",
        expect.objectContaining({ status: "failed" }),
      );
      expect(store.logEntry).toHaveBeenCalledTimes(5);
      expect(store.logEntry).not.toHaveBeenCalledWith(
        "FN-4084-healthy",
        expect.stringContaining("Auto-merge starvation"),
      );

      managerWithRecovery.stop();
    });

    it("skips entirely when autoMerge is disabled (respects PR-based review flow)", async () => {
      const enqueueMerge = vi.fn();
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        enqueueMerge,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: false,
        globalPause: false,
        enginePaused: false,
      });

      const result = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(result).toBe(0);
      // The sweep may list tasks to discover per-task autoMerge overrides,
      // but must not merge or enqueue anything without one.
      expect(store.mergeTask).not.toHaveBeenCalled();
      expect(enqueueMerge).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips when globalPause or enginePaused is set", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: true,
        enginePaused: false,
      });

      const result = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(result).toBe(0);
      expect(store.listTasks).not.toHaveBeenCalled();
      expect(store.mergeTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips paused in-review tasks even when otherwise mergeable", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
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
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
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

    it("does not re-enqueue tasks already marked as merging", async () => {
      const enqueueMerge = vi.fn();
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        enqueueMerge,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-3829-merging",
          column: "in-review",
          paused: false,
          status: "merging",
          error: null,
          mergeRetries: 0,
          worktree: "/tmp/test-project/.worktrees/fn-3829-merging",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(result).toBe(0);
      expect(enqueueMerge).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalledWith(
        "FN-3829-merging",
        expect.stringContaining("re-enqueued for merge"),
      );

      managerWithRecovery.stop();
    });

    it("does not re-enqueue retry-exhausted review tasks", async () => {
      const enqueueMerge = vi.fn();
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        enqueueMerge,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-2997",
          column: "in-review",
          paused: false,
          status: null,
          error: null,
          mergeRetries: 3,
          worktree: "/tmp/test-project/.worktrees/fn-2997",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(result).toBe(0);
      expect(enqueueMerge).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalledWith(
        "FN-2997",
        expect.stringContaining("re-enqueued for merge"),
      );

      managerWithRecovery.stop();
    });

    it("does not re-enqueue review tasks carrying terminal invalid done-transition errors", async () => {
      const enqueueMerge = vi.fn();
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        enqueueMerge,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-3946",
          column: "in-review",
          paused: false,
          status: null,
          error: "Invalid transition: 'todo' → 'done'. Valid targets: in-progress, triage",
          mergeRetries: 0,
          worktree: "/tmp/test-project/.worktrees/fn-3946",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(result).toBe(0);
      expect(enqueueMerge).not.toHaveBeenCalled();
      expect(store.mergeTask).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("finalizes no-op in-review tasks with zero commits ahead (including review-level-0 coordination tasks)", async () => {
      const enqueueMerge = vi.fn();
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        enqueueMerge,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });
      mockedExecSync.mockImplementation((command) => {
        const cmd = String(command);
        if (cmd.includes("rev-parse --verify 'fusion/fn-500'")) return "ok" as any;
        if (cmd.includes("rev-parse --verify 'main'")) return "ok" as any;
        if (cmd.includes("rev-list --count 'main'..'fusion/fn-500'")) return "0\n" as any;
        return "" as any;
      });
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          {
            id: "FN-500",
            column: "in-review",
            paused: false,
            status: null,
            worktree: "/tmp/test-project/.worktrees/fn-500",
            reviewLevel: 0,
            steps: [{ name: "Ship it", status: "done" }],
            workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
            mergeDetails: undefined,
            log: [],
          },
        ])
        .mockResolvedValueOnce([
          {
            id: "FN-500",
            column: "in-review",
            paused: false,
            status: null,
            mergeRetries: 0,
            worktree: "/tmp/test-project/.worktrees/fn-500",
            reviewLevel: 0,
            steps: [{ name: "Ship it", status: "done" }],
            workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
            mergeDetails: { mergeConfirmed: true, noOpMerge: true },
            log: [],
          },
        ]);

      const finalized = await managerWithRecovery.finalizeNoOpReviewTasks();
      const recovered = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(finalized).toBe(1);
      expect(recovered).toBe(0);
      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-500",
        expect.objectContaining({
          mergeDetails: expect.objectContaining({
            mergeConfirmed: true,
            noOpMerge: true,
            noOpReason: expect.stringContaining("main"),
          }),
        }),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-500", "done");
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-500",
        expect.stringContaining("Auto-finalized no-op (proven): start point on main; modifiedFiles cleared"),
      );
      expect(enqueueMerge).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("blocks unproven no-op finalize candidates and emits audit", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });
      mockedClassifyOwnedLandedEvidence.mockResolvedValueOnce({
        kind: "unproven",
        reason: "foreign-start-point",
        details: { foreignRef: "fusion/fn-a" },
      } as any);
      mockedExecSync.mockImplementation((command) => {
        const cmd = String(command);
        if (cmd.includes("rev-parse --verify 'fusion/fn-501'")) return "ok" as any;
        if (cmd.includes("rev-parse --verify 'main'")) return "ok" as any;
        if (cmd.includes("rev-list --count 'main'..'fusion/fn-501'")) return "0\n" as any;
        return "" as any;
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-501",
          column: "in-review",
          paused: false,
          status: null,
          worktree: "/tmp/test-project/.worktrees/fn-501",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.finalizeNoOpReviewTasks();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-501", "done");
      expect(store.moveTask).toHaveBeenCalledWith("FN-501", "todo", expect.anything());
      expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "task:finalize-unproven-blocked",
        target: "FN-501",
      }));

      managerWithRecovery.stop();
    });

    it("does not finalize when branch is ahead by one or more commits", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });
      mockedExecSync.mockImplementation((command) => {
        const cmd = String(command);
        if (cmd.includes("rev-parse --verify 'fusion/fn-501'")) return "ok" as any;
        if (cmd.includes("rev-parse --verify 'main'")) return "ok" as any;
        if (cmd.includes("rev-list --count 'main'..'fusion/fn-501'")) return "3\n" as any;
        return "" as any;
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-501",
          column: "in-review",
          paused: false,
          status: null,
          worktree: "/tmp/test-project/.worktrees/fn-501",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.finalizeNoOpReviewTasks();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-501", "done");

      managerWithRecovery.stop();
    });

    it("skips finalize pass when autoMerge is disabled", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: false,
        globalPause: false,
        enginePaused: false,
      });

      const result = await managerWithRecovery.finalizeNoOpReviewTasks();

      expect(result).toBe(0);
      // The sweep may list tasks to discover per-task autoMerge overrides,
      // but must not finalize anything without one.
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("does not finalize no-op tasks when branch inspection errors", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });
      mockedExecSync.mockImplementation((command) => {
        const cmd = String(command);
        if (cmd.includes("rev-parse --verify 'fusion/fn-502'")) return "ok" as any;
        if (cmd.includes("rev-parse --verify 'main'")) return "ok" as any;
        if (cmd.includes("rev-list --count 'main'..'fusion/fn-502'")) {
          throw new Error("git failed");
        }
        return "" as any;
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-502",
          column: "in-review",
          paused: false,
          status: null,
          worktree: "/tmp/test-project/.worktrees/fn-502",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.finalizeNoOpReviewTasks();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-502", "done");
      expect(getSelfHealingLogger().warn).toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("does not re-enqueue tasks marked noOpMerge", async () => {
      const enqueueMerge = vi.fn();
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        enqueueMerge,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-503",
          column: "in-review",
          paused: false,
          status: null,
          mergeRetries: 0,
          worktree: "/tmp/test-project/.worktrees/fn-503",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: { noOpMerge: true },
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergeableReviewTasks();

      expect(result).toBe(0);
      expect(enqueueMerge).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalledWith(
        "FN-503",
        expect.stringContaining("re-enqueued"),
      );

      managerWithRecovery.stop();
    });

    it("resolves ahead count via origin fallback", async () => {
      mockedExecSync.mockImplementation((command) => {
        const cmd = String(command);
        if (cmd.includes("rev-parse --verify 'fusion/fn-999'")) return "ok" as any;
        if (cmd.includes("rev-parse --verify 'release'")) throw new Error("missing local");
        if (cmd.includes("rev-parse --verify 'origin/release'")) return "ok" as any;
        if (cmd.includes("rev-list --count 'origin/release'..'fusion/fn-999'")) return "0\n" as any;
        return "" as any;
      });

      const result = await isBranchAheadOfBase(
        { id: "FN-999", branch: "fusion/fn-999" } as Task,
        "/tmp/test-project",
        "release",
      );

      expect(result).toEqual({ aheadCount: 0, baseRef: "origin/release" });
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
      expect(store.moveTask).toHaveBeenCalledWith("FN-1572", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });

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

    it("detects stale in-review task using columnMovedAt when available", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ taskStuckTimeoutMs: 60_000 });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-407-test-1",
          column: "in-review",
          paused: false,
          status: null,
          columnMovedAt: new Date(Date.now() - 120_000).toISOString(),
          updatedAt: new Date(Date.now() - 5_000).toISOString(),
          steps: [
            { name: "Step 0", status: "done" },
            { name: "Step 1", status: "in-progress" },
          ],
          workflowStepResults: [],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverStaleIncompleteReviewTasks();

      expect(result).toBe(1);
      expect(store.moveTask).toHaveBeenCalledWith("FN-407-test-1", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });

      managerWithRecovery.stop();
    });

    it("falls back to updatedAt for staleness when columnMovedAt is null (legacy tasks)", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ taskStuckTimeoutMs: 60_000 });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-407-test-2",
          column: "in-review",
          paused: false,
          status: null,
          columnMovedAt: null,
          updatedAt: new Date(Date.now() - 120_000).toISOString(),
          steps: [{ name: "Step 0", status: "in-progress" }],
          workflowStepResults: [],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverStaleIncompleteReviewTasks();

      expect(result).toBe(1);
      expect(store.moveTask).toHaveBeenCalledWith("FN-407-test-2", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });

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
        paused: false,
        status: null,
        error: null,
        mergeRetries: 0,
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-350", "done");
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-350",
        expect.stringContaining("Auto-finalized from in-review/paused: content proven"),
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

    it("auto-finalizes paused merged tasks by clearing soft blocker state", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-352",
          column: "in-review",
          paused: true,
          mergeDetails: {
            mergeConfirmed: true,
            mergedAt: "2026-01-01T00:00:00.000Z",
          },
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergedReviewTasks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-352", {
        paused: false,
        status: null,
        error: null,
        mergeRetries: 0,
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-352", "done");

      managerWithRecovery.stop();
    });

    it("parks merge-confirmed tasks when finalization is blocked by incomplete steps", async () => {
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
          mergeDetails: {
            mergeConfirmed: true,
            mergedAt: "2026-01-01T00:00:00.000Z",
          },
          steps: [{ status: "in-progress" }],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergedReviewTasks();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-353", "done");
      expect(store.updateTask).toHaveBeenCalledWith("FN-353", {
        status: "failed",
        error: "Merge confirmed but finalization blocked: task has incomplete steps",
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-353",
        expect.stringContaining("finalization blocked"),
      );

      managerWithRecovery.stop();
    });

    it("auto-finalizes merge-confirmed tasks with stale transient merging status", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-354",
          column: "in-review",
          paused: false,
          status: "merging",
          error: "stale transient merge state",
          mergeDetails: {
            mergeConfirmed: true,
            mergedAt: "2026-01-01T00:00:00.000Z",
          },
          steps: [{ status: "done" }],
          workflowStepResults: [],
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverMergedReviewTasks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-354", {
        paused: false,
        status: null,
        error: null,
        mergeRetries: 0,
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-354", "done");

      managerWithRecovery.stop();
    });
  });

  describe("recoverStuckMergeDeadlocks", () => {
    const baseSettings = { globalPause: false, enginePaused: false, defaultBaseBranch: "main" } as unknown as Settings;

    it("recovers phantom-merged deadlocks, moves task to done, and clears blocked dependents", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(baseSettings);
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { id: "FN-stuck", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt", branch: "fusion/fn-stuck", baseBranch: "main", prInfo: { number: 77 }, log: [] },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "FN-dep", column: "todo", blockedBy: "FN-stuck", log: [] }])
        .mockResolvedValueOnce([]);
      mockedExecSync.mockImplementation((command: string | Buffer) => {
        const cmd = String(command);
        if (cmd.includes("Fusion-Task-Id: FN-stuck")) return "abc12345\x1fRecovered subject\n" as any;
        // FN-5441 ownership verification: post-grep body fetch must contain
        // the anchored trailer so commitOwnedByTask accepts the candidate.
        if (cmd.includes("--format=%b") && cmd.includes("abc12345")) return "Fusion-Task-Id: FN-stuck\n" as any;
        if (cmd.includes("--shortstat")) return " 2 files changed, 3 insertions(+), 1 deletions(-)\n" as any;
        return "" as any;
      });

      const result = await managerWithRecovery.recoverStuckMergeDeadlocks();

      expect(result).toBe(1);
      expect(store.moveTask).toHaveBeenCalledWith("FN-stuck", "done");
      expect(store.updateTask).toHaveBeenCalledWith("FN-stuck", expect.objectContaining({
        status: null,
        error: null,
        mergeRetries: 0,
        worktree: null,
        branch: null,
        mergeDetails: expect.objectContaining({ commitSha: "abc12345", mergeConfirmed: true }),
      }));
      expect(store.updateTask).toHaveBeenCalledWith("FN-dep", { blockedBy: null });
      expect(mockedRemoveWorktree).toHaveBeenCalledWith(expect.objectContaining({
        rootDir: "/tmp/test-project",
        worktreePath: "/tmp/wt",
      }));
      expect(getSelfHealingLogger().log).toHaveBeenCalledWith(expect.stringContaining("self-heal:deadlock-recovered"));

      managerWithRecovery.stop();
    });

    it("pauses genuine failures and leaves blockedBy untouched", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(baseSettings);
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: "FN-stuck", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt", log: [] }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "FN-dep", column: "todo", blockedBy: "FN-stuck", log: [] }])
        .mockResolvedValueOnce([]);
      mockedExecSync.mockReturnValue("" as any);

      const result = await managerWithRecovery.recoverStuckMergeDeadlocks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-stuck", { paused: true });
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-dep", { blockedBy: null });
      expect(getSelfHealingLogger().warn).toHaveBeenCalledWith(expect.stringContaining("paused-for-manual"));

      managerWithRecovery.stop();
    });

    it("is idempotent and cooldown-gated", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(baseSettings);
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: "FN-stuck", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt", log: [] }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "FN-stuck", column: "done", paused: false, status: null, mergeRetries: 0, mergeDetails: { mergeConfirmed: true }, log: [] }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockedExecSync.mockImplementation((command: string | Buffer) => String(command).includes("Fusion-Task-Id: FN-stuck") ? ("abc12345\x1fRecovered subject\n" as any) : ("" as any));

      const first = await managerWithRecovery.recoverStuckMergeDeadlocks();
      const second = await managerWithRecovery.recoverStuckMergeDeadlocks();

      expect(first).toBe(1);
      expect(second).toBe(0);

      managerWithRecovery.stop();
    });

    it("enforces cooldown for repeated genuine-failure sweeps", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(baseSettings);
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ id: "FN-cool", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt", log: [] }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "FN-cool", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt", log: [] }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockedExecSync.mockReturnValue("" as any);

      const first = await managerWithRecovery.recoverStuckMergeDeadlocks();
      const updateCallsAfterFirst = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls.length;
      const second = await managerWithRecovery.recoverStuckMergeDeadlocks();

      expect(first).toBe(1);
      expect(second).toBe(0);
      expect((store.updateTask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(updateCallsAfterFirst);

      managerWithRecovery.stop();
    });

    it("short-circuits when globalPause or enginePaused is active", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      mockedExecSync.mockClear();
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: true, enginePaused: false });
      expect(await managerWithRecovery.recoverStuckMergeDeadlocks()).toBe(0);
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: false, enginePaused: true });
      expect(await managerWithRecovery.recoverStuckMergeDeadlocks()).toBe(0);
      expect(store.listTasks).not.toHaveBeenCalled();
      expect(mockedExecSync).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("isolates per-task errors and continues with other stuck tasks", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(baseSettings);
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { id: "FN-err", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt1", log: [] },
          { id: "FN-ok", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt2", log: [] },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockedExecSync.mockImplementation((command: string | Buffer) => {
        const cmd = String(command);
        if (cmd.includes("Fusion-Task-Id: FN-ok")) return "def67890\x1fok\n" as any;
        if (cmd.includes("Fusion-Task-Id: FN-err")) return "abcabc12\x1ferr\n" as any;
        return "" as any;
      });
      (store.updateTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
        if (id === "FN-err") throw new Error("update failed");
        return {} as Task;
      });

      const result = await managerWithRecovery.recoverStuckMergeDeadlocks();

      expect(result).toBe(1);
      expect(getSelfHealingLogger().warn).toHaveBeenCalledWith(expect.stringContaining("self-heal:deadlock-recovery-error"));
      expect((managerWithRecovery as any).deadlockRecoveryCooldown.get("FN-err")).toBeTypeOf("number");

      managerWithRecovery.stop();
    });

    // FN-5441/FN-5446 regression: a deadlock-recovery sweep mis-attributed
    // both to e3dbfaae, an FN-5483 commit whose body merely *mentioned* them
    // by name. findLandedTaskCommit step (4) used `git log --grep=FN-XXXX`
    // which matches the entire commit message (not just subject) and the
    // previous code blindly accepted the first hit. The fix anchors ownership
    // on trailer/subject so prose mentions can never claim a task.
    it("FN-5441/FN-5446: does not attribute to a commit that only mentions the task ID in prose", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(baseSettings);
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { id: "FN-5441", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt-a", log: [] },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockedExecSync.mockImplementation((command: string | Buffer) => {
        const cmd = String(command);
        // grep step finds the unrelated FN-5483 commit whose body mentions FN-5441 in prose
        if (cmd.includes("FN-5441") && cmd.includes("--grep")) return "e3dbfaae\x1ffix(FN-5483): allow merger commits past identity-guard\n" as any;
        // ownership-verification body fetch returns prose-mention body, no anchored trailer
        if (cmd.includes("--format=%b") && cmd.includes("e3dbfaae")) {
          return "The refusal surfaced as merge-deadlock-detected on FN-5441 and FN-5446. ...\n" as any;
        }
        return "" as any;
      });

      const result = await managerWithRecovery.recoverStuckMergeDeadlocks();

      // No attribution → no recovery → no move to done.
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-5441", "done");
      // result of 0 OR a "paused-for-manual" path (proof gate) is acceptable;
      // the load-bearing assertion is that we did NOT advance the task to done
      // against the wrong commit.
      expect(result).toBeLessThanOrEqual(1);
      const updateCalls = (store.updateTask as ReturnType<typeof vi.fn>).mock.calls;
      const movedToDone = updateCalls.some(([id, patch]) =>
        id === "FN-5441" && (patch as any)?.mergeDetails?.commitSha === "e3dbfaae",
      );
      expect(movedToDone).toBe(false);

      managerWithRecovery.stop();
    });

    it("recovers worktree-only orphans and reproduces three-task incident", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(baseSettings);
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { id: "FN-3794", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt-a", log: [] },
          { id: "FN-3814", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt-b", log: [] },
          { id: "FN-3829", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt-c", log: [] },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "FN-3842", column: "todo", blockedBy: "FN-3794", log: [] }])
        .mockResolvedValueOnce([]);
      mockedExecSync.mockImplementation((command: string | Buffer) => {
        const cmd = String(command);
        if (cmd.includes("Fusion-Task-Id: FN-3794")) return "278a2825\x1fone\n" as any;
        if (cmd.includes("Fusion-Task-Id: FN-3814")) return "69c25e2b\x1ftwo\n" as any;
        if (cmd.includes("Fusion-Task-Id: FN-3829")) return "0d3f51b6\x1fthree\n" as any;
        // FN-5441 ownership verification: post-grep body fetch must contain
        // the anchored trailer so commitOwnedByTask accepts each candidate.
        if (cmd.includes("--format=%b") && cmd.includes("278a2825")) return "Fusion-Task-Id: FN-3794\n" as any;
        if (cmd.includes("--format=%b") && cmd.includes("69c25e2b")) return "Fusion-Task-Id: FN-3814\n" as any;
        if (cmd.includes("--format=%b") && cmd.includes("0d3f51b6")) return "Fusion-Task-Id: FN-3829\n" as any;
        return "" as any;
      });

      const result = await managerWithRecovery.recoverStuckMergeDeadlocks();

      expect(result).toBe(3);
      expect(store.updateTask).toHaveBeenCalledWith("FN-3842", { blockedBy: null });

      managerWithRecovery.stop();
    });
  });

  describe("recoverAlreadyMergedReviewTasks", () => {
    it("short-circuits when globalPause or enginePaused is active", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: true, enginePaused: false });

      const pausedResult = await managerWithRecovery.recoverAlreadyMergedReviewTasks();
      expect(pausedResult).toBe(0);
      expect(store.listTasks).not.toHaveBeenCalled();

      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: false, enginePaused: true });
      const enginePausedResult = await managerWithRecovery.recoverAlreadyMergedReviewTasks();
      expect(enginePausedResult).toBe(0);
      expect(store.listTasks).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("filters out non-candidates but still evaluates paused failed candidates", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: () => new Set(["FN-executing"]),
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: false, enginePaused: false });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-ok-status", column: "in-review", paused: false, status: null, mergeRetries: 3, mergeDetails: undefined, log: [] },
        { id: "FN-low-retries", column: "in-review", paused: false, status: "failed", mergeRetries: 2, mergeDetails: undefined, log: [] },
        { id: "FN-paused", column: "in-review", paused: true, status: "failed", mergeRetries: 3, mergeDetails: undefined, log: [] },
        { id: "FN-executing", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, log: [] },
        { id: "FN-confirmed", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: { mergeConfirmed: true }, log: [] },
      ]);
      mockedExecSync.mockImplementation(() => "" as any);

      const result = await managerWithRecovery.recoverAlreadyMergedReviewTasks();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("Fusion-Task-Id: FN-paused"),
        expect.any(Object),
      );

      managerWithRecovery.stop();
    });

    it("leaves tasks untouched when no landed commit is detected", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: false, enginePaused: false });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-1", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, branch: "fusion/fn-1", log: [] },
      ]);
      mockedExecSync.mockImplementation(() => {
        throw new Error("missing branch");
      });

      const result = await managerWithRecovery.recoverAlreadyMergedReviewTasks();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("suppresses transient failed notification when already-merged sweep recovers to done", async () => {
      const now = new Date().toISOString();
      const tasks = new Map<string, Task>([["FN-1", { id: "FN-1", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, baseBranch: "main", branch: "fusion/fn-1", worktree: "/tmp/wt", dependencies: [], steps: [], currentStep: 0, description: "x", log: [], createdAt: now, updatedAt: now } as Task]]);
      const eventedStore = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, ntfyEnabled: true, ntfyTopic: "topic", failureNotificationMode: "sticky-only", failureNotificationDelayMs: 50 }),
        listTasks: vi.fn().mockImplementation(async () => Array.from(tasks.values())),
        getTask: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      });
      (eventedStore.updateTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, patch: Partial<Task>) => {
        const next = { ...(tasks.get(id) as Task), ...patch } as Task;
        tasks.set(id, next);
        (eventedStore as unknown as EventEmitter).emit("task:updated", next);
        return next;
      });
      (eventedStore.moveTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, to: any) => {
        const current = tasks.get(id) as Task;
        const next = { ...current, column: to } as Task;
        tasks.set(id, next);
        (eventedStore as unknown as EventEmitter).emit("task:moved", { task: next, from: current.column, to });
      });
      const managerWithRecovery = new SelfHealingManager(eventedStore, { rootDir: "/tmp/test-project" });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const provider: NotificationProvider = { getProviderId: () => "mock", isEventSupported: () => true, sendNotification };
      const notificationService = new NotificationService(eventedStore as any);
      notificationService.registerProvider(provider);
      await notificationService.start();

      (eventedStore.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([tasks.get("FN-1")]);
      mockedExecSync.mockImplementation((command: string | Buffer) => {
        if (String(command).includes("Fusion-Task-Id: FN-1")) return "abc123\n" as any;
        return "tip\n" as any;
      });
      mockedExistsSync.mockReturnValue(false);

      (eventedStore as unknown as EventEmitter).emit("task:updated", tasks.get("FN-1"));
      await managerWithRecovery.recoverAlreadyMergedReviewTasks();
      await vi.advanceTimersByTimeAsync(60);

      expect(sendNotification).not.toHaveBeenCalledWith("failed", expect.anything());
      expect(tasks.get("FN-1")?.column).toBe("done");
      expect(tasks.get("FN-1")?.mergeDetails?.mergeConfirmed).toBe(true);

      await notificationService.stop();
      managerWithRecovery.stop();
    });

    it("keeps failed notification when already-merged sweep finds no landed commit", async () => {
      const now = new Date().toISOString();
      const tasks = new Map<string, Task>([["FN-1", { id: "FN-1", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, baseBranch: "main", branch: "fusion/fn-1", worktree: "/tmp/wt", dependencies: [], steps: [], currentStep: 0, description: "x", log: [], createdAt: now, updatedAt: now } as Task]]);
      const eventedStore = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, ntfyEnabled: true, ntfyTopic: "topic", failureNotificationMode: "sticky-only", failureNotificationDelayMs: 50 }),
        listTasks: vi.fn().mockImplementation(async () => Array.from(tasks.values())),
        getTask: vi.fn().mockImplementation(async (id: string) => tasks.get(id)),
      });
      const managerWithRecovery = new SelfHealingManager(eventedStore, { rootDir: "/tmp/test-project" });
      const sendNotification = vi.fn(async () => ({ success: true, providerId: "mock" }));
      const provider: NotificationProvider = { getProviderId: () => "mock", isEventSupported: () => true, sendNotification };
      const notificationService = new NotificationService(eventedStore as any);
      notificationService.registerProvider(provider);
      await notificationService.start();

      mockedExecSync.mockImplementation(() => {
        throw new Error("missing branch");
      });
      (eventedStore as unknown as EventEmitter).emit("task:updated", tasks.get("FN-1"));
      await managerWithRecovery.recoverAlreadyMergedReviewTasks();
      await vi.advanceTimersByTimeAsync(60);

      expect(sendNotification).toHaveBeenCalledWith("failed", expect.objectContaining({ taskId: "FN-1" }));

      await notificationService.stop();
      managerWithRecovery.stop();
    });

    it("isolates per-task failures and still recovers later candidates", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: false, enginePaused: false });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-throw", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, baseBranch: "main", branch: "fusion/fn-throw", worktree: "/tmp/wt1", log: [] },
        { id: "FN-hit", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, baseBranch: "main", branch: "fusion/fn-hit", worktree: "/tmp/wt2", log: [] },
      ]);
      mockedExistsSync.mockReturnValue(false);
      mockedExecSync.mockImplementation((command: string | Buffer) => {
        const cmd = String(command);
        if (cmd.includes("Fusion-Task-Id: FN-throw")) throw new Error("trailer fail");
        if (cmd.includes("rev-parse --verify") && cmd.includes("fusion/fn-throw")) throw new Error("rev fail");
        if (cmd.includes("Fusion-Task-Id: FN-hit")) return "abc123\n" as any;
        if (cmd.includes("rev-parse --verify") && cmd.includes("fusion/fn-hit")) return "tip-hit\n" as any;
        return "" as any;
      });

      const result = await managerWithRecovery.recoverAlreadyMergedReviewTasks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-hit", expect.objectContaining({ status: null, mergeRetries: 0 }));
      expect(store.moveTask).toHaveBeenCalledWith("FN-hit", "done");
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-throw", expect.anything());

      managerWithRecovery.stop();
    });

    it("is idempotent across repeated sweeps", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: false, enginePaused: false });
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          { id: "FN-1", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, baseBranch: "main", branch: "fusion/fn-1", worktree: "/tmp/wt", log: [] },
        ])
        .mockResolvedValueOnce([
          { id: "FN-1", column: "done", paused: false, status: null, mergeRetries: 0, mergeDetails: { mergeConfirmed: true }, baseBranch: "main", log: [] },
        ]);
      mockedExecSync.mockImplementation((command: string | Buffer) => {
        if (String(command).includes("Fusion-Task-Id: FN-1")) return "abc123\n" as any;
        return "tip\n" as any;
      });
      mockedExistsSync.mockReturnValue(false);

      const first = await managerWithRecovery.recoverAlreadyMergedReviewTasks();
      const second = await managerWithRecovery.recoverAlreadyMergedReviewTasks();

      expect(first).toBe(1);
      expect(second).toBe(0);

      managerWithRecovery.stop();
    });

    it("auto-finalizes FN-4611-shape paused+failed tasks when landed content is proven", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: false, enginePaused: false });
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          {
            id: "FN-4611-shape",
            column: "in-review",
            paused: true,
            status: "failed",
            error: "stale merge failure",
            mergeRetries: 3,
            mergeDetails: undefined,
            baseBranch: "main",
            branch: "fusion/fn-4611-shape",
            steps: [],
            log: [],
          },
        ])
        .mockResolvedValue([
          {
            id: "FN-4611-shape",
            column: "done",
            dependencies: [],
            log: [],
          },
          {
            id: "FN-dependent",
            column: "todo",
            blockedBy: "FN-4611-shape",
            dependencies: [],
            log: [],
          },
        ]);
      mockedExecSync.mockImplementation((command: string | Buffer) => {
        if (String(command).includes("Fusion-Task-Id: FN-4611-shape")) return "abc123\n" as any;
        return "tip\n" as any;
      });

      const result = await managerWithRecovery.recoverAlreadyMergedReviewTasks();

      expect(result).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-4611-shape",
        expect.objectContaining({ paused: false, status: null, error: null, mergeRetries: 0 }),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-4611-shape", "done");
      expect(store.updateTask).toHaveBeenCalledWith("FN-dependent", {
        blockedBy: null,
        overlapBlockedBy: null,
        status: null,
      });

      managerWithRecovery.stop();
    });

    it("keeps already-landed tasks in-review when merge blocker still reports incomplete steps", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: false, enginePaused: false });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-incomplete",
          column: "in-review",
          paused: false,
          status: "failed",
          mergeRetries: 3,
          mergeDetails: undefined,
          baseBranch: "main",
          branch: "fusion/fn-incomplete",
          steps: [{ status: "in-progress" }],
          log: [],
        },
      ]);
      mockedExecSync.mockImplementation((command: string | Buffer) => {
        if (String(command).includes("Fusion-Task-Id: FN-incomplete")) return "abc123\n" as any;
        return "tip\n" as any;
      });

      const result = await managerWithRecovery.recoverAlreadyMergedReviewTasks();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-incomplete", "done");
      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-incomplete",
        expect.objectContaining({
          status: "failed",
          error: "Merge confirmed but finalization blocked: task has incomplete steps",
        }),
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-incomplete",
        expect.stringContaining("finalization blocked"),
      );

      managerWithRecovery.stop();
    });
  });

  describe("recoverAlreadyMergedReviewTasks — run-audit emission", () => {
    it("emits task:auto-recover-finalize-already-on-main when recovery succeeds", async () => {
      const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
      const storeWithAudit = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
        listTasks: vi.fn().mockResolvedValue([
          {
            id: "FN-audit",
            column: "in-review",
            paused: false,
            status: "failed",
            mergeRetries: 4,
            mergeDetails: undefined,
            baseBranch: "main",
            branch: "fusion/fn-audit",
            steps: [],
            log: [],
          },
        ]),
        recordRunAuditEvent,
      });
      const managerWithRecovery = new SelfHealingManager(storeWithAudit, { rootDir: "/tmp/test-project" });
      vi.spyOn(managerWithRecovery as any, "findAlreadyMergedTaskCommit").mockResolvedValue({ sha: "abc1234def5678", strategy: "trailer" });

      const recovered = await managerWithRecovery.recoverAlreadyMergedReviewTasks();

      expect(recovered).toBe(1);
      expect(recordRunAuditEvent).toHaveBeenCalledTimes(2);
      expect(recordRunAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: "database",
          mutationType: "task:auto-recover-finalize-already-on-main",
          target: "FN-audit",
          metadata: expect.objectContaining({
            mergeSha: "abc1234def5678",
            mergeStrategy: "trailer",
            baseBranch: "main",
            mergeRetries: 4,
            clearedFlags: { paused: false, status: true, error: false },
          }),
        }),
      );

      managerWithRecovery.stop();
    });

    it("does not emit when no landed commit is detected", async () => {
      const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
      const storeWithAudit = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
        listTasks: vi.fn().mockResolvedValue([
          {
            id: "FN-no-hit",
            column: "in-review",
            paused: false,
            status: "failed",
            mergeRetries: 3,
            mergeDetails: undefined,
            baseBranch: "main",
            branch: "fusion/fn-no-hit",
            steps: [],
            log: [],
          },
        ]),
        recordRunAuditEvent,
      });
      const managerWithRecovery = new SelfHealingManager(storeWithAudit, { rootDir: "/tmp/test-project" });
      vi.spyOn(managerWithRecovery as any, "findAlreadyMergedTaskCommit").mockResolvedValue(null);

      const recovered = await managerWithRecovery.recoverAlreadyMergedReviewTasks();

      expect(recovered).toBe(0);
      expect(recordRunAuditEvent).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("continues recovery when run-audit persistence throws", async () => {
      const recordRunAuditEvent = vi.fn().mockRejectedValueOnce(new Error("audit write failed"));
      const storeWithAudit = createMockStore({
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
        listTasks: vi.fn().mockResolvedValue([
          {
            id: "FN-audit-throw",
            column: "in-review",
            paused: false,
            status: "failed",
            mergeRetries: 5,
            mergeDetails: undefined,
            baseBranch: "main",
            branch: "fusion/fn-audit-throw",
            steps: [],
            log: [],
          },
        ]),
        recordRunAuditEvent,
      });
      const managerWithRecovery = new SelfHealingManager(storeWithAudit, { rootDir: "/tmp/test-project" });
      vi.spyOn(managerWithRecovery as any, "findAlreadyMergedTaskCommit").mockResolvedValue({ sha: "def5678abc1234", strategy: "trailer" });

      const recovered = await managerWithRecovery.recoverAlreadyMergedReviewTasks();

      expect(recovered).toBe(1);
      expect(storeWithAudit.moveTask).toHaveBeenCalledWith("FN-audit-throw", "done");
      expect(recordRunAuditEvent).toHaveBeenCalledTimes(2);

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

    it("ignores advisory pre-merge workflow findings", async () => {
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
          workflowStepResults: [{
            ...baseTask.workflowStepResults[0],
            status: "advisory_failure" as const,
          }],
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

  describe("surfaceInReviewStalls", () => {
    function staleMergingTask(overrides: Record<string, unknown> = {}) {
      return {
        id: "FN-4110",
        column: "in-review",
        paused: false,
        status: "merging",
        mergeRetries: 0,
        mergeDetails: {},
        worktree: "/tmp/FN-4110",
        updatedAt: "2026-01-01T00:00:00.000Z",
        steps: [{ name: "step", status: "done" }],
        workflowStepResults: [],
        log: [],
        ...overrides,
      };
    }

    it("logs FN-4110 stale transient merge status once without moving task", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ taskStuckTimeoutMs: 60_000, autoMerge: true });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([staleMergingTask()]);

      const result = await managerWithRecovery.surfaceInReviewStalls();

      expect(result).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-4110",
        expect.stringContaining("In-review stall surfaced [transient-merge-status-no-owner]:"),
      );
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("suppresses transient-merge stall surfacing when engine activation floor is recent", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
        autoMerge: true,
        engineActiveSinceMs: Date.parse("2026-01-01T00:10:00.000Z"),
        engineActivationGraceMs: 300_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        staleMergingTask({ mergeDetails: { mergeConfirmed: true } }),
      ]);

      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("skips entirely when autoMerge is disabled", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ taskStuckTimeoutMs: 60_000, autoMerge: false });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([staleMergingTask()]);

      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalledWith(
        "FN-4110",
        expect.stringContaining("In-review stall surfaced ["),
      );
      expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "task:in-review-stall-deadlock-disposed",
      }));
      managerWithRecovery.stop();
    });

    it("deduplicates same code inside stuck-timeout window", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ taskStuckTimeoutMs: 60_000, autoMerge: true });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        staleMergingTask({
          log: [{
            timestamp: "2026-01-01T00:09:30.000Z",
            action: "In-review stall surfaced [transient-merge-status-no-owner]: already surfaced",
          }],
        }),
      ]);

      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("re-logs after window expiry and on code transitions", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ taskStuckTimeoutMs: 60_000, autoMerge: true });
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          staleMergingTask({
            log: [{
              timestamp: "2026-01-01T00:08:00.000Z",
              action: "In-review stall surfaced [transient-merge-status-no-owner]: old",
            }],
          }),
        ])
        .mockResolvedValueOnce([
          staleMergingTask({
            status: undefined,
            mergeRetries: 3,
            log: [{
              timestamp: "2026-01-01T00:09:30.000Z",
              action: "In-review stall surfaced [transient-merge-status-no-owner]: recent",
            }],
          }),
        ]);

      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(1);
      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(1);
      expect(store.logEntry).toHaveBeenLastCalledWith(
        "FN-4110",
        expect.stringContaining("In-review stall surfaced [merge-retries-exhausted]:"),
      );
      managerWithRecovery.stop();
    });

    it("skips per-cycle dedup, paused, active merge owner, executing, awaiting-user-review, and mergeConfirmed", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getActiveMergeTaskId: () => "FN-ACTIVE",
        getExecutingTaskIds: () => new Set(["FN-EXEC"]),
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ taskStuckTimeoutMs: 60_000, autoMerge: true });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        staleMergingTask({ id: "FN-CYCLE", updatedAt: "2026-01-01T00:10:00.000Z" }),
        staleMergingTask({ id: "FN-PAUSED", paused: true }),
        staleMergingTask({ id: "FN-ACTIVE" }),
        staleMergingTask({ id: "FN-EXEC" }),
        staleMergingTask({ id: "FN-AWAIT", status: "awaiting-user-review" }),
        staleMergingTask({ id: "FN-MERGED", mergeDetails: { mergeConfirmed: true } }),
      ]);

      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("auto-disposes after three identical merge-blocker stalls", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      const reason = "task is marked 'failed': Failed to create worktree after 3 attempts: Branch fusion/fn-9999 conflict could not be auto-resolved";
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
        autoMerge: true,
        inReviewStallDeadlockThreshold: 3,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        staleMergingTask({
          id: "FN-9999",
          status: "failed",
          error: "Failed to create worktree after 3 attempts: Branch fusion/fn-9999 conflict could not be auto-resolved",
          branch: "fusion/fn-9999",
          worktree: "/tmp/FN-9999",
          log: [
            { timestamp: "2026-01-01T00:01:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
            { timestamp: "2026-01-01T00:03:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
          ],
        }),
      ]);

      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith("FN-9999", expect.objectContaining({
        paused: true,
        pausedReason: "in-review-stall-deadlock",
        status: "failed",
      }));
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-9999",
        expect.stringContaining("In-review stall auto-disposed [merge-blocker]: deadlock-prevention threshold reached after 3 identical stalls"),
      );
      expect(store.logEntry).not.toHaveBeenCalledWith(
        "FN-9999",
        expect.stringContaining("In-review stall surfaced [merge-blocker]"),
      );
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        domain: "database",
        mutationType: "task:in-review-stall-deadlock-disposed",
        target: "FN-9999",
        metadata: expect.objectContaining({
          code: "merge-blocker",
          reason,
          repetitionCount: 3,
          threshold: 3,
        }),
      }));
      managerWithRecovery.stop();
    });

    it("does not dispose below threshold", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      const reason = "task is marked 'failed': Failed to create worktree after 3 attempts: Branch fusion/fn-9999 conflict could not be auto-resolved";
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ taskStuckTimeoutMs: 60_000, autoMerge: true, inReviewStallDeadlockThreshold: 3 });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        staleMergingTask({
          id: "FN-9999",
          status: "failed",
          error: "Failed to create worktree after 3 attempts: Branch fusion/fn-9999 conflict could not be auto-resolved",
          worktree: "/tmp/FN-9999",
          log: [{ timestamp: "2026-01-01T00:01:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` }],
        }),
      ]);

      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith("FN-9999", expect.stringContaining("In-review stall surfaced [merge-blocker]:"));
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("does not dispose when threshold is disabled", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      const reason = "task is marked 'failed': Failed to create worktree after 3 attempts: Branch fusion/fn-9999 conflict could not be auto-resolved";
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ taskStuckTimeoutMs: 60_000, autoMerge: true, inReviewStallDeadlockThreshold: 0 });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        staleMergingTask({
          id: "FN-9999",
          status: "failed",
          error: "Failed to create worktree after 3 attempts: Branch fusion/fn-9999 conflict could not be auto-resolved",
          worktree: "/tmp/FN-9999",
          log: [
            { timestamp: "2026-01-01T00:01:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
            { timestamp: "2026-01-01T00:02:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
            { timestamp: "2026-01-01T00:03:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
          ],
        }),
      ]);

      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith("FN-9999", expect.stringContaining("In-review stall surfaced [merge-blocker]:"));
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("does not accumulate when reasons differ and no-ops when already paused", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      const baseError = "Failed to create worktree after 3 attempts: Branch fusion/fn-9999 conflict could not be auto-resolved";
      const currentReason = `task is marked 'failed': ${baseError}`;
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ taskStuckTimeoutMs: 60_000, autoMerge: true, inReviewStallDeadlockThreshold: 3 });
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          staleMergingTask({
            id: "FN-9999",
            status: "failed",
            error: baseError,
            worktree: "/tmp/FN-9999",
            log: [
              { timestamp: "2026-01-01T00:01:00.000Z", action: "In-review stall surfaced [merge-blocker]: task is marked 'failed': other reason 1" },
              { timestamp: "2026-01-01T00:02:00.000Z", action: "In-review stall surfaced [merge-blocker]: task is marked 'failed': other reason 2" },
              { timestamp: "2026-01-01T00:03:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${currentReason}` },
            ],
          }),
        ])
        .mockResolvedValueOnce([
          staleMergingTask({ id: "FN-9999", paused: true, status: "failed", error: baseError, worktree: "/tmp/FN-9999" }),
        ]);

      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith("FN-9999", expect.stringContaining("In-review stall surfaced [merge-blocker]:"));
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();

      vi.clearAllMocks();
      expect(await managerWithRecovery.surfaceInReviewStalls()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });
  });

  describe("surfaceDependencyBlockedTodos", () => {
    it("returns 0 when globalPause is enabled", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project", getProjectId: () => "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ globalPause: true });

      expect(await managerWithRecovery.surfaceDependencyBlockedTodos()).toBe(0);
      managerWithRecovery.stop();
    });

    it("returns 0 when dependency-blocked todo reporting is disabled", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project", getProjectId: () => "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ dependencyBlockedTodoReportEnabled: false });

      expect(await managerWithRecovery.surfaceDependencyBlockedTodos()).toBe(0);
      managerWithRecovery.stop();
    });

    it("returns groupCount from reporter", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project", getProjectId: () => "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ dependencyBlockedTodoReportEnabled: true });
      const reportSpy = vi.fn().mockResolvedValue({ alerted: true, groupCount: 1 });
      (managerWithRecovery as unknown as { dependencyBlockedTodoReporter: { report: typeof reportSpy } }).dependencyBlockedTodoReporter = { report: reportSpy };

      expect(await managerWithRecovery.surfaceDependencyBlockedTodos()).toBe(1);
      expect(reportSpy).toHaveBeenCalledWith();
      managerWithRecovery.stop();
    });

    it("returns 0 and logs error when reporter fails", async () => {
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project", getProjectId: () => "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ dependencyBlockedTodoReportEnabled: true });
      const reportSpy = vi.fn().mockRejectedValue(new Error("boom"));
      (managerWithRecovery as unknown as { dependencyBlockedTodoReporter: { report: typeof reportSpy } }).dependencyBlockedTodoReporter = { report: reportSpy };

      expect(await managerWithRecovery.surfaceDependencyBlockedTodos()).toBe(0);
      managerWithRecovery.stop();
    });
  });

  describe("surfaceInReviewStalled", () => {
    function inReviewTask(overrides: Record<string, unknown> = {}) {
      return {
        id: "FN-5093",
        column: "in-review",
        paused: false,
        status: "in-review",
        mergeDetails: {},
        columnMovedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        log: [],
        ...overrides,
      };
    }

    it("logs for quiet in-review tasks beyond threshold", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ inReviewStalledThresholdMs: 24 * 60 * 60_000, autoMerge: true });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([inReviewTask()]);

      expect(await managerWithRecovery.surfaceInReviewStalled()).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-5093",
        expect.stringContaining("In-review stalled surfaced [in-review-stalled]: quiet"),
      );
      expect(store.logEntry).toHaveBeenCalledWith("FN-5093", expect.stringContaining("lastActivitySource=column-moved"));
      managerWithRecovery.stop();
    });

    it("suppresses quiet in-review surfacing when engine activation floor is recent", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        inReviewStalledThresholdMs: 24 * 60 * 60_000,
        autoMerge: true,
        engineActiveSinceMs: Date.parse("2026-01-02T01:00:00.000Z"),
        engineActivationGraceMs: 300_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([inReviewTask()]);

      expect(await managerWithRecovery.surfaceInReviewStalled()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("skips for recent activity, paused, global pause, engine pause, autoMerge off, threshold off, executing, and active merge", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: () => new Set(["FN-EXEC"]),
        getActiveMergeTaskId: () => "FN-MERGE",
      });
      (store.getSettings as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ inReviewStalledThresholdMs: 24 * 60 * 60_000, autoMerge: true })
        .mockResolvedValueOnce({ inReviewStalledThresholdMs: 24 * 60 * 60_000, autoMerge: true, globalPause: true })
        .mockResolvedValueOnce({ inReviewStalledThresholdMs: 24 * 60 * 60_000, autoMerge: true, enginePaused: true })
        .mockResolvedValueOnce({ inReviewStalledThresholdMs: 24 * 60 * 60_000, autoMerge: false })
        .mockResolvedValueOnce({ inReviewStalledThresholdMs: 0, autoMerge: true });
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          inReviewTask({ id: "FN-RECENT", log: [{ timestamp: "2026-01-02T00:59:59.000Z", action: "recent" }] }),
          inReviewTask({ id: "FN-PAUSED", paused: true }),
          inReviewTask({ id: "FN-EXEC" }),
          inReviewTask({ id: "FN-MERGE" }),
        ]);

      expect(await managerWithRecovery.surfaceInReviewStalled()).toBe(0);
      expect(await managerWithRecovery.surfaceInReviewStalled()).toBe(0);
      expect(await managerWithRecovery.surfaceInReviewStalled()).toBe(0);
      expect(await managerWithRecovery.surfaceInReviewStalled()).toBe(0);
      expect(await managerWithRecovery.surfaceInReviewStalled()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("dedupes within threshold window and re-emits after window", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ inReviewStalledThresholdMs: 24 * 60 * 60_000, autoMerge: true });
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          inReviewTask({
            log: [{ timestamp: "2026-01-01T12:00:00.000Z", action: "In-review stalled surfaced [in-review-stalled]: recent" }],
          }),
        ])
        .mockResolvedValueOnce([
          inReviewTask({
            log: [{ timestamp: "2025-12-29T00:00:00.000Z", action: "In-review stalled surfaced [in-review-stalled]: old" }],
          }),
        ]);

      expect(await managerWithRecovery.surfaceInReviewStalled()).toBe(0);
      expect(await managerWithRecovery.surfaceInReviewStalled()).toBe(1);
      managerWithRecovery.stop();
    });

    it("suppresses while recent reason-driven in-review stall exists", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ inReviewStalledThresholdMs: 24 * 60 * 60_000, autoMerge: true });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        inReviewTask({ log: [{ timestamp: "2026-01-02T00:10:00.000Z", action: "In-review stall surfaced [merge-blocker]: blocked" }] }),
      ]);

      expect(await managerWithRecovery.surfaceInReviewStalled()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });
  });

  describe("surfaceStalePausedReviews", () => {
    function pausedReviewTask(overrides: Record<string, unknown> = {}) {
      return {
        id: "FN-4233",
        column: "in-review",
        paused: true,
        pausedReason: "manual-hold",
        mergeDetails: {},
        columnMovedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        log: [],
        ...overrides,
      };
    }

    it("no-ops under threshold", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ stalePausedReviewThresholdMs: 24 * 60 * 60_000 });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([pausedReviewTask()]);

      expect(await managerWithRecovery.surfaceStalePausedReviews()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("suppresses stale paused review surfacing when engine activation floor is recent", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        stalePausedReviewThresholdMs: 24 * 60 * 60_000,
        engineActiveSinceMs: Date.parse("2026-01-02T01:00:00.000Z"),
        engineActivationGraceMs: 300_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([pausedReviewTask()]);

      expect(await managerWithRecovery.surfaceStalePausedReviews()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("logs disposition recommendation when threshold met", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ stalePausedReviewThresholdMs: 24 * 60 * 60_000 });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([pausedReviewTask()]);

      expect(await managerWithRecovery.surfaceStalePausedReviews()).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-4233",
        expect.stringContaining("Stale paused review surfaced [stale-paused-review]: paused"),
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-4233",
        expect.stringContaining("disposition options — unpause, retry, archive, or create follow-up task"),
      );
      managerWithRecovery.stop();
    });

    it("skips merge-confirmed, non-paused, recently-updated, and paused/global short-circuit", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ stalePausedReviewThresholdMs: 24 * 60 * 60_000 })
        .mockResolvedValueOnce({ stalePausedReviewThresholdMs: 24 * 60 * 60_000, globalPause: true })
        .mockResolvedValueOnce({ stalePausedReviewThresholdMs: 24 * 60 * 60_000, enginePaused: true });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        pausedReviewTask({ id: "FN-MERGED", mergeDetails: { mergeConfirmed: true } }),
        pausedReviewTask({ id: "FN-RUN", paused: false }),
        pausedReviewTask({ id: "FN-UPD", updatedAt: "2026-01-02T01:00:00.000Z" }),
      ]);

      expect(await managerWithRecovery.surfaceStalePausedReviews()).toBe(0);
      expect(await managerWithRecovery.surfaceStalePausedReviews()).toBe(0);
      expect(await managerWithRecovery.surfaceStalePausedReviews()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("rate-limits within window and re-emits after threshold window", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ stalePausedReviewThresholdMs: 24 * 60 * 60_000 });
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          pausedReviewTask({
            log: [{
              timestamp: "2026-01-01T12:00:00.000Z",
              action: "Stale paused review surfaced [stale-paused-review]: recent",
            }],
          }),
        ])
        .mockResolvedValueOnce([
          pausedReviewTask({
            log: [{
              timestamp: "2025-12-30T00:00:00.000Z",
              action: "Stale paused review surfaced [stale-paused-review]: old",
            }],
          }),
        ]);

      expect(await managerWithRecovery.surfaceStalePausedReviews()).toBe(0);
      expect(await managerWithRecovery.surfaceStalePausedReviews()).toBe(1);
      managerWithRecovery.stop();
    });
  });

  describe("surfaceStalePausedTodos", () => {
    function pausedTodoTask(overrides: Record<string, unknown> = {}) {
      return {
        id: "FN-5034",
        column: "todo",
        paused: true,
        pausedReason: "manual-hold",
        columnMovedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        log: [],
        ...overrides,
      };
    }

    it("logs for stale paused todo tasks", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ stalePausedTodoThresholdMs: 24 * 60 * 60_000 });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([pausedTodoTask()]);

      expect(await managerWithRecovery.surfaceStalePausedTodos()).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-5034",
        expect.stringContaining("Stale paused todo surfaced [stale-paused-todo]: paused"),
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-5034",
        expect.stringContaining("disposition options — unpause, move to triage, archive, or create follow-up task"),
      );
      managerWithRecovery.stop();
    });

    it("suppresses stale paused todo surfacing when engine activation floor is recent", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        stalePausedTodoThresholdMs: 24 * 60 * 60_000,
        engineActiveSinceMs: Date.parse("2026-01-02T01:00:00.000Z"),
        engineActivationGraceMs: 300_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([pausedTodoTask()]);

      expect(await managerWithRecovery.surfaceStalePausedTodos()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("skips under threshold and for unpaused/non-todo tasks", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ stalePausedTodoThresholdMs: 24 * 60 * 60_000 });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        pausedTodoTask(),
        pausedTodoTask({ id: "FN-UP", paused: false }),
        pausedTodoTask({ id: "FN-IR", column: "in-review" }),
      ]);

      expect(await managerWithRecovery.surfaceStalePausedTodos()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("returns zero while paused or when threshold is disabled", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ stalePausedTodoThresholdMs: 24 * 60 * 60_000, globalPause: true })
        .mockResolvedValueOnce({ stalePausedTodoThresholdMs: 24 * 60 * 60_000, enginePaused: true })
        .mockResolvedValueOnce({ stalePausedTodoThresholdMs: 0 });

      expect(await managerWithRecovery.surfaceStalePausedTodos()).toBe(0);
      expect(await managerWithRecovery.surfaceStalePausedTodos()).toBe(0);
      expect(await managerWithRecovery.surfaceStalePausedTodos()).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalled();
      managerWithRecovery.stop();
    });

    it("dedupes within threshold window and re-emits after window", async () => {
      vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
      const managerWithRecovery = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ stalePausedTodoThresholdMs: 24 * 60 * 60_000 });
      (store.listTasks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([
          pausedTodoTask({
            log: [{
              timestamp: "2026-01-01T12:00:00.000Z",
              action: "Stale paused todo surfaced [stale-paused-todo]: recent",
            }],
          }),
        ])
        .mockResolvedValueOnce([
          pausedTodoTask({
            log: [{
              timestamp: "2025-12-30T00:00:00.000Z",
              action: "Stale paused todo surfaced [stale-paused-todo]: old",
            }],
          }),
        ]);

      expect(await managerWithRecovery.surfaceStalePausedTodos()).toBe(0);
      expect(await managerWithRecovery.surfaceStalePausedTodos()).toBe(1);
      managerWithRecovery.stop();
    });
  });

  describe("recoverGhostReviewTasks", () => {
    it("preserves failed in-review tasks so actionable merge failures are not ghost-retried", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 1_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-9001",
          column: "in-review",
          paused: false,
          status: "failed",
          worktree: undefined,
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          steps: [],
          workflowStepResults: [],
          mergeDetails: undefined,
          log: [],
        },
      ]);

      const result = await managerWithRecovery.recoverGhostReviewTasks();

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("preserves human-handoff and active-merge statuses", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 1_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-A", column: "in-review", paused: false, status: "awaiting-user-review", updatedAt: new Date(Date.now() - 10_000).toISOString(), steps: [], log: [] },
        { id: "FN-B", column: "in-review", paused: false, status: "awaiting-approval", updatedAt: new Date(Date.now() - 10_000).toISOString(), steps: [], log: [] },
        { id: "FN-C", column: "in-review", paused: false, status: "merging", updatedAt: new Date(Date.now() - 10_000).toISOString(), steps: [], log: [] },
        { id: "FN-D", column: "in-review", paused: false, status: "merging-pr", updatedAt: new Date(Date.now() - 10_000).toISOString(), steps: [], log: [] },
      ]);

      const result = await managerWithRecovery.recoverGhostReviewTasks();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("ignores fresh in-review tasks within the timeout window", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 60_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-9002", column: "in-review", paused: false, status: null, updatedAt: new Date().toISOString(), steps: [], log: [] },
      ]);

      const result = await managerWithRecovery.recoverGhostReviewTasks();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips paused, currently-executing, and merge-confirmed tasks", async () => {
      const getExecuting = vi.fn().mockReturnValue(new Set(["FN-EXEC"]));
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: getExecuting,
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 1_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-PAUSED", column: "in-review", paused: true, status: null, updatedAt: new Date(Date.now() - 10_000).toISOString(), steps: [], log: [] },
        { id: "FN-EXEC", column: "in-review", paused: false, status: null, updatedAt: new Date(Date.now() - 10_000).toISOString(), steps: [], log: [] },
        { id: "FN-MERGED", column: "in-review", paused: false, status: null, mergeDetails: { mergeConfirmed: true }, updatedAt: new Date(Date.now() - 10_000).toISOString(), steps: [], log: [] },
      ]);

      const result = await managerWithRecovery.recoverGhostReviewTasks();

      expect(result).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("no-ops when stuck timeout is disabled or engine is paused", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 0,
      });
      expect(await managerWithRecovery.recoverGhostReviewTasks()).toBe(0);

      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 1_000,
        enginePaused: true,
      });
      expect(await managerWithRecovery.recoverGhostReviewTasks()).toBe(0);

      expect(store.moveTask).not.toHaveBeenCalled();

      managerWithRecovery.stop();
    });

    it("skips updateTask when there is no transient status to clear", async () => {
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
      });
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskStuckTimeoutMs: 1_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-9003", column: "in-review", paused: false, status: null, updatedAt: new Date(Date.now() - 10_000).toISOString(), steps: [], log: [] },
      ]);

      const result = await managerWithRecovery.recoverGhostReviewTasks();

      expect(result).toBe(1);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).toHaveBeenCalledWith("FN-9003", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });

      managerWithRecovery.stop();
    });
  });

  describe("recoverOrphanedExecutions", () => {
    const expectNoMutation = () => {
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();
    };

    it("emits no-action audit for missing worktree candidates past grace", async () => {
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());
      const recoverAbandonedLease = vi.fn();
      const reconcileLeaseRow = vi.fn();
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: getExecuting,
        leaseManager: { recoverAbandonedLease, reconcileLeaseRow } as any,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-200",
          column: "in-progress",
          paused: false,
          worktree: undefined,
          branch: undefined,
          steps: [{ status: "in-progress" }],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedExecutions();

      expect(result).toBe(0);
      expectNoMutation();
      expect(recoverAbandonedLease).not.toHaveBeenCalled();
      expect(reconcileLeaseRow).not.toHaveBeenCalled();
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "task:orphan-detected-no-action",
        target: "FN-200",
        metadata: expect.objectContaining({ reason: "missing-worktree-or-session" }),
      }));
      managerWithRecovery.stop();
    });

    it("emits no-action audit for existing worktree candidates past grace", async () => {
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
          steps: [{ status: "done" }, { status: "in-progress" }],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      mockedExistsSync.mockImplementation((p) => p === "/tmp/test-project/.worktrees/active-tree");
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedExecutions();

      expect(result).toBe(0);
      expectNoMutation();
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "task:orphan-detected-no-action",
        target: "FN-210",
        metadata: expect.objectContaining({ reason: "worktree-exists-no-active-session" }),
      }));
      managerWithRecovery.stop();
    });

    it("skips within grace, executing, paused, and complete candidates", async () => {
      const getExecuting = vi.fn().mockReturnValue(new Set(["FN-201"]));
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: getExecuting,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-201", column: "in-progress", paused: false, worktree: undefined, steps: [{ status: "in-progress" }], updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "FN-202", column: "in-progress", paused: true, worktree: undefined, steps: [{ status: "in-progress" }], updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "FN-203", column: "in-progress", paused: false, worktree: undefined, steps: [{ status: "done" }], updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "FN-204", column: "in-progress", paused: false, worktree: undefined, steps: [{ status: "in-progress" }], updatedAt: "2026-01-01T00:04:30.000Z" },
      ]);
      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedExecutions();

      expect(result).toBe(0);
      expectNoMutation();
      expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "task:orphan-detected-no-action",
      }));
      managerWithRecovery.stop();
    });

    it("emits one audit event per candidate per sweep", async () => {
      const getExecuting = vi.fn().mockReturnValue(new Set<string>());
      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        getExecutingTaskIds: getExecuting,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-220", column: "in-progress", paused: false, worktree: undefined, steps: [{ status: "in-progress" }], updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "FN-221", column: "in-progress", paused: false, worktree: undefined, steps: [{ status: "in-progress" }], updatedAt: "2026-01-01T00:00:00.000Z" },
      ]);
      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      const result = await managerWithRecovery.recoverOrphanedExecutions();

      expect(result).toBe(0);
      const orphanAudits = (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([arg]) => arg?.mutationType === "task:orphan-detected-no-action",
      );
      expect(orphanAudits).toHaveLength(2);
      expectNoMutation();
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

describe("clearStaleBlockedBy", () => {
  function createRunningStore() {
    return createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        autoUnpauseEnabled: false,
        maintenanceIntervalMs: 0,
        globalPause: false,
        enginePaused: false,
      } as unknown as Settings),
    });
  }

  function mockSweepTasks(
    store: ReturnType<typeof createRunningStore>,
    {
      todo = [],
      inProgress = [],
      inReview = [],
      all = [...todo, ...inProgress, ...inReview],
    }: {
      todo?: Record<string, unknown>[];
      inProgress?: Record<string, unknown>[];
      inReview?: Record<string, unknown>[];
      all?: Record<string, unknown>[];
    },
  ) {
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(async (options?: { column?: string }) => {
      if (options?.column === "todo") return todo;
      if (options?.column === "in-progress") return inProgress;
      if (options?.column === "in-review") return inReview;
      return all;
    });
  }

  function createTask(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      column: "todo",
      paused: false,
      blockedBy: null,
      mergeRetries: 0,
      dependencies: [],
      ...overrides,
    };
  }

  it("clears stale blockedBy when blocker is missing", async () => {
    const store = createRunningStore();
    const taskA = createTask("A", { blockedBy: "FN-MISSING" });
    mockSweepTasks(store, { todo: [taskA] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, overlapBlockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("FN-MISSING"));
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("missing"));
    manager.stop();
  });

  it("clears stale blockedBy with explicit reason when blocker is soft-deleted", async () => {
    const store = createRunningStore();
    const deletedAt = "2026-05-22T00:00:00.000Z";
    (store.getTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, options?: { includeDeleted?: boolean }) => {
      if (id === "FN-DELETED" && options?.includeDeleted) {
        return createTask("FN-DELETED", { deletedAt }) as unknown as Task;
      }
      throw new Error(`Task ${id} not found`);
    });

    const taskA = createTask("A", { blockedBy: "FN-DELETED" });
    mockSweepTasks(store, { todo: [taskA] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, overlapBlockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("soft-deleted at 2026-05-22T00:00:00.000Z"));
    manager.stop();
  });

  it("clears stale blockedBy for in-progress task when blocker is soft-deleted", async () => {
    const store = createRunningStore();
    const deletedAt = "2026-05-22T00:00:00.000Z";
    (store.getTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, options?: { includeDeleted?: boolean }) => {
      if (id === "FN-DELETED" && options?.includeDeleted) {
        return createTask("FN-DELETED", { deletedAt }) as unknown as Task;
      }
      throw new Error(`Task ${id} not found`);
    });

    const taskA = createTask("A", { column: "in-progress", blockedBy: "FN-DELETED" });
    mockSweepTasks(store, { inProgress: [taskA], all: [taskA] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("Auto-recovered (FN-4091): cleared stale blockedBy — blocker FN-DELETED soft-deleted at 2026-05-22T00:00:00.000Z"));
    manager.stop();
  });

  it("refreshes to next live dependency when one dependency is soft-deleted", async () => {
    const store = createRunningStore();
    const deletedAt = "2026-05-22T00:00:00.000Z";
    (store.getTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, options?: { includeDeleted?: boolean }) => {
      if (id === "FN-DELETED" && options?.includeDeleted) {
        return createTask("FN-DELETED", { deletedAt }) as unknown as Task;
      }
      throw new Error(`Task ${id} not found`);
    });

    const taskA = createTask("A", { blockedBy: "FN-DELETED", status: "queued", dependencies: ["FN-DELETED", "FN-LIVE"] });
    const liveBlocker = createTask("FN-LIVE", { column: "todo" });
    mockSweepTasks(store, { todo: [taskA, liveBlocker], all: [taskA, liveBlocker] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: "FN-LIVE", status: "queued" });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("soft-deleted"));
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("now blocked by FN-LIVE"));
    manager.stop();
  });

  it("is idempotent after recovering soft-deleted blockers", async () => {
    const store = createRunningStore();
    const deletedAt = "2026-05-22T00:00:00.000Z";
    (store.getTask as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, options?: { includeDeleted?: boolean }) => {
      if (id === "FN-DELETED" && options?.includeDeleted) {
        return createTask("FN-DELETED", { deletedAt }) as unknown as Task;
      }
      throw new Error(`Task ${id} not found`);
    });

    const taskA = createTask("A", { blockedBy: "FN-DELETED" });
    mockSweepTasks(store, { todo: [taskA], all: [taskA] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const firstRecovered = await manager.clearStaleBlockedBy();
    expect(firstRecovered).toBe(1);

    const healedTask = createTask("A", { blockedBy: null, status: null });
    mockSweepTasks(store, { todo: [healedTask], all: [healedTask] });
    (store.updateTask as ReturnType<typeof vi.fn>).mockClear();
    (store.logEntry as ReturnType<typeof vi.fn>).mockClear();

    const secondRecovered = await manager.clearStaleBlockedBy();
    expect(secondRecovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    manager.stop();
  });

  it.each(["done", "archived"] as const)("clears stale blockedBy when blocker is %s", async (column) => {
    const store = createRunningStore();
    const blockerId = "FN-100";
    const taskA = createTask("A", { blockedBy: blockerId });
    const taskB = createTask(blockerId, { column });
    mockSweepTasks(store, { todo: [taskA], all: [taskA, taskB] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, overlapBlockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining(blockerId));
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining(column));
    manager.stop();
  });

  it("clears stale blockedBy when blocker is in-review and paused", async () => {
    const store = createRunningStore();
    const blockerId = "FN-200";
    const taskA = createTask("A", { blockedBy: blockerId });
    const taskB = createTask(blockerId, { column: "in-review", paused: true });
    mockSweepTasks(store, { todo: [taskA], inReview: [taskB], all: [taskA, taskB] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, overlapBlockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining(blockerId));
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("in-review + paused"));
    manager.stop();
  });

  it("clears stale blockedBy when blocker is in-review failed with exhausted retries", async () => {
    const store = createRunningStore();
    const blockerId = "FN-300";
    const taskA = createTask("A", { blockedBy: blockerId });
    const taskB = createTask(blockerId, { column: "in-review", status: "failed", mergeRetries: 3 });
    mockSweepTasks(store, { todo: [taskA], inReview: [taskB], all: [taskA, taskB] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, overlapBlockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining(blockerId));
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("mergeRetries 3/3"));
    manager.stop();
  });

  it("does not clear blockedBy when blocker is in-progress", async () => {
    const store = createRunningStore();
    const taskA = createTask("A", { blockedBy: "FN-400" });
    const taskB = createTask("FN-400", { column: "in-progress" });
    mockSweepTasks(store, { todo: [taskA], inProgress: [taskB], all: [taskA, taskB] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    manager.stop();
  });

  it("clears blockedBy when dependency task has no unresolved deps but blockedBy points elsewhere", async () => {
    const store = createRunningStore();
    const taskA = createTask("A", { blockedBy: "FN-400", dependencies: ["FN-DEP"] });
    const overlapBlocker = createTask("FN-400", { column: "in-progress" });
    const dependency = createTask("FN-DEP", { column: "done" });
    mockSweepTasks(store, { todo: [taskA], inProgress: [overlapBlocker], all: [taskA, overlapBlocker, dependency] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, overlapBlockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("not among unresolved dependencies"));
    manager.stop();
  });

  it("does not clear blockedBy when blocker is in-review and not paused/failed", async () => {
    const store = createRunningStore();
    const taskA = createTask("A", { blockedBy: "FN-500" });
    const taskB = createTask("FN-500", { column: "in-review", paused: false, mergeRetries: 0 });
    mockSweepTasks(store, { todo: [taskA], inReview: [taskB], all: [taskA, taskB] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    manager.stop();
  });

  it.each(["merging", "merging-pr"] as const)("clears stale blockedBy when blocker is stale in-review %s", async (status) => {
    vi.setSystemTime(new Date("2026-01-01T00:20:00.000Z"));
    const store = createRunningStore();
    const blockerId = "FN-510";
    const taskA = createTask("A", { blockedBy: blockerId });
    const taskB = createTask(blockerId, {
      column: "in-review",
      paused: false,
      status,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockSweepTasks(store, { todo: [taskA], inReview: [taskB], all: [taskA, taskB] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, overlapBlockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining(`blocker=${blockerId}`));
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("reason=unbacked-merging"));
    manager.stop();
    vi.useRealTimers();
  });

  it("does not clear stale merging blocker inside threshold", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    const store = createRunningStore();
    const taskA = createTask("A", { blockedBy: "FN-511" });
    const taskB = createTask("FN-511", {
      column: "in-review",
      paused: false,
      status: "merging",
      updatedAt: "2026-01-01T00:09:31.000Z",
    });
    mockSweepTasks(store, { todo: [taskA], inReview: [taskB], all: [taskA, taskB] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    manager.stop();
    vi.useRealTimers();
  });

  it("honors staleMergingFanoutMinAgeMs option override", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:04.000Z"));
    const store = createRunningStore();
    const taskA = createTask("A", { blockedBy: "FN-512" });
    const taskB = createTask("FN-512", {
      column: "in-review",
      paused: false,
      status: "merging",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockSweepTasks(store, { todo: [taskA], inReview: [taskB], all: [taskA, taskB] });

    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      staleMergingStatusMinAgeMs: 1,
      staleMergingFanoutMinAgeMs: 2_000,
    });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, overlapBlockedBy: null, status: null });
    manager.stop();
    vi.useRealTimers();
  });

  it("does not clear blockedBy when blocker failed retries are below threshold", async () => {
    const store = createRunningStore();
    const taskA = createTask("A", { blockedBy: "FN-600" });
    const taskB = createTask("FN-600", { column: "in-review", status: "failed", mergeRetries: 1 });
    mockSweepTasks(store, { todo: [taskA], inReview: [taskB], all: [taskA, taskB] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    manager.stop();
  });

  it("FN-4013 signature: clears blockedBy when in-review blocker failed from missing-worktree session start", async () => {
    const store = createRunningStore();
    const taskA = createTask("FN-4013", { blockedBy: "FN-3908", dependencies: ["FN-3908"] });
    const taskB = createTask("FN-3908", {
      column: "in-review",
      status: "failed",
      mergeRetries: 0,
      error: "Refusing to start coding agent in missing worktree: /tmp/test-project/.worktrees/bright-wren",
      steps: [{ status: "done" }, { status: "pending" }] as any,
    });
    mockSweepTasks(store, { todo: [taskA], inReview: [taskB], all: [taskA, taskB] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4013", { blockedBy: null, overlapBlockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("FN-4013", expect.stringContaining("missing-worktree session start"));
    manager.stop();
  });

  it.each([
    { settings: { globalPause: true }, label: "globalPause" },
    { settings: { enginePaused: true }, label: "enginePaused" },
  ])("returns 0 when $label is active", async ({ settings }) => {
    const store = createRunningStore();
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      autoUnpauseEnabled: false,
      maintenanceIntervalMs: 0,
      globalPause: false,
      enginePaused: false,
      ...settings,
    } as unknown as Settings);
    const taskA = createTask("A", { blockedBy: "FN-700" });
    mockSweepTasks(store, { todo: [taskA] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    manager.stop();
  });

  it("is idempotent after first stale blockedBy recovery", async () => {
    const store = createRunningStore();
    const blockerId = "FN-800";
    const blocked = createTask("A", { blockedBy: blockerId });
    const blocker = createTask(blockerId, { column: "done" });
    const recoveredState = createTask("A", { blockedBy: null });

    (store.listTasks as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (options?: { column?: string }) => options?.column === "todo" ? [blocked] : options?.column === "in-progress" ? [] : options?.column === "in-review" ? [] : [blocked, blocker])
      .mockImplementationOnce(async (options?: { column?: string }) => options?.column === "todo" ? [blocked] : options?.column === "in-progress" ? [] : options?.column === "in-review" ? [] : [blocked, blocker])
      .mockImplementationOnce(async (options?: { column?: string }) => options?.column === "todo" ? [recoveredState] : options?.column === "in-progress" ? [] : options?.column === "in-review" ? [] : [recoveredState, blocker])
      .mockImplementationOnce(async (options?: { column?: string }) => options?.column === "todo" ? [recoveredState] : options?.column === "in-progress" ? [] : options?.column === "in-review" ? [] : [recoveredState, blocker])
      .mockImplementationOnce(async (options?: { column?: string }) => options?.column === "todo" ? [recoveredState] : options?.column === "in-progress" ? [] : options?.column === "in-review" ? [] : [recoveredState, blocker])
      .mockImplementationOnce(async (options?: { column?: string }) => options?.column === "todo" ? [recoveredState] : options?.column === "in-progress" ? [] : options?.column === "in-review" ? [] : [recoveredState, blocker])
      .mockImplementationOnce(async () => [recoveredState, blocker])
      .mockImplementationOnce(async () => [recoveredState, blocker]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const first = await manager.clearStaleBlockedBy();
    const second = await manager.clearStaleBlockedBy();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("clears stale blockedBy on an in-progress task when blocker is missing", async () => {
    const store = createRunningStore();
    const taskA = createTask("FN-4076", { column: "in-progress", blockedBy: "FN-MISSING" });
    mockSweepTasks(store, { inProgress: [taskA], all: [taskA] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4076", { blockedBy: null });
    expect(store.logEntry).toHaveBeenCalledWith("FN-4076", expect.stringContaining("FN-4091"));
    expect(store.logEntry).toHaveBeenCalledWith("FN-4076", expect.stringContaining("FN-MISSING"));
    manager.stop();
  });

  it("clears stale blockedBy on an unpaused in-review task when blocker is done", async () => {
    const store = createRunningStore();
    const blockerId = "FN-4100";
    const taskA = createTask("FN-4076", { column: "in-review", blockedBy: blockerId, paused: false });
    const blocker = createTask(blockerId, { column: "done" });
    mockSweepTasks(store, { inReview: [taskA], all: [taskA, blocker] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4076", { blockedBy: null });
    expect(store.logEntry).toHaveBeenCalledWith("FN-4076", expect.stringContaining("FN-4091"));
    expect(store.logEntry).toHaveBeenCalledWith("FN-4076", expect.stringContaining("done"));
    manager.stop();
  });

  it("clears blockedBy on an in-progress task when blocker has moved back to todo", async () => {
    const store = createRunningStore();
    const blockerId = "FN-4101";
    const taskA = createTask("FN-4076", { column: "in-progress", blockedBy: blockerId });
    const blocker = createTask(blockerId, { column: "todo" });
    mockSweepTasks(store, { inProgress: [taskA], all: [taskA, blocker] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4076", { blockedBy: null });
    manager.stop();
  });

  it("does not clear blockedBy on a paused in-review task even when the blocker is stale", async () => {
    const store = createRunningStore();
    const taskA = createTask("FN-4076", { column: "in-review", paused: true, blockedBy: "FN-MISSING" });
    mockSweepTasks(store, { inReview: [taskA], all: [taskA] });

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    manager.stop();
  });

  it("FN-3908: clears stale queued status when all dependencies are already satisfied", async () => {
    const store = createRunningStore();
    const queuedTask = createTask("FN-3170", {
      status: "queued",
      blockedBy: null,
      dependencies: ["FN-3168", "FN-3169"],
    });
    const depA = createTask("FN-3168", { column: "archived" });
    const depB = createTask("FN-3169", { column: "done" });
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([queuedTask, depA, depB]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    // FN-5434: stale queued-status cleanup remains stateful but is no longer logged/count-recovered.
    expect(recovered).toBe(0);
    expect(store.updateTask).toHaveBeenCalledWith("FN-3170", { blockedBy: null, overlapBlockedBy: null, status: null });
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-3170",
      expect.stringContaining("cleared stale queued status"),
    );
    manager.stop();
  });

  it("FN-5433: skips stale blockedBy refresh when next unresolved dependency is unchanged", async () => {
    const store = createRunningStore();
    const queuedTask = createTask("FN-3170", {
      status: "queued",
      blockedBy: "FN-DEP",
      dependencies: ["FN-DEP", "FN-OTHER"],
    });
    const depA = createTask("FN-DEP", { column: "todo" });
    const depB = createTask("FN-OTHER", { column: "in-progress" });
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([queuedTask, depA, depB]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-3170", expect.any(Object));
    const refreshedLogs = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([taskId, message]) => taskId === "FN-3170" && String(message).includes("refreshed stale blockedBy"),
    );
    expect(refreshedLogs).toHaveLength(0);
    manager.stop();
  });

  it("FN-3908: refreshes blockedBy to first unresolved dependency when stale blocker changed", async () => {
    const store = createRunningStore();
    const queuedTask = createTask("FN-3170", {
      status: "queued",
      blockedBy: "FN-3168",
      dependencies: ["FN-3168", "FN-3169"],
    });
    const depA = createTask("FN-3168", { column: "archived" });
    const depB = createTask("FN-3169", { column: "in-progress" });
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([queuedTask, depA, depB]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-3170", { blockedBy: "FN-3169", status: "queued" });
    expect(store.logEntry).toHaveBeenCalledWith("FN-3170", expect.stringContaining("refreshed stale blockedBy"));
    manager.stop();
  });
});

describe("FN-4538 overlapBlockedBy self-healing", () => {
  function makeTask(id: string, overrides: Record<string, unknown> = {}) {
    return { id, column: "todo", paused: false, blockedBy: null, dependencies: [], mergeRetries: 0, ...overrides };
  }

  function makeStore(tasks: Record<string, unknown>[]) {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        autoUnpauseEnabled: false,
        maintenanceIntervalMs: 0,
        globalPause: false,
        enginePaused: false,
      } as unknown as Settings),
    });
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(async (options?: { column?: string }) => {
      if (options?.column === "todo") return tasks.filter((task) => task.column === "todo");
      if (options?.column === "in-progress") return tasks.filter((task) => task.column === "in-progress");
      if (options?.column === "in-review") return tasks.filter((task) => task.column === "in-review");
      return tasks;
    });
    return store;
  }

  it("FN-4538: clearStaleBlockedBy does NOT clear queued status when overlapBlockedBy is active", async () => {
    const overlapBlocker = makeTask("FN-ACTIVE", { column: "in-progress" });
    const target = makeTask("FN-TARGET", {
      column: "todo",
      status: "queued",
      blockedBy: undefined,
      overlapBlockedBy: "FN-ACTIVE",
      dependencies: [],
    });
    const store = makeStore([target, overlapBlocker]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(store.updateTask).toHaveBeenCalledWith("FN-TARGET", { blockedBy: null, status: "queued" });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-TARGET",
      "Auto-recovered: preserved queued status — still blocked by file scope overlap with FN-ACTIVE",
    );
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-TARGET", expect.objectContaining({ status: null }));
    manager.stop();
  });

  it("FN-4538: clearStaleBlockedBy clears overlapBlockedBy when overlap blocker is done", async () => {
    const overlapBlocker = makeTask("FN-DONE", { column: "done" });
    const target = makeTask("FN-TARGET", {
      column: "todo",
      status: "queued",
      blockedBy: undefined,
      overlapBlockedBy: "FN-DONE",
      dependencies: [],
    });
    const store = makeStore([target, overlapBlocker]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(store.updateTask).toHaveBeenCalledWith("FN-TARGET", { blockedBy: null, overlapBlockedBy: null, status: null });
    manager.stop();
  });

  it("FN-4538: reconcileCompletedTask clears overlapBlockedBy when completed task is overlap blocker", async () => {
    const target = makeTask("FN-TARGET", { column: "todo", status: "queued", overlapBlockedBy: "FN-X" });
    const blocker = makeTask("FN-X", { column: "done" });
    const store = makeStore([target, blocker]);
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(blocker);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.reconcileCompletedTask("FN-X");

    expect(store.updateTask).toHaveBeenCalledWith("FN-TARGET", { blockedBy: null, overlapBlockedBy: null, status: null });
    manager.stop();
  });

  it("FN-4538: no oscillation — scheduler + self-healing agree on overlap-blocked state", async () => {
    const overlapBlocker = makeTask("FN-ACTIVE", { column: "in-progress" });
    const target = makeTask("FN-TARGET", { column: "todo", status: "queued", blockedBy: null, overlapBlockedBy: "FN-ACTIVE" });
    const store = makeStore([target, overlapBlocker]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.clearStaleBlockedBy();

    expect(store.updateTask).toHaveBeenCalledWith("FN-TARGET", { blockedBy: null, status: "queued" });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-TARGET", expect.objectContaining({ status: null }));
    manager.stop();
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

describe("recoverDoneTaskMergeMetadata", () => {
  it("FN-5103: skips attribution-restricted done task merge metadata reconcile", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-5103-A",
        column: "done",
        paused: false,
        mergeDetails: {
          commitSha: "merge1",
          mergeConfirmed: true,
          landedFilesAttributionRestricted: true,
          landedFiles: ["a.ts"],
          filesChanged: 1,
          insertions: 1,
          deletions: 0,
        },
      },
    ]);

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();

    manager.stop();
  });

  it("FN-5103: skips no-op verified-short-circuit merge metadata reconcile", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-5103-B",
        column: "done",
        paused: false,
        mergeDetails: {
          commitSha: "merge1",
          mergeConfirmed: true,
          noOpVerifiedShortCircuit: true,
          landedFiles: [],
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
        },
      },
    ]);

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();

    manager.stop();
  });

  it("FN-5103: fallback captures remain reconcilable", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-5103-C",
        column: "done",
        paused: false,
        mergeDetails: {
          commitSha: "merge1",
          mergeConfirmed: false,
          landedFilesCaptureFallback: "attribution-failed",
        },
      },
    ]);

    vi.spyOn(manager as any, "findLandedTaskCommit").mockResolvedValue({
      sha: "merge1",
      subject: "fix(FN-5103): landed",
      filesChanged: 2,
      insertions: 4,
      deletions: 1,
    });

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-5103-C", expect.objectContaining({
      mergeDetails: expect.objectContaining({
        commitSha: "merge1",
        mergeConfirmed: true,
      }),
    }));

    manager.stop();
  });

  it("repairs empty mergeDetails for landed done task with recorded base commit", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-5854",
        column: "done",
        paused: false,
        baseCommitSha: "base5854",
        mergeDetails: undefined,
      },
    ]);

    vi.spyOn(manager as any, "findLandedTaskCommit").mockResolvedValue({
      sha: "be95b3f2c1234567",
      subject: "FN-5854: landed",
      filesChanged: 2,
      insertions: 75,
      deletions: 0,
    });
    vi.spyOn(manager as any, "readLandedFilesForSha").mockResolvedValue([
      "packages/engine/src/merger-ai.ts",
      "packages/engine/src/self-healing.ts",
    ]);

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-5854", {
      mergeDetails: expect.objectContaining({
        commitSha: "be95b3f2c1234567",
        filesChanged: 2,
        insertions: 75,
        deletions: 0,
        mergeCommitMessage: "FN-5854: landed",
        mergeConfirmed: true,
        landedFiles: [
          "packages/engine/src/merger-ai.ts",
          "packages/engine/src/self-healing.ts",
        ],
      }),
      modifiedFiles: [
        "packages/engine/src/merger-ai.ts",
        "packages/engine/src/self-healing.ts",
      ],
    });

    manager.stop();
  });

  it("leaves empty mergeDetails untouched when no owned landed commit is found", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-5854-MISS",
        column: "done",
        paused: false,
        baseCommitSha: "base5854",
        mergeDetails: undefined,
      },
    ]);

    vi.spyOn(manager as any, "findLandedTaskCommit").mockResolvedValue(null);

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();

    manager.stop();
  });

  it("FN-3862: confirmed task with reachable owned stored SHA preserves canonical commitSha", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-3862",
        column: "done",
        paused: false,
        mergeDetails: { commitSha: "merge1", mergeConfirmed: true },
      },
    ]);

    mockedExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd.includes("merge-base --is-ancestor 'merge1' HEAD")) return "" as any;
      if (cmd.includes("log -1 --format=%H%x1f%s%x1f%b 'merge1'")) {
        return "merge1\u001ffix(FN-3862): canonical merge\u001fFusion-Task-Id: FN-3862" as any;
      }
      if (cmd.includes("show --shortstat --format= merge1")) {
        return "3 files changed, 10 insertions(+), 1 deletions(-)" as any;
      }
      if (cmd.includes("Fusion-Task-Id: FN-3862")) {
        return "fix2\u001ffix(FN-3862): follow-up\n" as any;
      }
      return "" as any;
    });

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-3862", {
      mergeDetails: expect.objectContaining({
        commitSha: "merge1",
      }),
    });

    manager.stop();
  });

  it("FN-4646: repairs missing landedFiles on confirmed merge metadata", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-4646-A",
        column: "done",
        paused: false,
        mergeDetails: { commitSha: "merge1", mergeConfirmed: true, filesChanged: 2, insertions: 3, deletions: 1, mergeCommitMessage: "msg" },
        modifiedFiles: ["a.ts", "b.ts", "c.ts"],
      },
    ]);

    mockedExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd.includes("merge-base --is-ancestor 'merge1' HEAD")) return "" as any;
      if (cmd.includes("log -1 --format=%H%x1f%s%x1f%b 'merge1'")) return "merge1\u001ffix(FN-4646): canonical merge\u001fFusion-Task-Id: FN-4646-A" as any;
      if (cmd.includes("show --shortstat --format=") && cmd.includes("merge1")) return "2 files changed, 3 insertions(+), 1 deletion(-)" as any;
      if (cmd.includes("Fusion-Task-Id: FN-4646-A")) return "merge1\u001ffix(FN-4646): canonical merge\n" as any;
      return "" as any;
    });

    await manager.recoverDoneTaskMergeMetadata();

    expect(store.updateTask).toHaveBeenCalledWith("FN-4646-A", expect.objectContaining({
      mergeDetails: expect.objectContaining({ landedFiles: [] }),
      modifiedFiles: undefined,
    }));

    manager.stop();
  });

  it("FN-4646: repairs differing landedFiles on confirmed merge metadata", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-4646-B",
        column: "done",
        paused: false,
        mergeDetails: { commitSha: "merge1", mergeConfirmed: true, filesChanged: 2, insertions: 3, deletions: 1, mergeCommitMessage: "msg", landedFiles: ["a.ts", "b.ts", "c.ts"] },
      },
    ]);

    mockedExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd.includes("merge-base --is-ancestor 'merge1' HEAD")) return "" as any;
      if (cmd.includes("log -1 --format=%H%x1f%s%x1f%b 'merge1'")) return "merge1\u001ffix(FN-4646): canonical merge\u001fFusion-Task-Id: FN-4646-B" as any;
      if (cmd.includes("show --shortstat --format=") && cmd.includes("merge1")) return "2 files changed, 3 insertions(+), 1 deletion(-)" as any;
      if (cmd.includes("Fusion-Task-Id: FN-4646-B")) return "merge1\u001ffix(FN-4646): canonical merge\n" as any;
      return "" as any;
    });

    await manager.recoverDoneTaskMergeMetadata();

    expect(store.updateTask).toHaveBeenCalledWith("FN-4646-B", expect.objectContaining({
      mergeDetails: expect.objectContaining({ landedFiles: [] }),
      modifiedFiles: undefined,
    }));

    manager.stop();
  });

  it("populates rebaseBaseSha from landed commit when missing", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-4518-A",
        column: "done",
        paused: false,
        mergeDetails: { commitSha: "merge1", mergeConfirmed: false },
      },
    ]);

    vi.spyOn(manager as any, "findLandedTaskCommit").mockResolvedValue({
      sha: "merge1",
      subject: "fix(FN-4518): landed",
      filesChanged: 2,
      insertions: 4,
      deletions: 1,
      rebaseBaseSha: "base1",
    });

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4518-A", {
      mergeDetails: expect.objectContaining({
        commitSha: "merge1",
        rebaseBaseSha: "base1",
      }),
    });

    manager.stop();
  });

  it("does not overwrite existing rebaseBaseSha during reconciliation", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-4518-B",
        column: "done",
        paused: false,
        mergeDetails: { commitSha: "merge1", mergeConfirmed: false, rebaseBaseSha: "existing-base" },
      },
    ]);

    vi.spyOn(manager as any, "findLandedTaskCommit").mockResolvedValue({
      sha: "merge1",
      subject: "fix(FN-4518): landed",
      filesChanged: 2,
      insertions: 4,
      deletions: 1,
      rebaseBaseSha: "incoming-base",
    });

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4518-B", {
      mergeDetails: expect.objectContaining({
        rebaseBaseSha: "existing-base",
      }),
    });

    manager.stop();
  });

  it("keeps rebaseBaseSha undefined when neither stored nor landed provides it", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-4518-C",
        column: "done",
        paused: false,
        mergeDetails: { commitSha: "merge1", mergeConfirmed: false },
      },
    ]);

    vi.spyOn(manager as any, "findLandedTaskCommit").mockResolvedValue({
      sha: "merge1",
      subject: "fix(FN-4518): landed",
      filesChanged: 2,
      insertions: 4,
      deletions: 1,
    });

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4518-C", {
      mergeDetails: expect.not.objectContaining({
        rebaseBaseSha: expect.any(String),
      }),
    });

    manager.stop();
  });

  it("FN-3862: confirmed task with unreachable stored SHA is preserved with warning", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-3814",
        column: "done",
        paused: false,
        mergeDetails: {
          commitSha: "gone1234",
          mergeConfirmed: true,
          filesChanged: 1,
          insertions: 1,
          deletions: 0,
          mergeCommitMessage: "feat(FN-3814): landed",
        },
      },
    ]);

    mockedExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd.includes("merge-base --is-ancestor gone1234 HEAD")) {
        const err = new Error("not ancestor");
        throw err as any;
      }
      if (cmd.includes("Fusion-Task-Id: FN-3814")) {
        return "fix-later\u001ffix(FN-3814): later\n" as any;
      }
      return "" as any;
    });

    const warn = getSelfHealingLogger().warn;
    warn.mockClear();

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("gone1234"));

    manager.stop();
  });

  it("FN-3862: unconfirmed task with multiple owned commits picks earliest via --reverse", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-3829",
        column: "done",
        paused: false,
        baseCommitSha: "base",
        mergeDetails: { commitSha: "old", mergeConfirmed: false },
      },
    ]);

    mockedExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd.includes("merge-base --is-ancestor old HEAD")) {
        throw new Error("not ancestor") as any;
      }
      if (cmd.includes("--reverse") && cmd.includes("Fusion-Task-Id: FN-3829")) {
        return "mergeSha\u001ffix(FN-3829): merge\nfixupSha\u001ffix(FN-3829): follow-up\n" as any;
      }
      if (cmd.includes("Fusion-Task-Id: FN-3829")) {
        return "fixupSha\u001ffix(FN-3829): follow-up\nmergeSha\u001ffix(FN-3829): merge\n" as any;
      }
      if (cmd.includes("show --shortstat --format= mergeSha")) {
        return "2 files changed, 4 insertions(+), 1 deletions(-)" as any;
      }
      return "" as any;
    });

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-3829", {
      mergeDetails: expect.objectContaining({
        commitSha: "mergeSha",
      }),
    });
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--reverse"),
      expect.anything(),
    );

    manager.stop();
  });

  it("FN-3862: unconfirmed task with no owned landed commit clears unowned stored SHA", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "FN-3373",
        column: "done",
        paused: false,
        mergeDetails: { commitSha: "196adbd", mergeConfirmed: false },
        modifiedFiles: ["packages/cli/src/extension.ts"],
      },
    ]);

    mockedExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd.includes("merge-base --is-ancestor 196adbd HEAD")) return "" as any;
      if (cmd.includes("log -1 --format=%H%x1f%s%x1f%b 196adbd")) {
        return "196adbd\u001ffeat(FN-3372): add safety net\u001fFusion-Task-Id: FN-3372" as any;
      }
      return "" as any;
    });

    const repaired = await manager.recoverDoneTaskMergeMetadata();

    expect(repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-3373", { mergeDetails: undefined });

    manager.stop();
  });
});

describe("pruneWorktrees", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createMockStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    mockedResolveWorktreeBackend.mockReturnValue({
      kind: "native",
      create: vi.fn(),
      remove: vi.fn(),
      sync: vi.fn(),
      prune: vi.fn(),
      resolveWorktreePath: vi.fn(),
    } as any);
  });

  afterEach(() => {
    manager.stop();
  });

  it("delegates prune to worktrunk backend when enabled", async () => {
    const prune = vi.fn().mockResolvedValue(undefined);
    mockedResolveWorktreeBackend.mockReturnValue({
      kind: "worktrunk",
      create: vi.fn(),
      remove: vi.fn(),
      sync: vi.fn(),
      prune,
      resolveWorktreePath: vi.fn(),
    } as any);
    vi.mocked(store.getSettings).mockResolvedValue({ worktrunk: { enabled: true, onFailure: "fail" } } as any);

    await (manager as any).pruneWorktrees();

    expect(prune).toHaveBeenCalledWith({ rootDir: "/tmp/test-project" });
    expect(mockedExecSync).not.toHaveBeenCalledWith(expect.stringContaining("git worktree prune"), expect.anything());
  });

  it("does not run native prune when worktrunk fail-hard prune fails", async () => {
    const prune = vi.fn().mockRejectedValue(new Error("boom"));
    mockedResolveWorktreeBackend.mockReturnValue({
      kind: "worktrunk",
      create: vi.fn(),
      remove: vi.fn(),
      sync: vi.fn(),
      prune,
      resolveWorktreePath: vi.fn(),
    } as any);
    vi.mocked(store.getSettings).mockResolvedValue({ worktrunk: { enabled: true, onFailure: "fail" } } as any);

    await (manager as any).pruneWorktrees();

    expect(prune).toHaveBeenCalledTimes(1);
    expect(mockedExecSync).not.toHaveBeenCalledWith(expect.stringContaining("git worktree prune"), expect.anything());
  });

  it("falls back to native prune when worktrunk fallback-native prune fails", async () => {
    const prune = vi.fn().mockRejectedValue(new Error("boom"));
    mockedResolveWorktreeBackend.mockReturnValue({
      kind: "worktrunk",
      create: vi.fn(),
      remove: vi.fn(),
      sync: vi.fn(),
      prune,
      resolveWorktreePath: vi.fn(),
    } as any);
    vi.mocked(store.getSettings).mockResolvedValue({ worktrunk: { enabled: true, onFailure: "fallback-native" } } as any);

    await (manager as any).pruneWorktrees();

    expect(prune).toHaveBeenCalledTimes(1);
    expect(mockedExecSync).toHaveBeenCalledWith("git worktree prune", expect.objectContaining({ cwd: "/tmp/test-project", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }));
  });
});

describe("worktrunk-aware cleanup sweeps", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;
  let backendPrune: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMockStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    backendPrune = vi.fn().mockResolvedValue(undefined);
    mockedResolveWorktreeBackend.mockReturnValue({
      kind: "worktrunk",
      create: vi.fn(),
      remove: vi.fn(),
      sync: vi.fn(),
      prune: backendPrune,
      resolveWorktreePath: vi.fn(),
    } as any);
    vi.mocked(store.getSettings).mockResolvedValue({ worktrunk: { enabled: true, onFailure: "fail" } } as any);
    mockedExecSync.mockClear();
    mockedScanIdleWorktrees.mockClear();
    mockedReaddirSync.mockClear();
  });

  afterEach(() => {
    manager.stop();
  });

  it("cleanupOrphans short-circuits to backend prune when recycleWorktrees is false", async () => {
    vi.mocked(store.getSettings).mockResolvedValue({ worktrunk: { enabled: true }, recycleWorktrees: false } as any);

    const result = await (manager as any).cleanupOrphans();

    expect(result).toBe(0);
    expect(backendPrune).toHaveBeenCalledWith({ rootDir: "/tmp/test-project" });
    expect(mockedScanIdleWorktrees).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalledWith(expect.stringContaining("git worktree remove"), expect.anything());
  });

  it("cleanupOrphans short-circuits to backend prune when recycleWorktrees is true", async () => {
    const reapSpy = vi.spyOn(manager as any, "reapUnregisteredOrphans");
    vi.mocked(store.getSettings).mockResolvedValue({ worktrunk: { enabled: true }, recycleWorktrees: true } as any);

    const result = await (manager as any).cleanupOrphans();

    expect(result).toBe(0);
    expect(reapSpy).not.toHaveBeenCalled();
    expect(backendPrune).toHaveBeenCalledWith({ rootDir: "/tmp/test-project" });
    expect(mockedScanIdleWorktrees).not.toHaveBeenCalled();
  });

  it("reapUnregisteredOrphans short-circuits to backend prune", async () => {
    await (manager as any).reapUnregisteredOrphans();

    expect(backendPrune).toHaveBeenCalledWith({ rootDir: "/tmp/test-project" });
    expect(mockedReaddirSync).not.toHaveBeenCalled();
  });

  it("enforceWorktreeCap short-circuits to backend prune", async () => {
    await (manager as any).enforceWorktreeCap();

    expect(backendPrune).toHaveBeenCalledWith({ rootDir: "/tmp/test-project" });
    expect(mockedScanIdleWorktrees).not.toHaveBeenCalled();
    expect(mockedReaddirSync).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalledWith(expect.stringContaining("git worktree remove"), expect.anything());
  });
});

describe("cleanupOrphanedBranches", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createMockStore({
      clearStaleExecutionStartBranchReferences: vi.fn().mockReturnValue([]),
    });
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    mockedScanOrphanedBranches.mockReset();
    mockedExecSync.mockReset();
  });

  afterEach(() => {
    manager.stop();
  });

  it("prunes subsumed orphan branches and emits branch:orphan-prune", async () => {
    mockedScanOrphanedBranches.mockResolvedValue(["fusion/FN-777"]);
    mockedExecSync.mockImplementation((command: string) => {
      if (command.startsWith("git rev-parse --verify")) return "abc123\n" as any;
      if (command.startsWith("git rev-list --count")) return "0\n" as any;
      if (command.startsWith("git branch -d")) return "" as any;
      return "" as any;
    });

    const result = await (manager as any).cleanupOrphanedBranches();

    expect(result).toBe(1);
    expect(mockedExecSync).toHaveBeenCalledWith(expect.stringContaining("git branch -d"), expect.anything());
    expect(vi.mocked(store.recordRunAuditEvent)).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "branch:orphan-prune" }));
  });

  it("leaves unique-commit orphan branches untouched", async () => {
    mockedScanOrphanedBranches.mockResolvedValue(["fusion/FN-888"]);
    mockedExecSync.mockImplementation((command: string) => {
      if (command.startsWith("git rev-parse --verify")) return "def456\n" as any;
      if (command.startsWith("git rev-list --count")) return "2\n" as any;
      return "" as any;
    });

    const result = await (manager as any).cleanupOrphanedBranches();

    expect(result).toBe(0);
    expect(mockedExecSync).not.toHaveBeenCalledWith(expect.stringContaining("git branch -d"), expect.anything());
    expect(vi.mocked(store.createTask)).not.toHaveBeenCalled();
  });
});

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
    (vi.spyOn(manager as any, "enforceWorktreeCap").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverCompletedTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverStaleIncompleteReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverInterruptedMergingTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverStaleMergingStatus").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverMergeableReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverMergedReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverStuckMergeDeadlocks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverMisclassifiedFailures").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverNoProgressNoTaskDoneFailures").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverPartialProgressNoTaskDoneFailures").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverOrphanedExecutions").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverApprovedTriageTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverOrphanedPlanningTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverGhostReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "archiveStaleDoneTasks").mockResolvedValue(0) as any);

    await (manager as any).runMaintenance();

    expect((manager as any).maintenanceRunning).toBe(false);
  });

  it("uses a passive WAL checkpoint during maintenance", async () => {
    (vi.spyOn(manager as any, "pruneWorktrees").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "cleanupOrphans").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "enforceWorktreeCap").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverCompletedTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverStaleIncompleteReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverInterruptedMergingTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverStaleMergingStatus").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverMergeableReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverMergedReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverStuckMergeDeadlocks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverMisclassifiedFailures").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverNoProgressNoTaskDoneFailures").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverPartialProgressNoTaskDoneFailures").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverOrphanedExecutions").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverApprovedTriageTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverOrphanedPlanningTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "recoverGhostReviewTasks").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "archiveStaleDoneTasks").mockResolvedValue(0) as any);

    await (manager as any).runMaintenance();

    expect(store.walCheckpoint).toHaveBeenCalledWith("PASSIVE");
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
    makeSlow("recoverStrandedCompletedTodoTasks");
    makeSlow("recoverStaleIncompleteReviewTasks");
    makeSlow("recoverInterruptedMergingTasks");
    makeSlow("recoverStaleMergingStatus");
    makeSlow("finalizeNoOpReviewTasks");
    makeSlow("recoverMergeableReviewTasks");
    makeSlow("recoverMergedReviewTasks");
    makeSlow("recoverStuckMergeDeadlocks");
    makeSlow("recoverMisclassifiedFailures");
    makeSlow("recoverNoProgressNoTaskDoneFailures");
    makeSlow("recoverPartialProgressNoTaskDoneFailures");
    makeSlow("recoverOrphanedExecutions");
    makeSlow("recoverApprovedTriageTasks");
    makeSlow("recoverOrphanedPlanningTasks");
    makeSlow("recoverGhostReviewTasks");
    makeSlow("recoverOrphanedAgents");
    makeSlow("recoverStaleHeartbeatRuns");
    makeSlow("clearStaleBlockedBy");

    await (manager as any).runMaintenance();

    // Operations run sequentially (one at a time), not in parallel.
    expect(maxConcurrent).toBe(1);
    // All operations should have run (including last one)
    expect(executionOrder[executionOrder.length - 1]).toBe("clearStaleBlockedBy");
  });

  it("one failing batch 2 operation does not abort the batch", async () => {
    const batch2Operations = [
      "recoverCompletedTasks",
      "recoverStrandedCompletedTodoTasks",
      "recoverStaleIncompleteReviewTasks",
      "recoverInterruptedMergingTasks",
      "recoverStaleMergingStatus",
      "finalizeNoOpReviewTasks",
      "recoverMergeableReviewTasks",
      "recoverMergedReviewTasks",
      "recoverStuckMergeDeadlocks",
      "recoverMisclassifiedFailures",
      "recoverNoProgressNoTaskDoneFailures",
      "recoverPartialProgressNoTaskDoneFailures",
      "recoverOrphanedExecutions",
      "recoverApprovedTriageTasks",
      "recoverOrphanedPlanningTasks",
      "recoverGhostReviewTasks",
      "recoverOrphanedAgents",
      "recoverStaleHeartbeatRuns",
      "clearStaleBlockedBy",
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
    (vi.spyOn(manager as any, "enforceWorktreeCap").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "archiveStaleDoneTasks").mockResolvedValue(0) as any);

    // Should not throw — Promise.allSettled handles failures
    await expect((manager as any).runMaintenance()).resolves.toBeUndefined();
  });
});

describe("SelfHealingManager reclaimSelfOwnedBranchConflicts", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false } as any),
    });
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    mockedIsUsableTaskWorktree.mockResolvedValue(true);
  });

  afterEach(() => {
    manager.stop();
    vi.restoreAllMocks();
  });

  it("reclaims fully-subsumed branch conflicts and emits subsumed audit metadata", async () => {
    store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false } as any),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    });
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    (store.listTasks as any)
      .mockResolvedValueOnce([{ id: "FN-509", checkedOutBy: null, branch: "fusion/fn-509", worktree: "/tmp/fn-509", lineageId: "lin-9" }])
      .mockResolvedValueOnce([]);
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "fully-subsumed",
      livePath: "/tmp/fn-509",
      tipSha: "abc123def456",
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();
    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-509", expect.objectContaining({ worktree: null, branch: null, status: null, paused: false }));
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "git",
        mutationType: "branch:auto-reclaim",
        target: "fusion/fn-509",
        metadata: expect.objectContaining({ subsumed: true, strandedCommitCount: 0 }),
      }),
    );
  });

  it("reclaims stranded same-task branch conflicts", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([{ id: "FN-500", checkedOutBy: null, branch: "fusion/fn-500", worktree: "/tmp/fn-500", lineageId: "lin-1" }])
      .mockResolvedValueOnce([]);
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "reclaimable",
      livePath: "/tmp/fn-500",
      tipSha: "abc123def456",
      taskAttributedCommitCount: 2,
      strandedCommits: [{ sha: "abc123", subject: "work" }],
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();
    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-500", expect.objectContaining({ worktree: "/tmp/fn-500", branch: "fusion/fn-500", status: null, paused: false }));
  });

  it("skips blocked todo tasks with preserved branches", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([{ id: "FN-516", column: "todo", blockedBy: "FN-216", checkedOutBy: null, branch: "fusion/fn-516", worktree: "/tmp/fn-516" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const inspectSpy = vi.spyOn(branchConflictModule, "inspectBranchConflict");

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("skips checked out tasks and emits no-action telemetry", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([{ id: "FN-501", checkedOutBy: "agent-1", branch: "fusion/fn-501", worktree: "/tmp/fn-501" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const inspectSpy = vi.spyOn(branchConflictModule, "inspectBranchConflict");

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();
    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reclaim-self-owned-branch-conflict-no-action",
      target: "FN-501",
      metadata: expect.objectContaining({ reason: "checked-out-lease-active" }),
    }));
  });

  it("skips tasks with recent active heartbeat runs", async () => {
    const agentStore = {
      listActiveHeartbeatRuns: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          agentId: "agent-1",
          startedAt: new Date().toISOString(),
          endedAt: null,
          status: "active",
          contextSnapshot: { taskId: "FN-777" },
        },
      ]),
    } as any;
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

    (store.listTasks as any)
      .mockResolvedValueOnce([{ id: "FN-777", checkedOutBy: null, branch: "fusion/fn-777", worktree: "/tmp/fn-777" }])
      .mockResolvedValueOnce([]);

    const inspectSpy = vi.spyOn(branchConflictModule, "inspectBranchConflict");
    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
  });

  it("scans todo, in-progress, and paused in-review columns", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(store.listTasks).toHaveBeenNthCalledWith(1, { column: "todo", slim: true });
    expect(store.listTasks).toHaveBeenNthCalledWith(2, { column: "in-progress", slim: true });
    expect(store.listTasks).toHaveBeenNthCalledWith(3, { column: "in-review", slim: true });
  });

  it("escalates live-foreign conflicts to in-review failed", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([{ id: "FN-503", checkedOutBy: null, branch: "fusion/fn-503", worktree: "/tmp/fn-503" }])
      .mockResolvedValueOnce([]);
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "live-foreign",
      livePath: "/tmp/fn-503",
      error: new Error("foreign branch owner"),
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();
    expect(recovered).toBe(0);
    expect(store.updateTask).toHaveBeenCalledWith("FN-503", expect.objectContaining({
      status: "failed",
      paused: true,
      pausedReason: "branch-conflict-unrecoverable",
    }));
    expect(store.handoffToReview).toHaveBeenCalledWith("FN-503", expect.objectContaining({
      evidence: expect.objectContaining({ reason: "branch-conflict-unrecoverable-repromote" }),
    }));
  });

  it("preserves dirty worktree as recovery patch before unrecoverable escalation", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "fn-4476-self-heal-"));
    manager = new SelfHealingManager(store, { rootDir: fixtureRoot });

    (store.listTasks as any)
      .mockResolvedValueOnce([{ id: "FN-504", checkedOutBy: null, branch: "fusion/fn-504", worktree: "/tmp/fn-504" }])
      .mockResolvedValueOnce([]);
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockRejectedValueOnce(new Error("boom"));
    mockedExecSync.mockImplementation((cmd: any) => {
      const command = String(cmd);
      if (command === "git status --porcelain") {
        return Buffer.from(" M src/file.ts\n");
      }
      if (command === "git diff HEAD --binary") {
        return Buffer.from("diff --git a/src/file.ts b/src/file.ts\n");
      }
      return Buffer.from("");
    });

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();
    expect(recovered).toBe(0);
    expect(store.handoffToReview).toHaveBeenCalledWith("FN-504", expect.objectContaining({
      evidence: expect.objectContaining({ reason: "branch-conflict-unrecoverable-repromote" }),
    }));

    const recoveryDir = join(fixtureRoot, ".fusion", "recovery");
    const files = await readdir(recoveryDir);
    const patchName = files.find((entry) => entry.startsWith("fn-504-") && entry.endsWith(".patch"));
    expect(patchName).toBeTruthy();
    const patchContent = await readFile(join(recoveryDir, patchName ?? ""), "utf-8");
    expect(patchContent).toContain("diff --git");
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("escalates unrecoverable reclaim failures to in-review failed", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([{ id: "FN-502", checkedOutBy: null, branch: "fusion/fn-502", worktree: "/tmp/fn-502" }])
      .mockResolvedValueOnce([]);
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockRejectedValueOnce(new Error("boom"));

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();
    expect(recovered).toBe(0);
    expect(store.updateTask).toHaveBeenCalledWith("FN-502", expect.objectContaining({
      status: "failed",
      paused: true,
      pausedReason: "branch-conflict-unrecoverable",
    }));
    expect(store.handoffToReview).toHaveBeenCalledWith("FN-502", expect.objectContaining({
      evidence: expect.objectContaining({ reason: "branch-conflict-unrecoverable-repromote" }),
    }));
  });
});

describe("SelfHealingManager reclaimStaleActiveBranches (FN-4546)", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    mockedExecSync.mockReset();
    store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false } as any),
      recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
    });
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    mockedIsUsableTaskWorktree.mockResolvedValue(true);
  });

  it("reclaims subsumed fusion task branch with no worktree", async () => {
    (store.listTasks as any).mockResolvedValueOnce([
      { id: "FN-1001", column: "todo", checkedOutBy: null, userPaused: false, worktree: null, branch: null, lineageId: "lin-1" },
    ]);

    mockedExecSync.mockImplementation((command: string) => {
      if (command.includes("git branch --list 'fusion/*'")) return Buffer.from("  fusion/fn-1001\n");
      if (command.includes("git rev-parse --verify") && command.includes("fusion/fn-1001")) return Buffer.from("abc123def456\n");
      if (command.includes("git rev-list --count") && command.includes("fusion/fn-1001")) return Buffer.from("0\n");
      return Buffer.from("");
    });

    const recovered = await manager.reclaimStaleActiveBranches();

    expect(recovered).toBe(1);
    expect(mockedExecSync).toHaveBeenCalledWith(expect.stringContaining("git branch -D \"fusion/fn-1001\""), expect.anything());
    expect(mockedExecSync).toHaveBeenCalledWith(expect.stringContaining("git worktree prune"), expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-1001", { worktree: null, branch: null, baseCommitSha: null });
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      domain: "git",
      mutationType: "branch:stale-active-reclaim",
      target: "fusion/fn-1001",
    }));
  });

  it("does not delete branch with unique commits", async () => {
    (store.listTasks as any).mockResolvedValueOnce([
      { id: "FN-1001", column: "todo", checkedOutBy: null, userPaused: false, worktree: null, branch: null },
    ]);

    mockedExecSync.mockImplementation((command: string) => {
      if (command.includes("git branch --list 'fusion/*'")) return Buffer.from("  fusion/fn-1001\n");
      if (command.includes("git rev-parse --verify") && command.includes("fusion/fn-1001")) return Buffer.from("abc123def456\n");
      if (command.includes("git rev-list --count") && command.includes("fusion/fn-1001")) return Buffer.from("3\n");
      if (command.includes("git log --format=%s")) return Buffer.from("feat: keep me\n");
      return Buffer.from("");
    });

    const recovered = await manager.reclaimStaleActiveBranches();

    expect(recovered).toBe(0);
    expect(mockedExecSync).not.toHaveBeenCalledWith(expect.stringContaining("git branch -D \"fusion/fn-1001\""), expect.anything());
    expect(getSelfHealingLogger().warn).toHaveBeenCalledWith(expect.stringContaining("stale-active-branch-rescue-needed FN-1001"));
  });

  it("skips task with active heartbeat run", async () => {
    const agentStore = {
      listActiveHeartbeatRuns: vi.fn().mockResolvedValue([{ startedAt: new Date().toISOString(), contextSnapshot: { taskId: "FN-1001" } }]),
    } as any;
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });
    (store.listTasks as any).mockResolvedValueOnce([
      { id: "FN-1001", column: "todo", checkedOutBy: null, userPaused: false, worktree: null, branch: null },
    ]);
    mockedExecSync.mockImplementation((command: string) => {
      if (command.includes("git branch --list 'fusion/*'")) return Buffer.from("  fusion/fn-1001\n");
      return Buffer.from("");
    });

    const recovered = await manager.reclaimStaleActiveBranches();

    expect(recovered).toBe(0);
    expect(mockedExecSync).not.toHaveBeenCalledWith(expect.stringContaining("git branch -D \"fusion/fn-1001\""), expect.anything());
  });

  it("skips task with usable worktree", async () => {
    (store.listTasks as any).mockResolvedValueOnce([
      { id: "FN-1001", column: "todo", checkedOutBy: null, userPaused: false, worktree: "/tmp/fn-1001", branch: null },
    ]);
    mockedIsUsableTaskWorktree.mockResolvedValueOnce(true);
    mockedExecSync.mockImplementation((command: string) => {
      if (command.includes("git branch --list 'fusion/*'")) return Buffer.from("  fusion/fn-1001\n");
      return Buffer.from("");
    });

    const recovered = await manager.reclaimStaleActiveBranches();

    expect(recovered).toBe(0);
    expect(mockedExecSync).not.toHaveBeenCalledWith(expect.stringContaining("git branch -D \"fusion/fn-1001\""), expect.anything());
  });

  it("skips user-paused task", async () => {
    (store.listTasks as any).mockResolvedValueOnce([
      { id: "FN-1001", column: "todo", checkedOutBy: null, userPaused: true, worktree: null, branch: null },
    ]);
    mockedExecSync.mockImplementation((command: string) => {
      if (command.includes("git branch --list 'fusion/*'")) return Buffer.from("  fusion/fn-1001\n");
      return Buffer.from("");
    });

    const recovered = await manager.reclaimStaleActiveBranches();

    expect(recovered).toBe(0);
    expect(mockedExecSync).not.toHaveBeenCalledWith(expect.stringContaining("git branch -D \"fusion/fn-1001\""), expect.anything());
  });
});

describe("SelfHealingManager no-commits-expected audit", () => {
  it("logs candidate task IDs without mutating tasks", async () => {
    const store = createMockStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const now = new Date().toISOString();
    const candidate = {
      id: "FN-900",
      column: "in-review",
      status: "failed",
      error: "fn_task_done refused: no_commits",
      noCommitsExpected: undefined,
      branch: "fusion/fn-900",
      baseBranch: "main",
      paused: false,
      steps: [{ id: "s1", name: "done", status: "done" }],
      log: [],
      createdAt: now,
      updatedAt: now,
      description: "audit",
      dependencies: [],
      currentStep: 1,
    } as unknown as Task;

    vi.mocked(store.listTasks)
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([candidate]);

    mockedExecSync.mockImplementation((command: string) => {
      if (command.includes("git rev-list --count")) {
        return Buffer.from("0\n");
      }
      return Buffer.from("ok\n");
    });

    const count = await manager.auditNoCommitsExpectedCandidates();
    expect(count).toBe(1);
    expect(getSelfHealingLogger().warn).toHaveBeenCalledWith(expect.stringContaining("FN-900"));
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});

describe("autoMerge gating for mutating in-review sweeps (FN-5147)", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createMockStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      taskStuckTimeoutMs: 1_000,
      maxPostReviewFixes: 1,
    });

    // Seed real, stale in-review sweep candidates with NO per-task autoMerge
    // override. Each fixture matches a distinct covered sweep's candidate shape
    // and would be mutated if the per-task gate (allowsAutoMergeProcessing) were
    // ignored. Because the global setting is autoMerge:false and none of these
    // carry autoMerge:true, every sweep must enumerate them and skip them solely
    // due to the gate — which is the regression under test. The gate is the
    // first/early filter in each sweep, so candidates are dropped before any
    // store.getTask / git helper is reached.
    const stale = new Date(Date.now() - 600_000).toISOString();
    const seededInReviewCandidates = [
      // recoverStaleIncompleteReviewTasks + recoverGhostReviewTasks:
      // idle in-review with incomplete steps, stale.
      {
        id: "FN-GATE-INCOMPLETE",
        column: "in-review",
        paused: false,
        steps: [{ status: "pending" }],
        log: [],
        updatedAt: stale,
        columnMovedAt: stale,
      },
      // recoverInterruptedMergingTasks: stale `merging` status.
      {
        id: "FN-GATE-MERGING",
        column: "in-review",
        paused: false,
        status: "merging",
        steps: [],
        log: [],
        updatedAt: stale,
        columnMovedAt: stale,
      },
      // recoverMergedReviewTasks + recoverGhostReviewTasks(skip merge-confirmed):
      // mergeConfirmed:true stuck in in-review.
      {
        id: "FN-GATE-MERGED",
        column: "in-review",
        paused: false,
        steps: [],
        log: [],
        mergeDetails: { mergeConfirmed: true },
        updatedAt: stale,
        columnMovedAt: stale,
      },
      // recoverStuckMergeDeadlocks + recoverAlreadyMergedReviewTasks +
      // recoverOrphanOnlyScopeViolations: failed in-review, retries exhausted,
      // worktree present.
      {
        id: "FN-GATE-FAILED",
        column: "in-review",
        paused: false,
        status: "failed",
        steps: [],
        log: [],
        mergeRetries: MAX_AUTO_MERGE_RETRIES,
        worktree: "/tmp/test-project/.worktrees/FN-GATE-FAILED",
        branch: "fn/FN-GATE-FAILED",
        updatedAt: stale,
        columnMovedAt: stale,
      },
      // recoverReviewTasksWithFailedPreMergeSteps: idle in-review whose merge is
      // blocked specifically by a failed pre-merge workflow step, worktree set.
      {
        id: "FN-GATE-PREMERGE",
        column: "in-review",
        paused: false,
        steps: [],
        log: [],
        worktree: "/tmp/test-project/.worktrees/FN-GATE-PREMERGE",
        workflowStepResults: [{ phase: "pre-merge", status: "failed" }],
        updatedAt: stale,
        columnMovedAt: stale,
      },
      // recoverMissingWorktreeReviewFailures: failed by missing-worktree session
      // start, with step progress.
      {
        id: "FN-GATE-MISSINGWT",
        column: "in-review",
        paused: false,
        status: "failed",
        error: "Refusing to start coding agent in missing worktree: /tmp/gone",
        steps: [{ status: "done" }],
        log: [],
        updatedAt: stale,
        columnMovedAt: stale,
      },
      // recoverPartialProgressNoTaskDoneFailures: failed without fn_task_done,
      // partial step progress, not work-complete, retries available.
      {
        id: "FN-GATE-NOTASKDONE",
        column: "in-review",
        paused: false,
        status: "failed",
        error: "Agent finished without calling fn_task_done",
        steps: [{ status: "done" }, { status: "pending" }],
        log: [],
        updatedAt: stale,
        columnMovedAt: stale,
      },
      // recoverForeignOnlyContaminatedInReviewTasks: in-review with branch +
      // worktree, not merge-confirmed.
      {
        id: "FN-GATE-FOREIGN",
        column: "in-review",
        paused: false,
        branch: "fn/FN-GATE-FOREIGN",
        worktree: "/tmp/test-project/.worktrees/FN-GATE-FOREIGN",
        steps: [],
        log: [],
        updatedAt: stale,
        columnMovedAt: stale,
      },
      // recoverCompletionHandoffLimbo: idle in-review with no status/mergeDetails/
      // review, an aged "Task marked done by agent" log marker, no merge blocker.
      {
        id: "FN-GATE-HANDOFF",
        column: "in-review",
        paused: false,
        steps: [],
        log: [{ action: "Task marked done by agent", timestamp: stale }],
        updatedAt: stale,
        columnMovedAt: stale,
      },
      // reclaimSelfOwnedBranchConflicts: in-review branch-conflict-unrecoverable.
      // (No worktree, so even absent the gate it is skipped before any git call;
      // the gate is what the assertions verify.)
      {
        id: "FN-GATE-RECLAIM",
        column: "in-review",
        paused: true,
        pausedReason: "branch-conflict-unrecoverable",
        branch: "fn/FN-GATE-RECLAIM",
        steps: [],
        log: [],
        updatedAt: stale,
        columnMovedAt: stale,
      },
    ] as unknown as Task[];

    // Resolve fixtures only for the in-review column the sweeps enumerate; other
    // columns (todo / in-progress / triage) stay empty so the non-auto-merge-
    // gated branches of reclaim/foreign-only sweeps don't reach git helpers.
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts?: { column?: string }) =>
        opts?.column === "in-review" ? seededInReviewCandidates : [],
    );
  });

  afterEach(() => {
    manager.stop();
  });

  it.each([
    "recoverReviewTasksWithFailedPreMergeSteps",
    "recoverStaleIncompleteReviewTasks",
    "recoverGhostReviewTasks",
    "recoverInterruptedMergingTasks",
    "recoverMergedReviewTasks",
    "recoverStuckMergeDeadlocks",
    "recoverOrphanOnlyScopeViolations",
    "recoverAlreadyMergedReviewTasks",
    "recoverForeignOnlyContaminatedInReviewTasks",
    "recoverMissingWorktreeReviewFailures",
    "recoverPartialProgressNoTaskDoneFailures",
    "reclaimSelfOwnedBranchConflicts",
  ] as const)("performs no mutations when autoMerge is disabled and no per-task override exists: %s", async (methodName) => {
    if (methodName === "recoverReviewTasksWithFailedPreMergeSteps") {
      manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project", recoverFailedPreMergeStep: vi.fn() });
    }
    const result = await (manager as any)[methodName]();
    expect(result).toBe(0);
    // Enumeration must have happened: the sweep listed real, stale in-review
    // candidates seeded above. Mutations are skipped solely because of the
    // per-task auto-merge gate (respects PR-based review flow) — so these
    // assertions are non-vacuous.
    expect(store.listTasks).toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("performs no mutations when autoMerge is disabled and no per-task override exists: recoverCompletionHandoffLimbo", async () => {
    const result = await manager.recoverCompletionHandoffLimbo();
    expect(result).toBeUndefined();
    // The seeded FN-GATE-HANDOFF candidate carries an aged "Task marked done by
    // agent" marker and no merge blocker, so the sweep enumerates it and would
    // requeue/fail it absent the per-task gate.
    expect(store.listTasks).toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("surfaces in-review stalls for tasks with an explicit autoMerge:true override when the global setting is off", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: false,
        globalPause: false,
        enginePaused: false,
        taskStuckTimeoutMs: 60_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-OVERRIDE",
          column: "in-review",
          paused: false,
          status: "merging",
          autoMerge: true,
          steps: [],
          log: [],
          updatedAt: new Date(Date.parse("2026-01-01T00:10:00.000Z") - 600_000).toISOString(),
          columnMovedAt: new Date(Date.parse("2026-01-01T00:10:00.000Z") - 600_000).toISOString(),
        },
      ]);

      const surfaced = await manager.surfaceInReviewStalls();

      expect(surfaced).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-OVERRIDE",
        expect.stringContaining("In-review stall surfaced ["),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps skipping override-less siblings while processing the override task", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const staleFields = {
        column: "in-review",
        paused: false,
        status: "merging",
        steps: [],
        log: [],
        updatedAt: new Date(Date.parse("2026-01-01T00:10:00.000Z") - 600_000).toISOString(),
        columnMovedAt: new Date(Date.parse("2026-01-01T00:10:00.000Z") - 600_000).toISOString(),
      };
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoMerge: false,
        globalPause: false,
        enginePaused: false,
        taskStuckTimeoutMs: 60_000,
      });
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "FN-OVERRIDE", autoMerge: true, ...staleFields },
        { id: "FN-MANUAL", ...staleFields },
      ]);

      const surfaced = await manager.surfaceInReviewStalls();

      expect(surfaced).toBe(1);
      expect(store.logEntry).not.toHaveBeenCalledWith(
        "FN-MANUAL",
        expect.stringContaining("In-review stall surfaced ["),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FN-5335 triple-proof no-action unit coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T12:00:00.000Z"));
    activeSessionRegistry.clear();
    executingTaskLock._clearForTest();
    mockedClassifyTaskWorktree.mockResolvedValue({ ok: true } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits stale-incomplete-review no-action when triple proof fails", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, autoMerge: true, taskStuckTimeoutMs: 1_000 } as any),
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-SIR", column: "in-review", paused: false, status: null, worktree: "/tmp/fn-sir", updatedAt: new Date(Date.now() - 5_000).toISOString(), steps: [{ status: "pending" }] }]),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.recoverStaleIncompleteReviewTasks();
    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:stale-incomplete-review-no-action" }));
  });

  it("emits ghost-review no-action when triple proof fails", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, autoMerge: true, taskStuckTimeoutMs: 1_000 } as any),
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-GHOST", column: "in-review", worktree: "/tmp/fn-ghost", updatedAt: new Date(Date.now() - 5_000).toISOString(), columnMovedAt: new Date(Date.now() - 5_000).toISOString(), paused: false, status: null, mergeDetails: {} }]),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.recoverGhostReviewTasks();
    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:ghost-review-no-action" }));
  });

  it("emits no-progress no-action when triple proof fails", async () => {
    const store = createMockStore({
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-NP", column: "in-progress", worktree: "/tmp/fn-np", status: "failed", paused: false, error: "Agent finished without calling fn_task_done", updatedAt: new Date(Date.now() - 5_000).toISOString(), executionStartedAt: new Date(Date.now() - 5_000).toISOString(), steps: [{ id: "1", title: "a", status: "pending" }] }]),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    vi.spyOn(manager as any, "hasRecoverableGitWork").mockResolvedValue(false);
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: false, reason: "test" });
    const recovered = await manager.recoverNoProgressNoTaskDoneFailures();
    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:no-progress-no-task-done-no-action" }));
  });

  it("emits missing-worktree-review no-action when triple proof fails", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false } as any),
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-MWR", column: "in-review", paused: false, status: "failed", worktree: "/tmp/fn-mwr", branch: "fusion/fn-mwr", error: "Refusing to start coding agent in missing worktree: /tmp/fn-mwr", updatedAt: new Date(Date.now() - 10_000).toISOString(), steps: [{ status: "done" }, { status: "pending" }], log: [] }]),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.recoverMissingWorktreeReviewFailures();
    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:missing-worktree-review-no-action" }));
  });

  it("emits partial-progress no-action when triple proof fails", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false } as any),
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-PP", column: "in-review", paused: false, status: "failed", error: "Agent finished without calling fn_task_done", updatedAt: new Date(Date.now() - 10_000).toISOString(), taskDoneRetryCount: 1, steps: [{ status: "done" }, { status: "pending" }], worktree: "/tmp/fn-pp", branch: "fusion/fn-pp" }]),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.recoverPartialProgressNoTaskDoneFailures();
    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:partial-progress-no-task-done-no-action" }));
  });

  it("emits stuck-merge-deadlock no-action when no-landed branch fails proof", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false, defaultBaseBranch: "main" } as any),
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-SMD", column: "in-review", paused: false, status: "failed", mergeRetries: 3, mergeDetails: undefined, worktree: "/tmp/wt", branch: "fusion/fn-smd", updatedAt: new Date(Date.now() - 100_000).toISOString(), log: [] }]),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: false, reason: "test" });
    mockedExecSync.mockReturnValue("" as any);

    const recovered = await manager.recoverStuckMergeDeadlocks();
    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-SMD", { paused: true });
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:stuck-merge-deadlock-no-action" }));
  });

  it("emits auto-rebound paused-scope no-action when triple proof fails", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, pausedScopeDecayMs: 1_000 } as any),
      listTasks: vi.fn().mockResolvedValue([
        { id: "FN-HOLDER", column: "in-progress", paused: true, pausedReason: "waiting", blockedBy: null, worktree: "/tmp/wt-holder", updatedAt: new Date(Date.now() - 10_000).toISOString(), executionStartedAt: new Date(Date.now() - 10_000).toISOString() },
        { id: "FN-FOLLOW", column: "todo", paused: false, blockedBy: "FN-HOLDER" },
      ]),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    mockedClassifyTaskWorktree.mockResolvedValue({ ok: true } as any);

    const recovered = await manager.autoReboundPausedScopeDecay();
    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:auto-rebound-scope-decay-no-action" }));
  });

  it("emits reclaim-pr-conflict no-action when triple proof fails", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false, taskStuckTimeoutMs: 1_000 } as any),
      getTask: vi.fn().mockResolvedValue({ id: "FN-PR", column: "in-review", paused: false, status: null, worktree: "/tmp/wt-pr", branch: "fusion/fn-pr", prInfo: { number: 1, mergeable: "conflicting" }, updatedAt: new Date(Date.now() - 10_000).toISOString() }),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: false, reason: "test" });
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({ kind: "reclaimable", livePath: "/tmp/wt-pr", tipSha: "abc", taskAttributedCommitCount: 1, strandedCommits: [{ sha: "abc", subject: "work" }] } as any);

    const result = await manager.reclaimPrConflictForTask("FN-PR");
    expect(result.outcome).toBe("skipped");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:reclaim-pr-conflict-no-action" }));
  });

  it("emits reclaim-self-owned-branch-conflict no-action when triple proof fails", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false, taskStuckTimeoutMs: 1_000 } as any),
      listTasks: vi.fn().mockResolvedValue([
        {
          id: "FN-RSBC",
          column: "in-review",
          status: "failed",
          error: "branch-conflict-unrecoverable: conflict",
          branch: "fusion/fn-rsbc",
          worktree: "/tmp/wt-rsbc",
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
        },
      ]),
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: false, reason: "test" });
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({ kind: "reclaimable", tipSha: "abc", taskAttributedCommitCount: 1, strandedCommits: [{ sha: "abc", subject: "work" }] } as any);

    const result = await manager.reclaimSelfOwnedBranchConflicts();
    expect(result).toBeGreaterThanOrEqual(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:reclaim-self-owned-branch-conflict-no-action" }));
  });

  it("returns active merge task id via public accessor", () => {
    const manager = new SelfHealingManager(createMockStore(), {
      rootDir: "/tmp/test-project",
      getActiveMergeTaskId: () => "FN-MERGE",
    });

    expect(manager.getActiveMergeTaskId()).toBe("FN-MERGE");
  });

  it("emits finalize-no-op-review no-action when unproven fallback fails triple proof", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false } as any),
      listTasks: vi.fn().mockResolvedValue([
        {
          id: "FN-NOOP",
          column: "in-review",
          paused: false,
          status: null,
          worktree: "/tmp/test-project/.worktrees/fn-noop",
          branch: "fusion/fn-noop",
          steps: [{ name: "Ship it", status: "done" }],
          workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
          mergeDetails: undefined,
          updatedAt: new Date(Date.now() - 10_000).toISOString(),
          log: [],
        },
      ]),
    });
    (store as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: false, reason: "test" });
    mockedClassifyOwnedLandedEvidence.mockResolvedValueOnce({
      kind: "unproven",
      reason: "foreign-start-point",
      details: { foreignRef: "fusion/fn-a" },
    } as any);
    mockedExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd.includes("rev-parse --verify 'fusion/fn-noop'")) return "ok" as any;
      if (cmd.includes("rev-parse --verify 'main'")) return "ok" as any;
      if (cmd.includes("rev-list --count 'main'..'fusion/fn-noop'")) return "0\n" as any;
      return "" as any;
    });

    const result = await manager.finalizeNoOpReviewTasks();
    expect(result).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-NOOP", "todo", expect.anything());
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:finalize-no-op-review-no-action" }));
  });

});
