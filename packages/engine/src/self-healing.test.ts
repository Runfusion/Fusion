import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("./worktree-pool.js", () => ({
  WorktreePool: vi.fn(),
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  scanOrphanedBranches: vi.fn().mockResolvedValue([]),
}));

import { SelfHealingManager } from "./self-healing.js";
import type { TaskStore, Settings, Task } from "@fusion/core";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { scanOrphanedBranches } from "./worktree-pool.js";

const mockedExecSync = vi.mocked(execSync);
const mockedScanOrphanedBranches = vi.mocked(scanOrphanedBranches);

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
    walCheckpoint: vi.fn().mockReturnValue({ busy: 0, log: 5, checkpointed: 5 }),
    listTasks: vi.fn().mockResolvedValue([]),
    getRootDir: vi.fn().mockReturnValue("/tmp/test-project"),
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
    it("schedules unpause when globalPause transitions false→true", async () => {
      manager.start();

      store.emit("settings:updated", {
        settings: { globalPause: true, autoUnpauseEnabled: true, autoUnpauseBaseDelayMs: 100, autoUnpauseMaxDelayMs: 800 },
        previous: { globalPause: false },
      });

      await vi.advanceTimersByTimeAsync(150);

      expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: false });
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
  });

  describe("recoverApprovedTriageTasks", () => {
    it("recovers approved specifying triage tasks that are not actively processing", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getSpecifying = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverApprovedTriageTask: recoverFn,
        getSpecifyingTaskIds: getSpecifying,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-100",
          column: "triage",
          status: "specifying",
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
      const getSpecifying = vi.fn().mockReturnValue(new Set(["FN-101"]));

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverApprovedTriageTask: recoverFn,
        getSpecifyingTaskIds: getSpecifying,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-101",
          column: "triage",
          status: "specifying",
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

    it("skips specifying triage tasks whose latest review is not APPROVE", async () => {
      const recoverFn = vi.fn().mockResolvedValue(true);
      const getSpecifying = vi.fn().mockReturnValue(new Set<string>());

      const managerWithRecovery = new SelfHealingManager(store, {
        rootDir: "/tmp/test-project",
        recoverApprovedTriageTask: recoverFn,
        getSpecifyingTaskIds: getSpecifying,
      });

      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "FN-102",
          column: "triage",
          status: "specifying",
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
});
