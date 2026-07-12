import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExecException } from "node:child_process";

// Route async `exec` (via promisify) through the `execSync` mock so existing
// test setups that configure `mockedExecSync.mockImplementation` keep working.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execSyncFn = vi.fn();
   
  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "function" ? {} : (opts ?? {});
    try {
      const out = execSyncFn(cmd, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err) {
      if (typeof callback === "function") {
        const error = err as ExecException & { stdout?: string; stderr?: string };
        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
      }
    }
  });

  const execFileFn: any = vi.fn((file: string, args: string[] | undefined, opts: any, cb: any) =>
    execFn([file, ...(Array.isArray(args) ? args : [])].join(" "), opts, cb),
  );

  execFn[promisify.custom] = (cmd: string, opts?: any) =>
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
  execFileFn[promisify.custom] = (file: string, args?: string[], opts?: any) =>
    execFn[promisify.custom]([file, ...(Array.isArray(args) ? args : [])].join(" "), opts);
  return { execSync: execSyncFn, exec: execFn, execFile: execFileFn };
});

vi.mock("../worktree-desktop-artifacts.js", () => ({
  removeDesktopBuildArtifacts: vi.fn().mockResolvedValue({ removed: [], skipped: [], failures: [] }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  lstatSync: vi.fn().mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false }),
  readdirSync: vi.fn().mockReturnValue([]),
  readFileSync: vi.fn().mockReturnValue(""),
  rmSync: vi.fn(),
}));

vi.mock("../worktree-prune.js", () => ({
  pruneWorktreeAdminEntries: vi.fn().mockResolvedValue(undefined),
}));

