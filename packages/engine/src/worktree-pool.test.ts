import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readdirSync: vi.fn().mockReturnValue([]),
}));

import { WorktreePool, scanIdleWorktrees, cleanupOrphanedWorktrees } from "./worktree-pool.js";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import type { Task, Column } from "@fusion/core";

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);

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
    it("cleans dirty working tree before checkout", () => {
      pool.prepareForTask("/tmp/wt", "fusion/fn-042");

      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
      expect(calls).toContain("git checkout -- .");
      expect(calls).toContain("git clean -fd");
    });

    it("creates branch from main with force-reset", () => {
      pool.prepareForTask("/tmp/wt", "fusion/fn-042");

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

      const checkoutCall = mockedExecSync.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("checkout -B"),
      );
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall![0]).toBe('git checkout -B "fusion/fn-042" kb/kb-041');
    });

    it("tolerates git checkout -- . failure (already clean)", () => {
      mockedExecSync.mockImplementation((cmd: any) => {
        if (cmd === "git checkout -- .") throw new Error("nothing to checkout");
        return Buffer.from("");
      });

      // Should not throw
      expect(() => pool.prepareForTask("/tmp/wt", "fusion/fn-001")).not.toThrow();

      // Should still run clean and branch creation
      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
      expect(calls).toContain("git clean -fd");
      expect(calls).toContain('git checkout -B "fusion/fn-001" main');
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

// ── scanIdleWorktrees tests ───────────────────────────────────────────

describe("scanIdleWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("correctly identifies idle vs active worktrees", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("swift-falcon"),
      makeDirEntry("calm-river"),
      makeDirEntry("bold-eagle"),
    ] as any);

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
});

// ── cleanupOrphanedWorktrees tests ────────────────────────────────────

describe("cleanupOrphanedWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedExecSync.mockReturnValue(Buffer.from(""));
  });

  it("removes worktrees not assigned to any active task", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("orphan-1"),
      makeDirEntry("orphan-2"),
    ] as any);

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
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("returns 0 when all worktrees are assigned to active tasks", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("active-1"),
      makeDirEntry("active-2"),
    ] as any);

    const store = createMockStore([
      makeTask("FN-001", "in-progress", "/root/.worktrees/active-1"),
      makeTask("FN-002", "in-review", "/root/.worktrees/active-2"),
    ]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);
    expect(cleaned).toBe(0);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });
});
