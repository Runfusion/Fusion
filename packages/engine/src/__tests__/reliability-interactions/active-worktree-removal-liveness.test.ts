/**
 * FN-4811 reliability backstop: `cleanupConflictingWorktree` and `handleBranchConflict`
 * must refuse to force-remove a worktree that is currently bound to an active executor
 * session (in-memory map or DB-level in-progress task). Without this guard, FN-4546
 * stale-active-branch reclaim, branch-conflict recovery, or startup cleanup paths can
 * yank the filesystem out from under a live agent — producing the FN-4781/FN-4804
 * cascade: "assigned worktree path disappeared mid-task", two parallel runs alive
 * simultaneously, and cross-task contamination.
 *
 * The canonical guards live in `executor.ts`:
 *   - `findActiveWorktreeOwner(path, requestingTaskId)`
 *   - liveness short-circuit at top of `cleanupConflictingWorktree`
 *   - liveness short-circuit at top of `handleBranchConflict`
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { BranchConflictError } from "../../execution/branch-conflicts.js";
import * as branchConflictModule from "../../execution/branch-conflicts.js";
import { createMockStore, mockedExec, mockedExistsSync, resetExecutorMocks } from "../executor-test-helpers.js";

const ACTIVE_PATH = "/tmp/test/.worktrees/lemon-reef";
const STALE_PATH = "/tmp/test/.worktrees/azure-peach";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4811",
    title: "Test",
    description: "Test task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

function makeConflict(path: string): BranchConflictError {
  return new BranchConflictError({
    branchName: "fusion/fn-9999",
    conflictingWorktreePath: path,
    existingTipSha: "abc123def456",
    strandedCommits: [],
    startPoint: "HEAD",
    recommendedAction: "test",
  });
}

describe("FN-4811: active worktree removal liveness gate", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  describe("findActiveWorktreeOwner", () => {
    it("returns the owner taskId when activeWorktrees has another task using the path", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      (executor as any).addActiveWorktree("FN-OTHER", ACTIVE_PATH);

      const owner = await (executor as any).findActiveWorktreeOwner(ACTIVE_PATH, "FN-4811");
      expect(owner).toBe("FN-OTHER");
    });

    it("returns null when activeWorktrees only has the requesting task at the path", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      (executor as any).addActiveWorktree("FN-4811", ACTIVE_PATH);
      store.listTasks.mockResolvedValue([]);

      const owner = await (executor as any).findActiveWorktreeOwner(ACTIVE_PATH, "FN-4811");
      expect(owner).toBeNull();
    });

    it("returns owner from DB when a non-done, non-paused, in-progress task uses the path", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      store.listTasks.mockResolvedValue([
        { id: "FN-OWNER", worktree: ACTIVE_PATH, column: "in-progress", paused: false },
      ]);

      const owner = await (executor as any).findActiveWorktreeOwner(ACTIVE_PATH, "FN-4811");
      expect(owner).toBe("FN-OWNER");
    });

    it("ignores paused in-progress tasks (engine has released the session)", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      store.listTasks.mockResolvedValue([
        { id: "FN-PAUSED", worktree: ACTIVE_PATH, column: "in-progress", paused: true },
      ]);

      const owner = await (executor as any).findActiveWorktreeOwner(ACTIVE_PATH, "FN-4811");
      expect(owner).toBeNull();
    });

    it("ignores done/in-review/todo tasks (no live session)", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      store.listTasks.mockResolvedValue([
        { id: "FN-DONE", worktree: ACTIVE_PATH, column: "done", paused: false },
        { id: "FN-REVIEW", worktree: ACTIVE_PATH, column: "in-review", paused: false },
        { id: "FN-TODO", worktree: ACTIVE_PATH, column: "todo", paused: false },
      ]);

      const owner = await (executor as any).findActiveWorktreeOwner(ACTIVE_PATH, "FN-4811");
      expect(owner).toBeNull();
    });

    it("excludes the requesting task from DB liveness check", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      store.listTasks.mockResolvedValue([
        { id: "FN-4811", worktree: ACTIVE_PATH, column: "in-progress", paused: false },
      ]);

      const owner = await (executor as any).findActiveWorktreeOwner(ACTIVE_PATH, "FN-4811");
      expect(owner).toBeNull();
    });
  });

  describe("cleanupConflictingWorktree liveness gate", () => {
    it("refuses removal when worktree is in activeWorktrees for another task", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      (executor as any).addActiveWorktree("FN-OTHER", ACTIVE_PATH);
      store.listTasks.mockResolvedValue([]);

      const result = await (executor as any).cleanupConflictingWorktree(
        ACTIVE_PATH,
        "fusion/fn-9999",
        "FN-4811",
      );

      expect(result).toBe(false);
      // No removal-success log should be emitted.
      const logCalls = store.logEntry.mock.calls.map((c: any[]) => String(c[1] ?? ""));
      expect(logCalls.some((m: string) => m === "Removed conflicting worktree")).toBe(false);
      expect(logCalls.some((m: string) => m.includes("Refused to remove conflicting worktree"))).toBe(true);
    });

    it("refuses removal when DB shows a live in-progress task using the worktree", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      store.listTasks.mockResolvedValue([
        { id: "FN-LIVE", worktree: ACTIVE_PATH, column: "in-progress", paused: false },
      ]);

      const result = await (executor as any).cleanupConflictingWorktree(
        ACTIVE_PATH,
        "fusion/fn-9999",
        "FN-4811",
      );

      expect(result).toBe(false);
      const logCalls = store.logEntry.mock.calls.map((c: any[]) => String(c[1] ?? ""));
      expect(logCalls.some((m: string) => m === "Removed conflicting worktree")).toBe(false);
    });

    it("proceeds with removal when no active owner is found (preserves existing behavior)", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      store.listTasks.mockResolvedValue([
        { id: "FN-DONE", worktree: STALE_PATH, column: "done", paused: false },
      ]);
      // existsSync defaults to true in helpers; this exercises the standard remove path.
      mockedExistsSync.mockImplementation((p: Parameters<typeof mockedExistsSync>[0]) => p === STALE_PATH);

      const result = await (executor as any).cleanupConflictingWorktree(
        STALE_PATH,
        "fusion/fn-9999",
        "FN-4811",
      );

      const logCalls = store.logEntry.mock.calls.map((c: any[]) => String(c[1] ?? ""));
      expect(logCalls.some((m: string) => m.includes("Refused to remove conflicting worktree"))).toBe(false);
      void result;
    });

    it("FN-4811 follow-up (FN-4813): recovers from 'validation failed, cannot remove working tree'", async () => {
      // Regression: a stale worktree admin entry (or missing on-disk directory) causes
      // `git worktree remove --force` to fail with 'validation failed, cannot remove
      // working tree'. The cleanup must catch that specific error, prune the stale admin
      // entry, best-effort delete the branch, and return success so the caller can proceed
      // with worktree creation.
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      store.listTasks.mockResolvedValue([]);

      const execCalls: string[] = [];
      mockedExec.mockImplementation(((cmd: string, _opts: unknown, cb?: (...args: unknown[]) => void) => {
        execCalls.push(cmd);
        if (cmd.includes("git worktree remove")) {
          const err: any = new Error(
            `Command failed: ${cmd}\nfatal: validation failed, cannot remove working tree:`,
          );
          err.stderr = "fatal: validation failed, cannot remove working tree:";
          cb?.(err, "", err.stderr);
          return { kill: () => undefined } as any;
        }
        cb?.(null, "", "");
        return { kill: () => undefined } as any;
      }) as any);

      const result = await (executor as any).cleanupConflictingWorktree(
        STALE_PATH,
        "fusion/fn-9999",
        "FN-4811",
      );

      expect(result).toBe(true);
      // Must have run prune after the validation-failed catch.
      expect(execCalls.some((c) => c.includes("git worktree prune"))).toBe(true);
      // Must have attempted branch -D as part of the recovery.
      expect(execCalls.some((c) => c.includes('git branch -D "fusion/fn-9999"'))).toBe(true);
      // Must have logged the stale-path cleanup outcome — NOT the generic failure log.
      const logCalls = store.logEntry.mock.calls.map((c: any[]) => String(c[1] ?? ""));
      expect(logCalls.some((m: string) => m.includes("Cleaned up stale conflicting worktree"))).toBe(true);
      expect(logCalls.some((m: string) => m === "Failed to clean up conflicting worktree")).toBe(false);
    });
  });

  describe("handleBranchConflict liveness gate", () => {
    it("returns 'sticky' without invoking inspection when conflict path is actively owned", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      (executor as any).addActiveWorktree("FN-OWNER", ACTIVE_PATH);
      store.listTasks.mockResolvedValue([]);

      const inspectSpy = vi.spyOn(branchConflictModule, "inspectBranchConflict");
      const cleanupSpy = vi.spyOn(executor as any, "cleanupConflictingWorktree");

      const result = await (executor as any).handleBranchConflict(
        makeTask(),
        makeConflict(ACTIVE_PATH),
      );

      expect(result).toBe("sticky");
      // Critical: inspection must NOT run, because some inspection branches force-remove.
      expect(inspectSpy).not.toHaveBeenCalled();
      // And cleanup must NOT be invoked.
      expect(cleanupSpy).not.toHaveBeenCalled();
      // The refusal must be logged for observability.
      const logCalls = store.logEntry.mock.calls.map((c: any[]) => String(c[1] ?? ""));
      expect(logCalls.some((m: string) => m.includes("FN-4811") && m.includes("deferred"))).toBe(true);
    });

    it("proceeds with inspection when conflict path has no active owner", async () => {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test");
      store.listTasks.mockResolvedValue([]);

      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({
        kind: "stale-resolved",
      } as any);

      const result = await (executor as any).handleBranchConflict(
        makeTask(),
        makeConflict(STALE_PATH),
      );

      // stale-resolved path returns "retry" and clears worktree/branch.
      expect(result).toBe("retry");
    });
  });
});