import * as desktopArtifacts from "../worktree-desktop-artifacts.js";
import * as worktreePrune from "../worktree-prune.js";
import {
  WorktreePool,
  detectGitRepository,
  getRegisteredWorktreeBranchMap,
  getRegisteredWorktreePaths,
  isGitRepository,
  scanIdleWorktrees,
  cleanupOrphanedWorktrees,
  reapOrphanWorktrees,
} from "../worktree-pool.js";
import { BranchConflictError } from "../branch-conflicts.js";
import * as branchConflictModule from "../branch-conflicts.js";
import { execSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Task, Column } from "@fusion/core";

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedLstatSync = vi.mocked(lstatSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedRmSync = vi.mocked(rmSync);
const mockedPruneWorktreeAdminEntries = vi.mocked(worktreePrune.pruneWorktreeAdminEntries);
const TEST_TASK_ID = "FN-test";

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("WorktreePool", () => {
  let pool: WorktreePool;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(desktopArtifacts.removeDesktopBuildArtifacts).mockResolvedValue({ removed: [], skipped: [], failures: [] });
    mockedExistsSync.mockReturnValue(true);
    pool = new WorktreePool();
  });

  describe("acquire", () => {
    it("returns null when pool is empty", () => {
      expect(pool.acquire(TEST_TASK_ID)).toBeNull();
    });

    it("returns a released path on acquire", () => {
      pool.release("/tmp/worktree-1");
      const result = pool.acquire(TEST_TASK_ID);
      expect(result).toBe("/tmp/worktree-1");
    });

    it("prunes entries where directory no longer exists on disk", () => {
      pool.release("/tmp/stale-worktree");
      pool.release("/tmp/good-worktree");
      // First path doesn't exist, second does
      mockedExistsSync.mockImplementation((p) => p === "/tmp/good-worktree");

      const result = pool.acquire(TEST_TASK_ID);
      expect(result).toBe("/tmp/good-worktree");
      expect(pool.size).toBe(0);
    });

    it("returns null when all entries are stale", () => {
      pool.release("/tmp/stale-1");
      pool.release("/tmp/stale-2");
      mockedExistsSync.mockReturnValue(false);

      expect(pool.acquire(TEST_TASK_ID)).toBeNull();
      expect(pool.size).toBe(0);
    });
  });

  describe("double-lease invariant", () => {
    it("skips rehydrate entries that are already leased", () => {
      const handler = vi.fn();
      pool.setInvariantViolationHandler(handler);
      pool.release("/tmp/wt-lease");
      expect(pool.acquire(TEST_TASK_ID)).toBe("/tmp/wt-lease");

      pool.rehydrate(["/tmp/wt-lease"]);

      expect(pool.size).toBe(0);
      expect(pool.getLeasedPaths().get("/tmp/wt-lease")).toBe(TEST_TASK_ID);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        path: "/tmp/wt-lease",
        existingHolder: TEST_TASK_ID,
        phase: "rehydrate",
      }));
    });
  });

  describe("release", () => {
    it("adds a path to the pool", () => {
      pool.release("/tmp/wt-1");
      expect(pool.size).toBe(1);
      expect(pool.has("/tmp/wt-1")).toBe(true);
    });

    it("does not duplicate on double release", () => {
      pool.release("/tmp/wt-1");
      pool.release("/tmp/wt-1");
      expect(pool.size).toBe(1);
    });
  });

  describe("size", () => {
    it("reflects correct count after operations", () => {
      expect(pool.size).toBe(0);
      pool.release("/tmp/a");
      pool.release("/tmp/b");
      expect(pool.size).toBe(2);
      pool.acquire(TEST_TASK_ID);
      expect(pool.size).toBe(1);
      pool.acquire(TEST_TASK_ID);
      expect(pool.size).toBe(0);
    });
  });

  describe("has", () => {
    it("returns false for unknown paths", () => {
      expect(pool.has("/tmp/unknown")).toBe(false);
    });

    it("returns true for released paths", () => {
      pool.release("/tmp/wt");
      expect(pool.has("/tmp/wt")).toBe(true);
    });

    it("returns false after path is acquired", () => {
      pool.release("/tmp/wt");
      pool.acquire(TEST_TASK_ID);
      expect(pool.has("/tmp/wt")).toBe(false);
    });
  });

  describe("drain", () => {
    it("empties the pool and returns all paths", () => {
      pool.release("/tmp/a");
      pool.release("/tmp/b");
      pool.release("/tmp/c");
      const paths = pool.drain();
      expect(paths).toHaveLength(3);
      expect(paths).toContain("/tmp/a");
      expect(paths).toContain("/tmp/b");
      expect(paths).toContain("/tmp/c");
      expect(pool.size).toBe(0);
    });

    it("returns empty array when pool is empty", () => {
      expect(pool.drain()).toEqual([]);
    });
  });

  describe("prepareForTask", () => {
    it("returns the original branch name on success", async () => {
      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042");
      expect(result).toMatchObject({ branch: "fusion/fn-042", reclaimed: false, worktreePath: "/tmp/wt" });
    });

    it("cleans dirty working tree before checkout", async () => {
      await pool.prepareForTask("/tmp/wt", "fusion/fn-042");

      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
      expect(calls).toContain("git checkout -- .");
      expect(calls).toContain("git clean -fd");
    });

    it("removes desktop artifacts after git clean and before detach checkout", async () => {
      await pool.prepareForTask("/tmp/wt", "fusion/fn-042");

      expect(desktopArtifacts.removeDesktopBuildArtifacts).toHaveBeenCalledWith("/tmp/wt", expect.anything());
      const cleanOrder = mockedExecSync.mock.calls.find((c) => c[0] === "git clean -fd");
      const detachOrder = mockedExecSync.mock.calls.find((c) => c[0] === "git checkout --detach main");
      expect(cleanOrder).toBeDefined();
      expect(detachOrder).toBeDefined();
      const cleanupOrder = vi.mocked(desktopArtifacts.removeDesktopBuildArtifacts).mock.invocationCallOrder[0];
      const cleanCallOrder = mockedExecSync.mock.invocationCallOrder[mockedExecSync.mock.calls.findIndex((c) => c[0] === "git clean -fd")];
      const detachCallOrder = mockedExecSync.mock.invocationCallOrder[mockedExecSync.mock.calls.findIndex((c) => c[0] === "git checkout --detach main")];
      expect(cleanCallOrder).toBeLessThan(cleanupOrder);
      expect(cleanupOrder).toBeLessThan(detachCallOrder);
    });

    it("creates branch from main with force-reset", async () => {
      await pool.prepareForTask("/tmp/wt", "fusion/fn-042");

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout --detach main",
        expect.objectContaining({}),
      );

      const checkoutCall = mockedExecSync.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("checkout -B"),
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![0]).toBe('git checkout -B "fusion/fn-042" main');
    });

    it("creates branch from custom startPoint when provided", async () => {
      await pool.prepareForTask("/tmp/wt", "fusion/fn-042", "fusion/fn-041");

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout --detach fusion/fn-041",
        expect.objectContaining({}),
      );

      const checkoutCall = mockedExecSync.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("checkout -B"),
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![0]).toBe('git checkout -B "fusion/fn-042" fusion/fn-041');
    });

    it("tolerates git checkout -- . failure (already clean)", async () => {
      mockedExecSync.mockImplementation((cmd: any) => {
        if (cmd === "git checkout -- .") throw new Error("nothing to checkout");
        return Buffer.from("");
      });

      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-001");
      expect(result).toMatchObject({ branch: "fusion/fn-001", reclaimed: false, worktreePath: "/tmp/wt" });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[worktree-pool] git checkout -- . failed (may be clean): nothing to checkout"),
      );

      // Should still run clean and branch creation
      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
      expect(calls).toContain("git clean -fd");
      expect(calls).toContain("git checkout --detach main");
      expect(calls).toContain('git checkout -B "fusion/fn-001" main');
    });

    it("logs checkout -- failure at debug level", async () => {
      mockedExecSync.mockImplementation((cmd: any) => {
        if (cmd === "git checkout -- .") {
          throw new Error("working tree already clean");
        }
        return Buffer.from("");
      });

      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042");

      expect(result).toMatchObject({ branch: "fusion/fn-042", reclaimed: false, worktreePath: "/tmp/wt" });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[worktree-pool] git checkout -- . failed (may be clean): working tree already clean"),
      );
    });

    it("returns reclaimed result when branch is already live elsewhere for the same task", async () => {
      mockedExistsSync.mockImplementation((p) => {
        if (p === "/other/wt") return true;
        return true;
      });

      mockedExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr === 'git checkout -B "fusion/fn-042" main') {
          const err: any = new Error("branch conflict");
          err.stderr = Buffer.from(
            "fatal: 'fusion/fn-042' is already used by worktree at '/other/wt'"
          );
          throw err;
        }
        if (cmdStr === "git worktree list --porcelain") {
          return Buffer.from([
            "worktree /other/wt",
            "HEAD 1111111",
            "branch refs/heads/fusion/fn-042",
            "",
          ].join("\n"));
        }
        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042^{commit}'")) {
          return Buffer.from("abc123def456\n");
        }
        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-042'")) {
          return Buffer.from("aaa111\tPreserve prior fix\n");
        }
        return Buffer.from("");
      });

      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
        kind: "reclaimable",
        livePath: "/other/wt",
        tipSha: "abc123def456",
        taskAttributedCommitCount: 1,
        strandedCommits: [{ sha: "aaa111", subject: "Preserve prior fix" }],
      });

      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042", "main", {
        repoDir: "/tmp/repo",
        requestingTaskId: "FN-042",
      });

      expect(result).toMatchObject({
        branch: "fusion/fn-042",
        worktreePath: "/other/wt",
        reclaimed: true,
        existingTipSha: "abc123def456",
        strandedCommitCount: 1,
      });
    });

    it("maps slugged fusion branches to canonical task IDs", async () => {
      mockedExistsSync.mockReturnValue(true);

      mockedExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr === 'git checkout -B "fusion/fn-5671-add-dropdown" main') {
          const err: any = new Error("branch conflict");
          err.stderr = Buffer.from("fatal: 'fusion/fn-5671-add-dropdown' is already used by worktree at '/other/wt'");
          throw err;
        }
        if (cmdStr === "git worktree list --porcelain") {
          return Buffer.from(["worktree /other/wt", "HEAD 1111111", "branch refs/heads/fusion/fn-5671-add-dropdown", ""].join("\n"));
        }
        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-5671-add-dropdown^{commit}'")) {
          return Buffer.from("abc123def456\n");
        }
        return Buffer.from("");
      });

      const inspectSpy = vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
        kind: "live-foreign",
        livePath: "/other/wt",
        error: new BranchConflictError({
          branchName: "fusion/fn-5671-add-dropdown",
          conflictingWorktreePath: "/other/wt",
          existingTipSha: "abc123def456",
          strandedCommits: [],
          startPoint: "main",
          recommendedAction: "Inspect/reclaim.",
        }),
      });

      await expect(pool.prepareForTask("/tmp/wt", "fusion/fn-5671-add-dropdown")).rejects.toBeInstanceOf(BranchConflictError);
      expect(inspectSpy).toHaveBeenCalledWith(expect.objectContaining({
        branchName: "fusion/fn-5671-add-dropdown",
        ownerTaskId: "FN-5671",
        requestingTaskId: "FN-5671",
      }));
    });

    it("throws BranchConflictError for cross-task live-foreign conflicts", async () => {
      mockedExistsSync.mockReturnValue(true);

      mockedExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr === 'git checkout -B "fusion/fn-042" main') {
          const err: any = new Error("branch conflict");
          err.stderr = Buffer.from("fatal: 'fusion/fn-042' is already used by worktree at '/other/wt'");
          throw err;
        }
        if (cmdStr === "git worktree list --porcelain") {
          return Buffer.from(["worktree /other/wt", "HEAD 1111111", "branch refs/heads/fusion/fn-042", ""].join("\n"));
        }
        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042^{commit}'")) {
          return Buffer.from("abc123def456\n");
        }
        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-042'")) {
          return Buffer.from("aaa111\tForeign fix\n");
        }
        if (cmdStr.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-042'")) {
          return Buffer.from("aaa111\tfeat(FN-999): foreign\x1fFusion-Task-Id: FN-999\n");
        }
        return Buffer.from("");
      });

      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
        kind: "live-foreign",
        livePath: "/other/wt",
        error: new BranchConflictError({
          branchName: "fusion/fn-042",
          conflictingWorktreePath: "/other/wt",
          existingTipSha: "abc123def456",
          strandedCommits: [{ sha: "aaa111", subject: "Foreign fix" }],
          startPoint: "main",
          recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
        }),
      });

      await expect(pool.prepareForTask("/tmp/wt", "fusion/fn-042", undefined, {
        repoDir: "/tmp/repo",
        requestingTaskId: "FN-042",
      })).rejects.toBeInstanceOf(BranchConflictError);

      const checkoutCalls = mockedExecSync.mock.calls
        .map((c) => c[0])
        .filter((c) => typeof c === "string" && c.includes("checkout -B"));
      expect(checkoutCalls).not.toContain('git checkout -B "fusion/fn-042-2" fusion/fn-042');
    });

    it("restores legacy suffixed branch behavior only when explicitly enabled", async () => {
      mockedExistsSync.mockReturnValue(true);

      mockedExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr === 'git checkout -B "fusion/fn-042" fusion/fn-041') {
          const err: any = new Error("branch conflict");
          err.stderr = Buffer.from("fatal: 'fusion/fn-042' is already used by worktree at '/other/wt'");
          throw err;
        }
        if (cmdStr === "git worktree list --porcelain") {
          return Buffer.from(["worktree /other/wt", "HEAD 1111111", "branch refs/heads/fusion/fn-042", ""].join("\n"));
        }
        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042^{commit}'")) return Buffer.from("abc123def456\n");
        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'fusion/fn-041..fusion/fn-042'")) return Buffer.from("aaa111\tPreserve prior fix\n");
        if (cmdStr.includes("git log --format=%H%x00%s%x00%b 'fusion/fn-041..fusion/fn-042'")) return Buffer.from("aaa111\u001ffeat(FN-999): foreign\u001fFusion-Task-Id: FN-999\n");
        return Buffer.from("");
      });

      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
        kind: "live-foreign",
        livePath: "/other/wt",
        error: new BranchConflictError({
          branchName: "fusion/fn-042",
          conflictingWorktreePath: "/other/wt",
          existingTipSha: "abc123def456",
          strandedCommits: [{ sha: "aaa111", subject: "Foreign fix" }],
          startPoint: "fusion/fn-041",
          recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
        }),
      });

      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042", "fusion/fn-041", { allowSiblingBranchRename: true, repoDir: "/tmp/repo" });
      expect(result.branch).toBe("fusion/fn-042-2");
    });

    it("increments suffix when lower suffixes are also in use in legacy rename mode", async () => {
      mockedExistsSync.mockReturnValue(true);

      mockedExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr.startsWith('git checkout -B "fusion/fn-042" ') || cmdStr.startsWith('git checkout -B "fusion/fn-042-2" ')) {
          const err: any = new Error("branch conflict");
          err.stderr = Buffer.from("fatal: 'x' is already used by worktree at '/other/wt'");
          throw err;
        }
        if (cmdStr === "git worktree list --porcelain") return Buffer.from(["worktree /other/wt", "HEAD 1111111", "branch refs/heads/fusion/fn-042", ""].join("\n"));
        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042^{commit}'")) return Buffer.from("abc123def456\n");
        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-042'")) return Buffer.from("aaa111\tPreserve prior fix\n");
        if (cmdStr.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-042'")) return Buffer.from("aaa111\u001ffeat(FN-999): foreign\u001fFusion-Task-Id: FN-999\n");
        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042-2^{commit}'")) return Buffer.from("bbb222ccc333\n");
        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-042-2'")) return Buffer.from("bbb222\tFirst sibling\n");
        return Buffer.from("");
      });

      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
        kind: "live-foreign",
        livePath: "/other/wt",
        error: new BranchConflictError({
          branchName: "fusion/fn-042",
          conflictingWorktreePath: "/other/wt",
          existingTipSha: "abc123def456",
          strandedCommits: [{ sha: "aaa111", subject: "Foreign fix" }],
          startPoint: "main",
          recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
        }),
      });

      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042", undefined, { allowSiblingBranchRename: true, repoDir: "/tmp/repo" });
      expect(result.branch).toBe("fusion/fn-042-3");
    });

    it("falls back to git worktree prune when conflicting worktree no longer exists on disk", async () => {
      mockedExistsSync.mockImplementation((p) => {
        // The conflicting worktree does NOT exist
        if (p === "/gone/wt") return false;
        return true;
      });

      let checkoutBCount = 0;
      mockedExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes("checkout -B")) {
          checkoutBCount++;
          if (checkoutBCount === 1) {
            const err: any = new Error("branch conflict");
            err.stderr = Buffer.from(
              "fatal: 'fusion/fn-042' is already used by worktree at '/gone/wt'"
            );
            throw err;
          }
          return Buffer.from("");
        }
        return Buffer.from("");
      });

      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042");
      expect(result.branch).toBe("fusion/fn-042");

      const cmds = mockedExecSync.mock.calls.map((c) => c[0]);
      expect(cmds).toContain("git worktree prune");
    });

    it("re-throws non-conflict errors from checkout -B unchanged", async () => {
      mockedExecSync.mockImplementation((cmd: any) => {
        if (String(cmd).includes("checkout -B")) {
          const err: any = new Error("some other git error");
          err.stderr = Buffer.from("fatal: some other git error");
          throw err;
        }
        return Buffer.from("");
      });

      await expect(pool.prepareForTask("/tmp/wt", "fusion/fn-042")).rejects.toThrow(
        "some other git error"
      );
    });

    it("throws when all suffixed names are exhausted in legacy rename mode", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes("checkout -B")) {
          const err: any = new Error("branch conflict");
          err.stderr = Buffer.from("fatal: 'x' is already used by worktree at '/other/wt'");
          throw err;
        }
        if (cmdStr === "git worktree list --porcelain") return Buffer.from(["worktree /other/wt", "HEAD 1111111", "branch refs/heads/fusion/fn-042", ""].join("\n"));
        if (cmdStr.includes("git rev-parse --verify 'fusion/fn-042^{commit}'")) return Buffer.from("abc123def456\n");
        if (cmdStr.includes("git log --reverse --format=%H%x09%s 'main..fusion/fn-042'")) return Buffer.from("aaa111\tPreserve prior fix\n");
        if (cmdStr.includes("git log --format=%H%x00%s%x00%b 'main..fusion/fn-042'")) return Buffer.from("aaa111\u001ffeat(FN-999): foreign\u001fFusion-Task-Id: FN-999\n");
        return Buffer.from("");
      });

      vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({
        kind: "live-foreign",
        livePath: "/other/wt",
        error: new BranchConflictError({
          branchName: "fusion/fn-042",
          conflictingWorktreePath: "/other/wt",
          existingTipSha: "abc123def456",
          strandedCommits: [{ sha: "aaa111", subject: "Foreign fix" }],
          startPoint: "main",
          recommendedAction: "Inspect/reclaim or discard the conflicting local branch/worktree with git tooling before retrying.",
        }),
      });

      await expect(pool.prepareForTask("/tmp/wt", "fusion/fn-042", undefined, { allowSiblingBranchRename: true, repoDir: "/tmp/repo" })).rejects.toThrow(/suffixes -2 through -6 are all in use/);
    });
  });

  describe("rehydrate", () => {
    it("loads paths into the idle set", () => {
      mockedExistsSync.mockReturnValue(true);
      pool.rehydrate(["/tmp/wt-1", "/tmp/wt-2", "/tmp/wt-3"]);
      expect(pool.size).toBe(3);
      expect(pool.has("/tmp/wt-1")).toBe(true);
      expect(pool.has("/tmp/wt-2")).toBe(true);
      expect(pool.has("/tmp/wt-3")).toBe(true);
    });

    it("skips paths that don't exist on disk", () => {
      mockedExistsSync.mockImplementation((p) => p === "/tmp/good-wt");
      pool.rehydrate(["/tmp/good-wt", "/tmp/gone-wt"]);
      expect(pool.size).toBe(1);
      expect(pool.has("/tmp/good-wt")).toBe(true);
      expect(pool.has("/tmp/gone-wt")).toBe(false);
    });

    it("handles empty array", () => {
      pool.rehydrate([]);
      expect(pool.size).toBe(0);
    });

    it("does not duplicate entries already in the pool", () => {
      mockedExistsSync.mockReturnValue(true);
      pool.release("/tmp/existing");
      pool.rehydrate(["/tmp/existing", "/tmp/new"]);
      expect(pool.size).toBe(2);
    });
  });
});

