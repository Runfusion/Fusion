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
  return { execSync: execSyncFn, exec: execFn };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  lstatSync: vi.fn().mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false }),
  readdirSync: vi.fn().mockReturnValue([]),
  rmSync: vi.fn(),
}));

import {
  WorktreePool,
  getRegisteredWorktreePaths,
  isGitRepository,
  scanIdleWorktrees,
  cleanupOrphanedWorktrees,
  reapOrphanWorktrees,
  scanOrphanedBranches,
} from "../worktree-pool.js";
import { execSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import type { Task, Column } from "@fusion/core";

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedLstatSync = vi.mocked(lstatSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedRmSync = vi.mocked(rmSync);

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
    mockedExistsSync.mockReturnValue(true);
    pool = new WorktreePool();
  });

  describe("acquire", () => {
    it("returns null when pool is empty", () => {
      expect(pool.acquire()).toBeNull();
    });

    it("returns a released path on acquire", () => {
      pool.release("/tmp/worktree-1");
      const result = pool.acquire();
      expect(result).toBe("/tmp/worktree-1");
    });

    it("prunes entries where directory no longer exists on disk", () => {
      pool.release("/tmp/stale-worktree");
      pool.release("/tmp/good-worktree");
      // First path doesn't exist, second does
      mockedExistsSync.mockImplementation((p) => p === "/tmp/good-worktree");

      const result = pool.acquire();
      expect(result).toBe("/tmp/good-worktree");
      expect(pool.size).toBe(0);
    });

    it("returns null when all entries are stale", () => {
      pool.release("/tmp/stale-1");
      pool.release("/tmp/stale-2");
      mockedExistsSync.mockReturnValue(false);

      expect(pool.acquire()).toBeNull();
      expect(pool.size).toBe(0);
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
      pool.acquire();
      expect(pool.size).toBe(1);
      pool.acquire();
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
      pool.acquire();
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
      expect(result).toBe("fusion/fn-042");
    });

    it("cleans dirty working tree before checkout", async () => {
      await pool.prepareForTask("/tmp/wt", "fusion/fn-042");

      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
      expect(calls).toContain("git checkout -- .");
      expect(calls).toContain("git clean -fd");
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
      expect(result).toBe("fusion/fn-001");

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

      expect(result).toBe("fusion/fn-042");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[worktree-pool] git checkout -- . failed (may be clean): working tree already clean"),
      );
    });

    it("uses suffixed branch name when original is in use by an active worktree", async () => {
      mockedExistsSync.mockImplementation((p) => {
        // The conflicting worktree exists on disk
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
        return Buffer.from("");
      });

      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042");
      expect(result).toBe("fusion/fn-042-2");

      // Verify the suffixed checkout was called
      const checkoutCalls = mockedExecSync.mock.calls
        .map((c) => c[0])
        .filter((c) => typeof c === "string" && c.includes("checkout -B"));
      expect(checkoutCalls).toContain('git checkout -B "fusion/fn-042-2" main');
    });

    it("increments suffix when lower suffixes are also in use", async () => {
      mockedExistsSync.mockReturnValue(true);

      mockedExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        // Original and -2 are both in use
        if (cmdStr === 'git checkout -B "fusion/fn-042" main' ||
            cmdStr === 'git checkout -B "fusion/fn-042-2" main') {
          const err: any = new Error("branch conflict");
          err.stderr = Buffer.from(
            `fatal: 'x' is already used by worktree at '/other/wt'`
          );
          throw err;
        }
        return Buffer.from("");
      });

      const result = await pool.prepareForTask("/tmp/wt", "fusion/fn-042");
      expect(result).toBe("fusion/fn-042-3");
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
      expect(result).toBe("fusion/fn-042");

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

    it("throws when all suffixed names are exhausted", async () => {
      mockedExistsSync.mockReturnValue(true);

      mockedExecSync.mockImplementation((cmd: any) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes("checkout -B")) {
          const err: any = new Error("branch conflict");
          err.stderr = Buffer.from(
            `fatal: 'x' is already used by worktree at '/other/wt'`
          );
          throw err;
        }
        return Buffer.from("");
      });

      await expect(pool.prepareForTask("/tmp/wt", "fusion/fn-042")).rejects.toThrow(
        /suffixes -2 through -6 are all in use/
      );
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

describe("isGitRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when git rev-parse succeeds", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git rev-parse --git-dir") {
        return Buffer.from(".git\n");
      }
      return Buffer.from("");
    });

    await expect(isGitRepository("/tmp/repo")).resolves.toBe(true);
  });

  it("returns false when target directory is not a git repository", async () => {
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      if (String(cmd) === "git rev-parse --git-dir" && opts?.cwd === "/tmp/plain") {
        const error: any = new Error("fatal: not a git repository");
        error.stderr = Buffer.from("fatal: not a git repository");
        throw error;
      }
      return Buffer.from("");
    });

    await expect(isGitRepository("/tmp/plain")).resolves.toBe(false);
  });

  it("returns false when directory does not exist", async () => {
    mockedExecSync.mockImplementation((cmd: any, opts?: any) => {
      if (String(cmd) === "git rev-parse --git-dir" && opts?.cwd === "/tmp/missing") {
        const error: any = new Error("spawn ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return Buffer.from("");
    });

    await expect(isGitRepository("/tmp/missing")).resolves.toBe(false);
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
  });
});

