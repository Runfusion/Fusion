/**
 * FN-190: Worktree lifecycle fix regression tests
 *
 * Covers all four lifecycle failure classes plus cross-repo safety:
 * AC1: Active-task phantom state reconciliation
 * AC2: Zero-commit active branch protection
 * AC3: Ghost-conflict prevention (tip-already-merged)
 * AC4: Completed-task stale blocker/lease reconciliation
 * AC5: Cross-repo safety guards
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

// ── Mocks ──────────────────────────────────────────────────────────────

const { execMock, execSyncMock, existsSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execSyncMock: vi.fn(() => ""),
  existsSyncMock: vi.fn(() => false),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execSync: execSyncMock,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});

const { uniqueCommitsMock, isAncestorMock, inspectBranchConflictMock } = vi.hoisted(() => ({
  uniqueCommitsMock: vi.fn(async () => ({ commits: [], mainRef: "main", degraded: false })),
  isAncestorMock: vi.fn(async () => false),
  inspectBranchConflictMock: vi.fn(),
}));
vi.mock("../branch-conflicts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../branch-conflicts.js")>();
  return {
    ...actual,
    listUniqueBranchCommits: uniqueCommitsMock,
    isAncestor: isAncestorMock,
    inspectBranchConflict: inspectBranchConflictMock,
  };
});

const { isUsableMock, activeSessionMock, removeWorktreeMock } = vi.hoisted(() => ({
  isUsableMock: vi.fn(async () => true),
  activeSessionMock: { isPathActive: vi.fn(() => false) },
  removeWorktreeMock: vi.fn(async () => undefined),
}));
vi.mock("../worktree-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree-pool.js")>();
  return {
    ...actual,
    isUsableTaskWorktree: isUsableMock,
  };
});

vi.mock("../active-session-registry.js", () => ({
  activeSessionRegistry: activeSessionMock,
}));

vi.mock("../worktree-backend.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree-backend.js")>();
  return {
    ...actual,
    removeWorktree: removeWorktreeMock,
  };
});

const { logger } = vi.hoisted(() => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../logger.js", () => ({ createLogger: vi.fn(() => logger) }));

vi.mock("../run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-audit.js")>();
  return {
    ...actual,
    generateSyntheticRunId: vi.fn(() => "synthetic-run-id"),
    createRunAuditor: vi.fn(() => ({
      git: vi.fn(async () => undefined),
      database: vi.fn(async () => undefined),
    })),
  };
});

import { SelfHealingManager, STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS } from "../self-healing.js";
import { validateRepoContext } from "../branch-conflicts.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function createStore(
  tasks: Task[],
  settings?: Partial<Settings>,
): TaskStore & EventEmitter {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const emitter = new EventEmitter();
  const cfg: Settings = { globalPause: false, enginePaused: false } as Settings;
  Object.assign(cfg, settings ?? {});
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => cfg),
    listTasks: vi.fn(async (opts?: { column?: Task["column"]; includeArchived?: boolean; slim?: boolean; startupMemo?: boolean }) => {
      const all = [...map.values()];
      if (opts?.column) return all.filter((t) => t.column === opts.column);
      return all;
    }),
    getTask: vi.fn(async (id: string) => map.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const task = map.get(id)!;
      map.set(id, { ...task, ...patch } as Task);
      return map.get(id);
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const task = map.get(id)!;
      const from = task.column;
      const next = { ...task, column, worktree: undefined } as Task;
      map.set(id, next);
      emitter.emit("task:moved", { task: next, from, to: column, source: "engine" });
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

/**
 * Set up execSync to respond to git commands from reclaimStaleActiveBranches.
 * Returns a function to customize per-branch behavior.
 */