describe("detectGitRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies a POSIX git repository as repo", async () => {
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      expect(opts).toEqual(expect.objectContaining({ cwd: "/tmp/repo", timeout: 10_000 }));
      if (String(cmd) === "git rev-parse --git-dir") {
        return Buffer.from(".git\n");
      }
      return Buffer.from("");
    });

    await expect(detectGitRepository("/tmp/repo")).resolves.toEqual({ status: "repo" });
    await expect(isGitRepository("/tmp/repo")).resolves.toBe(true);
  });

  it("classifies a genuine non-git directory as not-repo", async () => {
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      if (String(cmd) === "git rev-parse --git-dir" && opts?.cwd === "/tmp/plain") {
        const error: any = new Error("fatal: not a git repository (or any of the parent directories): .git");
        error.stderr = Buffer.from("fatal: not a git repository (or any of the parent directories): .git");
        throw error;
      }
      return Buffer.from("");
    });

    await expect(detectGitRepository("/tmp/plain")).resolves.toEqual({
      status: "not-repo",
      stderr: "fatal: not a git repository (or any of the parent directories): .git",
    });
    await expect(isGitRepository("/tmp/plain")).resolves.toBe(false);
  });

  it("classifies dubious ownership on a Windows OneDrive Documents path as an error", async () => {
    const windowsPath = "C:/Users/drewd/Documents/1. App Development/1. Active/NextGenEHS";
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      if (String(cmd) === "git rev-parse --git-dir" && opts?.cwd === windowsPath) {
        const error: any = new Error(`fatal: detected dubious ownership in repository at '${windowsPath}'`);
        error.stderr = Buffer.from(`fatal: detected dubious ownership in repository at '${windowsPath}'`);
        throw error;
      }
      return Buffer.from("");
    });

    await expect(detectGitRepository(windowsPath)).resolves.toEqual({
      status: "error",
      reason: "dubious-ownership",
      stderr: `fatal: detected dubious ownership in repository at '${windowsPath}'`,
    });
    await expect(isGitRepository(windowsPath)).resolves.toBe(false);
  });

  it("classifies git missing from PATH as an error", async () => {
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      if (String(cmd) === "git rev-parse --git-dir" && opts?.cwd === "/tmp/repo") {
        const error: any = new Error("spawn git ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return Buffer.from("");
    });

    await expect(detectGitRepository("/tmp/repo")).resolves.toEqual({
      status: "error",
      reason: "git-missing",
      stderr: "spawn git ENOENT",
    });
    await expect(isGitRepository("/tmp/repo")).resolves.toBe(false);
  });

  it("classifies a timed-out git probe as an error", async () => {
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      if (String(cmd) === "git rev-parse --git-dir" && opts?.cwd === "/tmp/repo") {
        const error: any = new Error("Command failed: git rev-parse --git-dir");
        error.code = "ETIMEDOUT";
        error.killed = true;
        error.stderr = Buffer.from("Timed out: git rev-parse --git-dir");
        throw error;
      }
      return Buffer.from("");
    });

    await expect(detectGitRepository("/tmp/repo")).resolves.toEqual({
      status: "error",
      reason: "timeout",
      stderr: "Timed out: git rev-parse --git-dir",
    });
    await expect(isGitRepository("/tmp/repo")).resolves.toBe(false);
  });
});

