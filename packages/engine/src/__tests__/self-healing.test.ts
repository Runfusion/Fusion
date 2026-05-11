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

const { selfHealingLoggerMock } = vi.hoisted(() => ({
  selfHealingLoggerMock: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn((_name: string) => selfHealingLoggerMock),
}));

import { SelfHealingManager, isBranchAheadOfBase } from "../self-healing.js";
import type { TaskStore, Settings, Task, AgentStore, Agent } from "@fusion/core";
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
    mergeTask: vi.fn().mockResolvedValue(undefined),
    archiveTaskAndCleanup: vi.fn().mockResolvedValue({} as Task),
    walCheckpoint: vi.fn().mockReturnValue({ busy: 0, log: 5, checkpointed: 5 }),
    listTasks: vi.fn().mockResolvedValue([]),
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
      const clearStaleBlockedBy = vi.spyOn(manager, "clearStaleBlockedBy").mockResolvedValue(1);

      await manager.runStartupRecovery();

      expect(recoverNoProgressNoTaskDoneFailures).toHaveBeenCalledTimes(1);
      expect(recoverCompletedTasks).toHaveBeenCalledTimes(1);
      expect(recoverStuckMergeDeadlocks).toHaveBeenCalledTimes(1);
      expect(recoverMisclassifiedFailures).toHaveBeenCalledTimes(1);
      expect(recoverPartialProgressNoTaskDoneFailures).toHaveBeenCalledTimes(1);
      expect(recoverOrphanedExecutions).toHaveBeenCalledTimes(1);
      expect(recoverApprovedTriageTasks).toHaveBeenCalledTimes(1);
      expect(recoverOrphanedAgents).toHaveBeenCalledTimes(1);
      expect(clearStaleBlockedBy).toHaveBeenCalledTimes(1);
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

      expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, status: null });
      expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("Auto-recovered: cleared stale blockedBy"));
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

      expect(store.updateTask).not.toHaveBeenCalledWith("A", { blockedBy: null, status: null });
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

    it("recovers orphaned agent in error state", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        { id: "orphan-1", state: "error", updatedAt: new Date(now - 120_000).toISOString() } as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(1);
      expect(agentStore.updateAgentState).toHaveBeenCalledWith("orphan-1", "active");
      expect(agentStore.updateAgent).toHaveBeenCalledWith("orphan-1", { lastError: undefined });
      managerWithAgents.stop();
    });

    it("skips agents within grace period", async () => {
      vi.mocked(store.getSettings).mockResolvedValue({ taskStuckTimeoutMs: 60_000 } as unknown as Settings);
      const now = Date.now();
      const agentStore = createMockAgentStore([
        { id: "orphan-1", state: "error", updatedAt: new Date(now - 10_000).toISOString() } as Agent,
      ]);
      const managerWithAgents = new SelfHealingManager(store, { rootDir: "/tmp/test-project", agentStore });

      const result = await managerWithAgents.recoverOrphanedAgents();

      expect(result).toBe(0);
      expect(agentStore.updateAgent).not.toHaveBeenCalled();
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

    it("skips stale done tasks that have active dependents", async () => {
      vi.setSystemTime(new Date("2026-01-04T00:00:00.000Z"));
      (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        autoArchiveDoneTasksEnabled: true,
        autoArchiveDoneAfterMs: 24 * 60 * 60 * 1000,
      } as unknown as Settings);
      (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
        // Stale done — but a todo task depends on it. Must not be archived
        // because archiving wipes .fusion/tasks/{id}/ and downstream agents
        // are told they may read sibling task specs from disk.
        {
          id: "FN-100",
          column: "done",
          columnMovedAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          dependencies: [],
        },
        // Stale done — only a done dependent remains, archive is fine
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
          // Fresh — not stale. Demonstrates that a *done* dependent does
          // not block archive of FN-101.
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

  describe("recoverMissingWorktreeReviewFailures", () => {
    it("requeues failed in-review tasks with missing-worktree session-start errors", async () => {
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
        worktree: null,
        branch: null,
        sessionFile: null,
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-3900",
        expect.stringContaining("missing worktree"),
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-3900",
        expect.stringContaining("/tmp/project/.worktrees/fn-3900-stale"),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-3900", "todo", { preserveProgress: true });

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
      expect(store.moveTask).toHaveBeenCalledWith("FN-2164", "todo", { preserveProgress: true });

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
      expect(store.listTasks).not.toHaveBeenCalled();
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
        expect.stringContaining("Auto-finalized: branch has zero commits ahead of main"),
      );
      expect(enqueueMerge).not.toHaveBeenCalled();

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
      expect(store.listTasks).not.toHaveBeenCalled();

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
      expect(store.moveTask).toHaveBeenCalledWith("FN-1572", "todo", { preserveProgress: true });

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
      expect(store.moveTask).toHaveBeenCalledWith("FN-407-test-1", "todo", { preserveProgress: true });

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
      expect(store.moveTask).toHaveBeenCalledWith("FN-407-test-2", "todo", { preserveProgress: true });

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

    it("does not move paused merged tasks to done (respects user pause intent)", async () => {
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

      expect(result).toBe(0);
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();

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
      expect(
        mockedExecSync.mock.calls.some((call) => String(call[0]).includes("git worktree remove '/tmp/wt' --force")),
      ).toBe(true);
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
      expect(store.moveTask).toHaveBeenCalledWith("FN-9003", "todo", { preserveProgress: true });

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
      expect(store.moveTask).toHaveBeenCalledWith("FN-200", "todo", { preserveProgress: true });

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
      expect(store.moveTask).toHaveBeenCalledWith("FN-210", "todo", { preserveProgress: true });

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
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([taskA]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("FN-MISSING"));
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("missing"));
    manager.stop();
  });

  it.each(["done", "archived"] as const)("clears stale blockedBy when blocker is %s", async (column) => {
    const store = createRunningStore();
    const blockerId = "FN-100";
    const taskA = createTask("A", { blockedBy: blockerId });
    const taskB = createTask(blockerId, { column });
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([taskA, taskB]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining(blockerId));
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining(column));
    manager.stop();
  });

  it("clears stale blockedBy when blocker is in-review and paused", async () => {
    const store = createRunningStore();
    const blockerId = "FN-200";
    const taskA = createTask("A", { blockedBy: blockerId });
    const taskB = createTask(blockerId, { column: "in-review", paused: true });
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([taskA, taskB]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining(blockerId));
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("in-review + paused"));
    manager.stop();
  });

  it("clears stale blockedBy when blocker is in-review failed with exhausted retries", async () => {
    const store = createRunningStore();
    const blockerId = "FN-300";
    const taskA = createTask("A", { blockedBy: blockerId });
    const taskB = createTask(blockerId, { column: "in-review", status: "failed", mergeRetries: 3 });
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([taskA, taskB]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining(blockerId));
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("mergeRetries 3/3"));
    manager.stop();
  });

  it("does not clear blockedBy when blocker is in-progress", async () => {
    const store = createRunningStore();
    const taskA = createTask("A", { blockedBy: "FN-400" });
    const taskB = createTask("FN-400", { column: "in-progress" });
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([taskA, taskB]);

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
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([taskA, overlapBlocker, dependency]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("A", { blockedBy: null, status: null });
    expect(store.logEntry).toHaveBeenCalledWith("A", expect.stringContaining("not among unresolved dependencies"));
    manager.stop();
  });

  it("does not clear blockedBy when blocker is in-review and not paused/failed", async () => {
    const store = createRunningStore();
    const taskA = createTask("A", { blockedBy: "FN-500" });
    const taskB = createTask("FN-500", { column: "in-review", paused: false, mergeRetries: 0 });
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([taskA, taskB]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    manager.stop();
  });

  it("does not clear blockedBy when blocker failed retries are below threshold", async () => {
    const store = createRunningStore();
    const taskA = createTask("A", { blockedBy: "FN-600" });
    const taskB = createTask("FN-600", { column: "in-review", status: "failed", mergeRetries: 1 });
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([taskA, taskB]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const recovered = await manager.clearStaleBlockedBy();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
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
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([taskA]);

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
      .mockResolvedValueOnce([blocked, blocker])
      .mockResolvedValueOnce([blocked, blocker])
      .mockResolvedValueOnce([recoveredState, blocker]);

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const first = await manager.clearStaleBlockedBy();
    const second = await manager.clearStaleBlockedBy();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledTimes(1);
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
    (vi.spyOn(manager as any, "cleanupOrphanedBranches").mockResolvedValue(0) as any);
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
    (vi.spyOn(manager as any, "cleanupOrphanedBranches").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "enforceWorktreeCap").mockResolvedValue(0) as any);
    (vi.spyOn(manager as any, "archiveStaleDoneTasks").mockResolvedValue(0) as any);

    // Should not throw — Promise.allSettled handles failures
    await expect((manager as any).runMaintenance()).resolves.toBeUndefined();
  });
});