function setupExecSyncForBranches(branches: { name: string; tipSha: string; uniqueCount: number }[]) {
  execSyncMock.mockImplementation((cmd: string) => {
    if (cmd.includes("git branch --list")) {
      return branches.map((b) => `  ${b.name}`).join("\n") + "\n";
    }
    for (const b of branches) {
      if (cmd.includes(`git rev-parse --verify`) && cmd.includes(b.name)) {
        return b.tipSha + "\n";
      }
      if (cmd.includes(`git rev-list --count`) && cmd.includes(b.name)) {
        return String(b.uniqueCount) + "\n";
      }
      if (cmd.includes(`git log --format=%s`) && cmd.includes(b.name)) {
        return "";
      }
    }
    return "";
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("FN-190 worktree lifecycle fixes", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockImplementation((p: string) =>
      typeof p === "string" && p === "/repo",
    );
    execMock.mockImplementation((_cmd: string, _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      cb(null, "", "");
    });
    execSyncMock.mockReturnValue("");
    isUsableMock.mockResolvedValue(true);
    isAncestorMock.mockResolvedValue(false);
    activeSessionMock.isPathActive.mockReturnValue(false);
  });

  // ────────────────────────────────────────────────────────────────────
  // AC1: Active-task phantom state reconciliation
  // ────────────────────────────────────────────────────────────────────
  describe("AC1: reconcileActiveTaskPhantomState", () => {
    it("requeues in-progress task with missing worktree to todo", async () => {
      const task = makeTask("FN-100", {
        column: "in-progress",
        worktree: "/repo/.worktrees/phantom-wt",
        branch: "fusion/fn-100",
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      // Worktree directory does NOT exist
      existsSyncMock.mockImplementation((p: string) => p === "/repo");

      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-100",
        expect.objectContaining({
          worktree: null,
          branch: null,
          baseCommitSha: null,
        }),
      );
      expect(store.moveTask).toHaveBeenCalledWith(
        "FN-100",
        "todo",
        expect.objectContaining({
          moveSource: "engine",
          preserveProgress: true,
          preserveResumeState: true,
        }),
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-100",
        expect.stringContaining("phantom-active-task-requeue"),
      );
    });

    it("requeues in-progress task with unusable worktree to todo", async () => {
      const task = makeTask("FN-101", {
        column: "in-progress",
        worktree: "/repo/.worktrees/unusable-wt",
        branch: "fusion/fn-101",
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      // Directory exists but is unusable
      existsSyncMock.mockImplementation((p: string) =>
        p === "/repo" || p === "/repo/.worktrees/unusable-wt",
      );
      isUsableMock.mockResolvedValue(false);

      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(1);
      expect(store.moveTask).toHaveBeenCalledWith(
        "FN-101",
        "todo",
        expect.anything(),
      );
    });

    it("skips task with usable worktree", async () => {
      const task = makeTask("FN-102", {
        column: "in-progress",
        worktree: "/repo/.worktrees/ok-wt",
        branch: "fusion/fn-102",
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      existsSyncMock.mockImplementation((p: string) =>
        p === "/repo" || p === "/repo/.worktrees/ok-wt",
      );
      isUsableMock.mockResolvedValue(true);

      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(0);
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("skips task with active worktree session", async () => {
      const task = makeTask("FN-103", {
        column: "in-progress",
        worktree: "/repo/.worktrees/active-wt",
        branch: "fusion/fn-103",
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      activeSessionMock.isPathActive.mockReturnValue(true);

      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(0);
    });

    it("skips paused tasks", async () => {
      const task = makeTask("FN-104", {
        column: "in-progress",
        worktree: "/repo/.worktrees/paused-wt",
        userPaused: true,
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      existsSyncMock.mockImplementation((p: string) => p === "/repo");

      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(0);
    });

    it("skips task with recently started execution (grace period)", async () => {
      const task = makeTask("FN-105", {
        column: "in-progress",
        worktree: "/repo/.worktrees/recent-wt",
        executionStartedAt: new Date().toISOString(),
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      existsSyncMock.mockImplementation(() => false);

      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(0);
    });

    it("skips task checked out by an agent", async () => {
      const task = makeTask("FN-106", {
        column: "in-progress",
        worktree: "/repo/.worktrees/checked-wt",
        checkedOutBy: "agent-123",
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      existsSyncMock.mockImplementation(() => false);

      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(0);
    });

    it("calls releaseExecutorWorktreeOwnership for reconciled task", async () => {
      const task = makeTask("FN-107", {
        column: "in-progress",
        worktree: "/repo/.worktrees/rel-wt",
      });
      store = createStore([task]);
      const releaseFn = vi.fn();
      manager = new SelfHealingManager(store, { rootDir: "/repo", releaseExecutorWorktreeOwnership: releaseFn });

      existsSyncMock.mockImplementation((p: string) => p === "/repo");

      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(1);
      expect(releaseFn).toHaveBeenCalledWith("FN-107");
    });

    it("skips task with active heartbeat run", async () => {
      const task = makeTask("FN-108", {
        column: "in-progress",
        worktree: "/repo/.worktrees/hb-wt",
      });
      store = createStore([task]);

      const agentStore = {
        listActiveHeartbeatRuns: vi.fn(async () => [
          { startedAt: new Date().toISOString(), contextSnapshot: { taskId: "FN-108" } },
        ]),
      };

      manager = new SelfHealingManager(store, { rootDir: "/repo", agentStore });
      existsSyncMock.mockImplementation(() => false);

      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(0);
    });

    it("returns 0 when globalPause is true", async () => {
      const task = makeTask("FN-109", {
        column: "in-progress",
        worktree: "/repo/.worktrees/gp-wt",
      });
      store = createStore([task], { globalPause: true });
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AC2: Zero-commit active branch protection
  // ────────────────────────────────────────────────────────────────────
  describe("AC2: zero-commit active branch protection", () => {
    it("allows deletion of zero-commit branch when task has no worktree", async () => {
      const task = makeTask("FN-200", {
        column: "in-progress",
        worktree: null,
        branch: "fusion/fn-200",
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      setupExecSyncForBranches([
        { name: "fusion/fn-200", tipSha: "abc123def4567890", uniqueCount: 0 },
      ]);
      existsSyncMock.mockImplementation((p: string) => p === "/repo");

      const count = await manager.reclaimStaleActiveBranches();
      expect(count).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-200",
        expect.objectContaining({ worktree: null, branch: null, baseCommitSha: null }),
      );
    });

    it("logs zero-commit-in-progress when in-progress task has unusable worktree but zero commits", async () => {
      const task = makeTask("FN-201", {
        column: "in-progress",
        worktree: "/repo/.worktrees/broken-wt",
        branch: "fusion/fn-201",
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      setupExecSyncForBranches([
        { name: "fusion/fn-201", tipSha: "abc123def4567890", uniqueCount: 0 },
      ]);

      vi.spyOn(manager as any, "findWorktreePathForBranch").mockResolvedValue(undefined);

      // Worktree dir exists but is unusable
      existsSyncMock.mockImplementation((p: string) =>
        p === "/repo" || p === "/repo/.worktrees/broken-wt",
      );
      isUsableMock.mockResolvedValue(false);

      const count = await manager.reclaimStaleActiveBranches();
      expect(count).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-201",
        expect.stringContaining("stale-active-branch-reclaim"),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AC3: Ghost-conflict prevention (tip-already-merged)
  // ────────────────────────────────────────────────────────────────────
  describe("AC3: ghost-conflict prevention", () => {
    it("treats tip-already-merged branch as stale merged (not blocking conflict)", async () => {
      const task = makeTask("FN-300", {
        column: "in-progress",
        worktree: null,
        branch: "fusion/fn-300",
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      setupExecSyncForBranches([
        { name: "fusion/fn-300", tipSha: "deadbeef12345678", uniqueCount: 0 },
      ]);
      // Tip IS an ancestor of main → already merged
      isAncestorMock.mockResolvedValue(true);
      vi.spyOn(manager as any, "findWorktreePathForBranch").mockResolvedValue(undefined);
      existsSyncMock.mockImplementation((p: string) => p === "/repo");

      const count = await manager.reclaimStaleActiveBranches();
      expect(count).toBe(1);
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-300",
        expect.stringContaining("stale-active-branch-tip-merged"),
      );
      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-300",
        expect.objectContaining({ worktree: null, branch: null, baseCommitSha: null }),
      );
    });

    it("does NOT treat tip-already-merged as ghost when branch has unique commits", async () => {
      const task = makeTask("FN-301", {
        column: "in-progress",
        worktree: null,
        branch: "fusion/fn-301",
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      setupExecSyncForBranches([
        { name: "fusion/fn-301", tipSha: "cafe1234567890ab", uniqueCount: 3 },
      ]);

      existsSyncMock.mockImplementation((p: string) => p === "/repo");

      const count = await manager.reclaimStaleActiveBranches();
      // Should not reclaim — the branch has real work
      expect(count).toBe(0);
      expect(store.logEntry).not.toHaveBeenCalledWith(
        "FN-301",
        expect.stringContaining("stale-active-branch-tip-merged"),
      );
    });

    it("removes worktree for tip-already-merged branch when present", async () => {
      const task = makeTask("FN-302", {
        column: "in-progress",
        worktree: null,
        branch: "fusion/fn-302",
      });
      store = createStore([task]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      setupExecSyncForBranches([
        { name: "fusion/fn-302", tipSha: "feedface12345678", uniqueCount: 0 },
      ]);
      isAncestorMock.mockResolvedValue(true);
      vi.spyOn(manager as any, "findWorktreePathForBranch")
        .mockResolvedValue("/repo/.worktrees/ghost-wt");

      existsSyncMock.mockImplementation((p: string) =>
        p === "/repo" || p === "/repo/.worktrees/ghost-wt",
      );

      const count = await manager.reclaimStaleActiveBranches();
      expect(count).toBe(1);
      // Worktree should have been removed
      expect(removeWorktreeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: "/repo/.worktrees/ghost-wt",
        }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AC4: Completed-task stale blocker/lease reconciliation
  // ────────────────────────────────────────────────────────────────────
  describe("AC4: completed task stale blocker reconciliation", () => {
    it("calls leaseManager.reconcileLeaseRow for completed task", async () => {
      const doneTask = makeTask("FN-400", {
        column: "done",
        branch: "fusion/fn-400",
        worktree: null,
      });
      const dependent = makeTask("FN-401", {
        column: "todo",
        blockedBy: "FN-400",
      });
      store = createStore([doneTask, dependent]);

      const leaseManager = { reconcileLeaseRow: vi.fn(async () => true) };
      manager = new SelfHealingManager(store, {
        rootDir: "/repo",
        leaseManager: leaseManager as any,
      });

      existsSyncMock.mockImplementation(() => false);

      const result = await manager.reconcileCompletedTask("FN-400");
      expect(leaseManager.reconcileLeaseRow).toHaveBeenCalledWith("FN-400");
      expect(result.blockedByCleared).toBe(1);
    });

    it("continues if leaseManager.reconcileLeaseRow throws", async () => {
      const doneTask = makeTask("FN-410", {
        column: "done",
        branch: "fusion/fn-410",
        worktree: null,
      });
      const dependent = makeTask("FN-411", {
        column: "todo",
        blockedBy: "FN-410",
      });
      store = createStore([doneTask, dependent]);

      const leaseManager = { reconcileLeaseRow: vi.fn(async () => { throw new Error("lease error"); }) };
      manager = new SelfHealingManager(store, {
        rootDir: "/repo",
        leaseManager: leaseManager as any,
      });

      existsSyncMock.mockImplementation(() => false);

      const result = await manager.reconcileCompletedTask("FN-410");
      // Should still clear blockedBy even if lease reconciliation fails
      expect(result.blockedByCleared).toBe(1);
      expect(leaseManager.reconcileLeaseRow).toHaveBeenCalledWith("FN-410");
    });

    it("clears blockedBy on dependent when blocker is done", async () => {
      const doneTask = makeTask("FN-420", {
        column: "done",
        branch: "fusion/fn-420",
        worktree: null,
      });
      const dependent = makeTask("FN-421", {
        column: "todo",
        blockedBy: "FN-420",
        dependencies: ["FN-420"],
      });
      store = createStore([doneTask, dependent]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      existsSyncMock.mockImplementation(() => false);

      const result = await manager.reconcileCompletedTask("FN-420");
      expect(result.blockedByCleared).toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-421",
        expect.objectContaining({ blockedBy: null }),
      );
    });

    it("releases executor worktree ownership for completed task", async () => {
      const doneTask = makeTask("FN-430", {
        column: "done",
        branch: "fusion/fn-430",
        worktree: null,
      });
      store = createStore([doneTask]);

      const releaseFn = vi.fn();
      manager = new SelfHealingManager(store, {
        rootDir: "/repo",
        releaseExecutorWorktreeOwnership: releaseFn,
      });

      existsSyncMock.mockImplementation(() => false);

      await manager.reconcileCompletedTask("FN-430");
      expect(releaseFn).toHaveBeenCalledWith("FN-430");
    });

    it("does not call leaseManager when not provided", async () => {
      const doneTask = makeTask("FN-440", {
        column: "done",
        branch: "fusion/fn-440",
        worktree: null,
      });
      store = createStore([doneTask]);
      manager = new SelfHealingManager(store, { rootDir: "/repo" });

      existsSyncMock.mockImplementation(() => false);

      // Should not throw
      const result = await manager.reconcileCompletedTask("FN-440");
      expect(result).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AC5: Cross-repo safety guards
  // ────────────────────────────────────────────────────────────────────
  describe("AC5: cross-repo safety guards", () => {
    it("reconcileActiveTaskPhantomState returns 0 for invalid rootDir", async () => {
      store = createStore([]);
      manager = new SelfHealingManager(store, { rootDir: "" as any });
      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(0);
    });

    it("reconcileActiveTaskPhantomState warns and proceeds for non-existent rootDir", async () => {
      store = createStore([]);
      manager = new SelfHealingManager(store, { rootDir: "/nonexistent/path" });
      existsSyncMock.mockImplementation(() => false);
      const count = await manager.reconcileActiveTaskPhantomState();
      expect(count).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("rootDir does not exist"),
      );
    });

    it("reclaimStaleActiveBranches returns 0 for invalid rootDir", async () => {
      store = createStore([]);
      manager = new SelfHealingManager(store, { rootDir: null as any });
      const count = await manager.reclaimStaleActiveBranches();
      expect(count).toBe(0);
    });

    it("reconcileCompletedTask returns empty result for invalid rootDir", async () => {
      const doneTask = makeTask("FN-500", {
        column: "done",
        branch: "fusion/fn-500",
      });
      store = createStore([doneTask]);
      manager = new SelfHealingManager(store, { rootDir: "" as any });

      const result = await manager.reconcileCompletedTask("FN-500");
      expect(result).toEqual({
        blockedByCleared: 0,
        worktreeRemoved: false,
        branchRemoved: false,
      });
    });

    it("reclaimSelfOwnedBranchConflicts returns 0 for invalid rootDir", async () => {
      store = createStore([]);
      manager = new SelfHealingManager(store, { rootDir: undefined as any });

      const count = await manager.reclaimSelfOwnedBranchConflicts();
      expect(count).toBe(0);
    });

    it("validateRepoContext throws for null repoDir", () => {
      expect(() => validateRepoContext(null as any, "test")).toThrow(
        /\[test\] Invalid repo context/,
      );
    });

    it("validateRepoContext throws for non-existent directory", () => {
      existsSyncMock.mockReturnValue(false);
      expect(() => validateRepoContext("/nonexistent", "test")).toThrow(
        /\[test\] Repo directory does not exist/,
      );
    });

    it("validateRepoContext returns resolved path for valid directory", () => {
      existsSyncMock.mockReturnValue(true);
      const result = validateRepoContext("/repo", "test");
      expect(result).toBe("/repo");
    });
  });
});