describe("getRegisteredWorktreePaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs warning and returns empty set when git worktree list fails", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git worktree list --porcelain") {
        throw new Error("git unavailable");
      }
      return Buffer.from("");
    });

    const registered = await getRegisteredWorktreePaths("/root");

    expect(registered).toEqual(new Set());
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[worktree-pool] Failed to list registered worktrees: git unavailable"),
    );
  });
});

describe("getRegisteredWorktreeBranchMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a branch→worktree map from porcelain output", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git worktree list --porcelain") {
        return [
          "worktree /root",
          "HEAD abc",
          "branch refs/heads/main",
          "",
          "worktree /root/.worktrees/sleek-stone",
          "HEAD def",
          "branch refs/heads/fusion/fn-4913",
          "",
          "worktree /root/.worktrees/detached",
          "HEAD 123",
          "detached",
          "",
        ].join("\n") as any;
      }
      return Buffer.from("");
    });

    const map = await getRegisteredWorktreeBranchMap("/root");
    expect(map.get("main")).toBe("/root");
    expect(map.get("fusion/fn-4913")).toBe("/root/.worktrees/sleek-stone");
    expect(map.has("detached")).toBe(false);
  });
});

// ── Helper for mock store ─────────────────────────────────────────────

function makeTask(id: string, column: Column, worktree?: string): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    column,
    dependencies: [],
    worktree,
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createMockStore(tasks: Task[] = []) {
  return {
    listTasks: vi.fn().mockResolvedValue(tasks),
  } as any;
}