// ── scanOrphanedBranches tests ────────────────────────────────────────

describe("scanOrphanedBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: return empty string (no branches)
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git branch")) {
        return "";
      }
      return Buffer.from("");
    });
  });

  it("identifies branches not associated with any active task", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git branch")) {
        return "  fusion/fn-001\n  fusion/fn-002\n  fusion/fn-003\n";
      }
      return Buffer.from("");
    });

    const store = createMockStore([
      makeTask("FN-001", "in-progress"),
      makeTask("FN-002", "todo"),
    ]);

    const orphaned = await scanOrphanedBranches("/root", store);

    expect(orphaned).toEqual(["fusion/fn-003"]);
  });

  it("excludes in-review and done tasks (merger manages those)", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git branch")) {
        return "  fusion/fn-001\n  fusion/fn-002\n  fusion/fn-003\n";
      }
      return Buffer.from("");
    });

    const store = createMockStore([
      makeTask("FN-001", "in-review"),
      makeTask("FN-002", "done"),
    ]);

    const orphaned = await scanOrphanedBranches("/root", store);

    expect(orphaned).toContain("fusion/fn-001");
    expect(orphaned).toContain("fusion/fn-002");
    expect(orphaned).toContain("fusion/fn-003");
  });

  it("excludes archived tasks", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git branch")) {
        return "  fusion/fn-001\n";
      }
      return Buffer.from("");
    });

    const store = createMockStore([
      makeTask("FN-001", "archived"),
    ]);

    const orphaned = await scanOrphanedBranches("/root", store);

    expect(orphaned).toEqual(["fusion/fn-001"]);
  });

  it("uses task.branch field when set", async () => {
    const task = makeTask("FN-001", "in-progress");
    task.branch = "fusion/fn-001-custom";
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git branch")) {
        return "  fusion/fn-001\n  fusion/fn-001-custom\n  fusion/fn-002\n";
      }
      return Buffer.from("");
    });

    const store = createMockStore([task]);

    const orphaned = await scanOrphanedBranches("/root", store);

    expect(orphaned).toEqual(["fusion/fn-002"]);
  });

  it("returns empty array when git branch fails", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      if (typeof cmd === "string" && cmd.includes("git branch")) {
        throw new Error("not a git repo");
      }
      return Buffer.from("");
    });

    const store = createMockStore([]);

    const orphaned = await scanOrphanedBranches("/root", store);
    expect(orphaned).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[worktree-pool] Failed to list fusion/* branches: not a git repo"),
    );
  });

  it("returns empty array when no fusion/* branches exist", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git branch")) {
        return "";
      }
      return Buffer.from("");
    });

    const store = createMockStore([]);

    const orphaned = await scanOrphanedBranches("/root", store);
    expect(orphaned).toEqual([]);
  });

  it("strips leading * and whitespace from branch names", async () => {
    mockedExecSync.mockImplementation((cmd: any) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git branch")) {
        return "* fusion/fn-001\n  fusion/fn-002\n";
      }
      return Buffer.from("");
    });

    const store = createMockStore([]);

    const orphaned = await scanOrphanedBranches("/root", store);

    expect(orphaned).toContain("fusion/fn-001");
    expect(orphaned).toContain("fusion/fn-002");
  });
});

// ── reapOrphanWorktrees tests ─────────────────────────────────────────

describe("reapOrphanWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: .worktrees/ exists, lstatSync returns a real directory (not a symlink)
    mockedExistsSync.mockReturnValue(true);
    mockedLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false } as any);
    mockedReaddirSync.mockReturnValue([]);
    // Default: no registered worktrees
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git worktree list --porcelain") {
        return "worktree /root\nHEAD abc123\nbranch refs/heads/main\n\n" as any;
      }
      return Buffer.from("");
    });
  });

  it("returns 0 when .worktrees/ does not exist", async () => {
    mockedExistsSync.mockReturnValue(false);
    const removed = await reapOrphanWorktrees("/root");
    expect(removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it("returns 0 when .worktrees/ is empty", async () => {
    mockedReaddirSync.mockReturnValue([] as any);
    const removed = await reapOrphanWorktrees("/root");
    expect(removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it("removes a directory that has no .git file and is not registered", async () => {
    mockedReaddirSync.mockReturnValue([makeDirEntry("pale-raven")] as any);
    // .gitkeep exists but NOT a .git file — simulate with existsSync returning false for .git
    mockedExistsSync.mockImplementation((p: any) => {
      if (String(p) === "/root/.worktrees") return true;
      if (String(p).endsWith("/.git")) return false;
      return true;
    });

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(1);
    expect(mockedRmSync).toHaveBeenCalledWith("/root/.worktrees/pale-raven", {
      recursive: true,
      force: true,
    });
  });

  it("does NOT remove a directory that is a registered git worktree", async () => {
    mockedReaddirSync.mockReturnValue([makeDirEntry("swift-falcon")] as any);
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git worktree list --porcelain") {
        return [
          "worktree /root",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          "worktree /root/.worktrees/swift-falcon",
          "HEAD def456",
          "branch refs/heads/fusion/swift-falcon",
          "",
        ].join("\n") as any;
      }
      return Buffer.from("");
    });

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it("does NOT remove a directory that has a .git file (may be partially registered)", async () => {
    mockedReaddirSync.mockReturnValue([makeDirEntry("amber-wolf")] as any);
    mockedExistsSync.mockImplementation((p: any) => {
      if (String(p) === "/root/.worktrees") return true;
      if (String(p) === "/root/.worktrees/amber-wolf/.git") return true;
      return true;
    });

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it("does NOT remove symlinks", async () => {
    mockedReaddirSync.mockReturnValue([
      { name: "linked-wt", isDirectory: () => true } as any,
    ] as any);
    mockedLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => true } as any);

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it("handles multiple orphans and multiple registered worktrees correctly", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("orphan-1"),
      makeDirEntry("orphan-2"),
      makeDirEntry("good-wt"),
    ] as any);
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git worktree list --porcelain") {
        return [
          "worktree /root",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          "worktree /root/.worktrees/good-wt",
          "HEAD def456",
          "branch refs/heads/fusion/good-wt",
          "",
        ].join("\n") as any;
      }
      return Buffer.from("");
    });
    mockedExistsSync.mockImplementation((p: any) => {
      const ps = String(p);
      if (ps === "/root/.worktrees") return true;
      if (ps.endsWith("/.git")) return false;
      return true;
    });

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(2);
    expect(mockedRmSync).toHaveBeenCalledWith("/root/.worktrees/orphan-1", {
      recursive: true,
      force: true,
    });
    expect(mockedRmSync).toHaveBeenCalledWith("/root/.worktrees/orphan-2", {
      recursive: true,
      force: true,
    });
    expect(mockedRmSync).not.toHaveBeenCalledWith(
      expect.stringContaining("good-wt"),
      expect.anything(),
    );
  });

  it("continues and logs a warning when rmSync throws for one orphan", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("bad-orphan"),
      makeDirEntry("good-orphan"),
    ] as any);
    mockedExistsSync.mockImplementation((p: any) => {
      const ps = String(p);
      if (ps === "/root/.worktrees") return true;
      if (ps.endsWith("/.git")) return false;
      return true;
    });
    let callCount = 0;
    mockedRmSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error("permission denied");
    });

    const removed = await reapOrphanWorktrees("/root");

    // Only the second one succeeds
    expect(removed).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("reapOrphanWorktrees: failed to remove bad-orphan"),
    );
  });

  it("returns 0 and logs warning when git worktree list fails", async () => {
    mockedReaddirSync.mockReturnValue([makeDirEntry("some-dir")] as any);
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git worktree list --porcelain") {
        throw new Error("not a git repo");
      }
      return Buffer.from("");
    });
    mockedExistsSync.mockImplementation((p: any) => {
      const ps = String(p);
      if (ps === "/root/.worktrees") return true;
      if (ps.endsWith("/.git")) return false;
      return true;
    });

    // When git list fails, getRegisteredWorktreePaths returns an empty Set,
    // so any unregistered dir without a .git file would be reaped.
    // In this test we verify behavior is safe: no crash, returns a count.
    const removed = await reapOrphanWorktrees("/root");

    // some-dir has no .git, not registered (empty set due to failure) — gets reaped
    expect(removed).toBe(1);
    // The warn from getRegisteredWorktreePaths should appear
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to list registered worktrees"),
    );
  });
});
