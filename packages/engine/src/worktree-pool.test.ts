import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readdirSync: vi.fn().mockReturnValue([]),
  rmSync: vi.fn(),
}));

import { WorktreePool, scanIdleWorktrees, cleanupOrphanedWorktrees, scanOrphanedBranches } from "./worktree-pool.js";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import type { Task, Column } from "@fusion/core";

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedRmSync = vi.mocked(rmSync);

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
    it("returns the original branch name on success", () => {
      const result = pool.prepareForTask("/tmp/wt", "fusion/fn-042");
      expect(result).toBe("fusion/fn-042");
    });

    it("cleans dirty working tree before checkout", () => {
      pool.prepareForTask("/tmp/wt", "fusion/fn-042");

      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
      expect(calls).toContain("git checkout -- .");
      expect(calls).toContain("git clean -fd");
    });

    it("creates branch from main with force-reset", () => {
      pool.prepareForTask("/tmp/wt", "fusion/fn-042");

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout --detach main",
        expect.objectContaining({ cwd: "/tmp/wt" }),
      );

      const checkoutCall = mockedExecSync.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("checkout -B"),
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![0]).toBe('git checkout -B "fusion/fn-042" main');
      expect(checkoutCall![1]).toMatchObject({ cwd: "/tmp/wt" });
    });

    it("runs all commands in the correct worktree directory", () => {
      pool.prepareForTask("/tmp/my-worktree", "fusion/fn-099");

      for (const call of mockedExecSync.mock.calls) {
        expect(call[1]).toMatchObject({ cwd: "/tmp/my-worktree" });
      }
    });

    it("creates branch from custom startPoint when provided", () => {
      pool.prepareForTask("/tmp/wt", "fusion/fn-042", "fusion/fn-041");

      expect(mockedExecSync).toHaveBeenCalledWith(
        "git checkout --detach fusion/fn-041",
        expect.objectContaining({ cwd: "/tmp/wt" }),
      );

      const checkoutCall = mockedExecSync.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("checkout -B"),
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![0]).toBe('git checkout -B "fusion/fn-042" fusion/fn-041');
    });

    it("tolerates git checkout -- . failure (already clean)", () => {
      mockedExecSync.mockImplementation((cmd: any) => {
        if (cmd === "git checkout -- .") throw new Error("nothing to checkout");
        return Buffer.from("");
      });

      const result = pool.prepareForTask("/tmp/wt", "fusion/fn-001");
      expect(result).toBe("fusion/fn-001");

      // Should still run clean and branch creation
      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
      expect(calls).toContain("git clean -fd");
      expect(calls).toContain("git checkout --detach main");
      expect(calls).toContain('git checkout -B "fusion/fn-001" main');
    });

    it("uses suffixed branch name when original is in use by an active worktree", () => {
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

      const result = pool.prepareForTask("/tmp/wt", "fusion/fn-042");
      expect(result).toBe("fusion/fn-042-2");

      // Verify the suffixed checkout was called
      const checkoutCalls = mockedExecSync.mock.calls
        .map((c) => c[0])
        .filter((c) => typeof c === "string" && c.includes("checkout -B"));
      expect(checkoutCalls).toContain('git checkout -B "fusion/fn-042-2" main');
    });

    it("increments suffix when lower suffixes are also in use", () => {
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

      const result = pool.prepareForTask("/tmp/wt", "fusion/fn-042");
      expect(result).toBe("fusion/fn-042-3");
    });

    it("falls back to git worktree prune when conflicting worktree no longer exists on disk", () => {
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

      const result = pool.prepareForTask("/tmp/wt", "fusion/fn-042");
      expect(result).toBe("fusion/fn-042");

      const cmds = mockedExecSync.mock.calls.map((c) => c[0]);
      expect(cmds).toContain("git worktree prune");
    });

    it("re-throws non-conflict errors from checkout -B unchanged", () => {
      mockedExecSync.mockImplementation((cmd: any) => {
        if (String(cmd).includes("checkout -B")) {
          const err: any = new Error("some other git error");
          err.stderr = Buffer.from("fatal: some other git error");
          throw err;
        }
        return Buffer.from("");
      });

      expect(() => pool.prepareForTask("/tmp/wt", "fusion/fn-042")).toThrow(
        "some other git error"
      );
    });

    it("throws when all suffixed names are exhausted", () => {
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

      expect(() => pool.prepareForTask("/tmp/wt", "fusion/fn-042")).toThrow(
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

    // swift-falcon is assigned to in-progress task → NOT idle
    // calm-river is assigned to done task → idle (done tasks don't count)
    // bold-eagle is not assigned at all → idle
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

    // FN-001 (in-progress) and FN-002 (todo) are active → not orphaned
    // FN-003 has no task → orphaned
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

    // in-review and done tasks are excluded → their branches are orphaned
    // FN-003 also has no task → orphaned
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

    // Archived task branch is orphaned
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

    // Both fusion/fn-001 (derived) and fusion/fn-001-custom (stored) are active
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