function makeDirEntry(name: string) {
  return { name, isDirectory: () => true } as any;
}

function mockRegisteredWorktrees(rootDir: string, names: string[]) {
  mockedExecSync.mockImplementation((cmd: any) => {
    if (String(cmd) === "git worktree list --porcelain") {
      return [
        `worktree ${rootDir}`,
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        ...names.flatMap((name) => [
          `worktree ${rootDir}/.worktrees/${name}`,
          "HEAD def456",
          `branch refs/heads/fusion/${name}`,
          "",
        ]),
      ].join("\n") as any;
    }
    return Buffer.from("");
  });
}

// ── scanIdleWorktrees tests ───────────────────────────────────────────

describe("scanIdleWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockRegisteredWorktrees("/root", []);
  });

  it("correctly identifies idle vs active worktrees", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("swift-falcon"),
      makeDirEntry("calm-river"),
      makeDirEntry("bold-eagle"),
    ] as any);
    mockRegisteredWorktrees("/root", ["swift-falcon", "calm-river", "bold-eagle"]);

    const store = createMockStore([
      makeTask("FN-001", "in-progress", "/root/.worktrees/swift-falcon"),
      makeTask("FN-002", "done", "/root/.worktrees/calm-river"),
    ]);

    const idle = await scanIdleWorktrees("/root", store);

    expect(store.listTasks).toHaveBeenCalledWith({ slim: true, includeArchived: false, startupMemo: true });
    expect(idle).toContain("/root/.worktrees/calm-river");
    expect(idle).toContain("/root/.worktrees/bold-eagle");
    expect(idle).not.toContain("/root/.worktrees/swift-falcon");
  });

  it("handles empty .worktrees/ directory", async () => {
    mockedReaddirSync.mockReturnValue([] as any);
    const store = createMockStore([]);

    const idle = await scanIdleWorktrees("/root", store);
    expect(idle).toEqual([]);
  });

  it("handles missing .worktrees/ directory", async () => {
    mockedExistsSync.mockReturnValue(false);
    const store = createMockStore([]);

    const idle = await scanIdleWorktrees("/root", store);
    expect(idle).toEqual([]);
  });

  it("treats in-review tasks as active (worktree preserved)", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("review-wt"),
    ] as any);
    mockRegisteredWorktrees("/root", ["review-wt"]);

    const store = createMockStore([
      makeTask("FN-010", "in-review", "/root/.worktrees/review-wt"),
    ]);

    const idle = await scanIdleWorktrees("/root", store);
    expect(idle).not.toContain("/root/.worktrees/review-wt");
  });

  it("returns all worktrees when no tasks exist", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("wt-1"),
      makeDirEntry("wt-2"),
    ] as any);
    mockRegisteredWorktrees("/root", ["wt-1", "wt-2"]);

    const store = createMockStore([]);

    const idle = await scanIdleWorktrees("/root", store);
    expect(idle).toHaveLength(2);
    expect(idle).toContain("/root/.worktrees/wt-1");
    expect(idle).toContain("/root/.worktrees/wt-2");
  });

  it("returns empty array when readdirSync throws", async () => {
    mockedReaddirSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });
    const store = createMockStore([]);

    const idle = await scanIdleWorktrees("/root", store);
    expect(idle).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[worktree-pool] Failed to read .worktrees/ directory: Permission denied"),
    );
  });

  it("excludes the .ai-merge container even when git lists clean-room children", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry(".ai-merge"),
      makeDirEntry("registered-wt"),
    ] as any);
    mockRegisteredWorktrees("/root", [".ai-merge/fusion-ai-merge-fn-1-active", "registered-wt"]);

    const store = createMockStore([]);

    const idle = await scanIdleWorktrees("/root", store);
    expect(idle).toEqual(["/root/.worktrees/registered-wt"]);
    expect(idle).not.toContain("/root/.worktrees/.ai-merge");
  });

  it("does not return unregistered directories for pool rehydration", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("registered-wt"),
      makeDirEntry("broken-wt"),
    ] as any);
    mockRegisteredWorktrees("/root", ["registered-wt"]);

    const store = createMockStore([
      makeTask("FN-001", "in-progress", "/root/.worktrees/broken-wt"),
    ]);

    const idle = await scanIdleWorktrees("/root", store);
    expect(idle).toEqual(["/root/.worktrees/registered-wt"]);
  });
});

// ── cleanupOrphanedWorktrees tests ────────────────────────────────────

describe("cleanupOrphanedWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockRegisteredWorktrees("/root", []);
    mockedPruneWorktreeAdminEntries.mockResolvedValue(undefined);
  });

  it("removes worktrees not assigned to any active task", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("orphan-1"),
      makeDirEntry("orphan-2"),
    ] as any);
    mockRegisteredWorktrees("/root", ["orphan-1", "orphan-2"]);

    const store = createMockStore([]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    expect(cleaned).toBe(2);
    const removeCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
    );
    expect(removeCalls).toHaveLength(2);
    expect(removeCalls[0][0]).toContain("/root/.worktrees/orphan-1");
    expect(removeCalls[1][0]).toContain("/root/.worktrees/orphan-2");
  });

  it("preserves worktrees assigned to in-progress/in-review tasks", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("active-wt"),
      makeDirEntry("orphan-wt"),
    ] as any);
    mockRegisteredWorktrees("/root", ["active-wt", "orphan-wt"]);

    const store = createMockStore([
      makeTask("FN-001", "in-progress", "/root/.worktrees/active-wt"),
    ]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    expect(cleaned).toBe(1);
    const removeCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0][0]).toContain("orphan-wt");
    expect(removeCalls[0][0]).not.toContain("active-wt");
  });


  it("handles git worktree remove failures gracefully (non-fatal)", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("fail-wt"),
      makeDirEntry("ok-wt"),
    ] as any);

    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git worktree list --porcelain") {
        return [
          "worktree /root",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          "worktree /root/.worktrees/fail-wt",
          "HEAD def456",
          "branch refs/heads/fusion/fail-wt",
          "",
          "worktree /root/.worktrees/ok-wt",
          "HEAD def456",
          "branch refs/heads/fusion/ok-wt",
          "",
        ].join("\n") as any;
      }
      if (typeof cmd === "string" && cmd.includes("fail-wt")) {
        throw new Error("worktree locked");
      }
      return Buffer.from("");
    });

    const store = createMockStore([]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    // Only 1 cleaned (the other failed), but no throw
    expect(cleaned).toBe(1);
  });

  it("no-ops when .worktrees/ doesn't exist", async () => {
    mockedExistsSync.mockReturnValue(false);
    const store = createMockStore([]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);
    expect(cleaned).toBe(0);
    const removeCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
    );
    expect(removeCalls).toHaveLength(0);
  });

  it("logs warning when readdirSync fails for cleanup scan", async () => {
    let readdirCalls = 0;
    mockedReaddirSync.mockImplementation(() => {
      readdirCalls += 1;
      if (readdirCalls === 1) {
        return [] as any;
      }
      throw new Error("cleanup permission denied");
    });

    const store = createMockStore([]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    expect(cleaned).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[worktree-pool] Failed to read .worktrees/ directory for cleanup: cleanup permission denied"),
    );
  });

  it("returns 0 when all worktrees are assigned to active tasks", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("active-1"),
      makeDirEntry("active-2"),
    ] as any);
    mockRegisteredWorktrees("/root", ["active-1", "active-2"]);

    const store = createMockStore([
      makeTask("FN-001", "in-progress", "/root/.worktrees/active-1"),
      makeTask("FN-002", "in-review", "/root/.worktrees/active-2"),
    ]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);
    expect(cleaned).toBe(0);
    const removeCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
    );
    expect(removeCalls).toHaveLength(0);
  });

  it("excludes the .ai-merge container while still removing genuine unregistered orphans", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry(".ai-merge"),
      makeDirEntry("broken-wt"),
    ] as any);
    mockRegisteredWorktrees("/root", []);

    const store = createMockStore([]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    expect(cleaned).toBe(1);
    expect(mockedRmSync).toHaveBeenCalledWith("/root/.worktrees/broken-wt", {
      recursive: true,
      force: true,
    });
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/.ai-merge", expect.anything());
  });

  it("removes unregistered directories even when stale active task metadata references them", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("broken-wt"),
    ] as any);
    mockRegisteredWorktrees("/root", []);

    const store = createMockStore([
      makeTask("FN-001", "in-progress", "/root/.worktrees/broken-wt"),
    ]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    expect(cleaned).toBe(1);
    expect(mockedRmSync).toHaveBeenCalledWith("/root/.worktrees/broken-wt", {
      recursive: true,
      force: true,
    });
    expect(mockedPruneWorktreeAdminEntries).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "pool-cleanup-orphan", target: "/root/.worktrees/broken-wt" }),
    );
  });
});

describe("reapOrphanWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegisteredWorktrees("/root", []);
    mockedExistsSync.mockImplementation((path) => String(path) === "/root/.worktrees");
    mockedLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false } as any);
  });

  it("excludes the .ai-merge container while removing half-initialized task worktrees", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry(".ai-merge"),
      makeDirEntry("half-built"),
    ] as any);

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(1);
    expect(mockedRmSync).toHaveBeenCalledWith("/root/.worktrees/half-built", { recursive: true, force: true });
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/.ai-merge", expect.anything());
  });

  // FN-6782 follow-up: a directory whose `.git` points to a missing admin entry is leak
  // residue (invisible to `git worktree list`/`prune`), not "partially registered". It
  // must be reaped — otherwise it collides with freshly generated worktree names and
  // breaks `execute`. Previously the reaper skipped on mere `.git` presence.
  it("reaps a dir with a dangling .git pointer (admin gitdir missing)", async () => {
    mockedReaddirSync.mockReturnValue([makeDirEntry("leaked-wt")] as any);
    // `.git` is a link FILE (not a dir); the worktree dir itself is a dir.
    mockedLstatSync.mockImplementation((p: any) =>
      (String(p).endsWith("/.git")
        ? { isDirectory: () => false, isSymbolicLink: () => false }
        : { isDirectory: () => true, isSymbolicLink: () => false }) as any,
    );
    mockedReadFileSync.mockReturnValue("gitdir: /root/.git/worktrees/leaked-wt\n" as any);
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      // .worktrees root exists; the .git link file exists; the gitdir target does NOT.
      return s === "/root/.worktrees" || s === "/root/.worktrees/leaked-wt/.git";
    });

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(1);
    expect(mockedRmSync).toHaveBeenCalledWith("/root/.worktrees/leaked-wt", { recursive: true, force: true });
  });

  it("skips a dir with a valid .git pointer (admin gitdir exists)", async () => {
    mockedReaddirSync.mockReturnValue([makeDirEntry("live-wt")] as any);
    mockedLstatSync.mockImplementation((p: any) =>
      (String(p).endsWith("/.git")
        ? { isDirectory: () => false, isSymbolicLink: () => false }
        : { isDirectory: () => true, isSymbolicLink: () => false }) as any,
    );
    mockedReadFileSync.mockReturnValue("gitdir: /root/.git/worktrees/live-wt\n" as any);
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      // The gitdir target exists too → treat as (maybe) registered, leave it alone.
      return s === "/root/.worktrees" || s === "/root/.worktrees/live-wt/.git" || s === "/root/.git/worktrees/live-wt";
    });

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/live-wt", expect.anything());
  });

  it("does NOT reap a dir whose .git is unparseable (conservative — only confirmed-dangling pointers)", async () => {
    // A transient read error or a garbage .git (no `gitdir:` line) must not be treated as
    // dangling — reaping on uncertainty could delete a genuinely-live worktree.
    mockedReaddirSync.mockReturnValue([makeDirEntry("maybe-wt")] as any);
    mockedLstatSync.mockImplementation((p: any) =>
      (String(p).endsWith("/.git")
        ? { isDirectory: () => false, isSymbolicLink: () => false }
        : { isDirectory: () => true, isSymbolicLink: () => false }) as any,
    );
    mockedReadFileSync.mockReturnValue("not a gitdir pointer at all\n" as any);
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s === "/root/.worktrees" || s === "/root/.worktrees/maybe-wt/.git";
    });

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/maybe-wt", expect.anything());
  });
});

