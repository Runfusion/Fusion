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

vi.mock("../worktree/worktree-desktop-artifacts.js", () => ({
  removeDesktopBuildArtifacts: vi.fn().mockResolvedValue({ removed: [], skipped: [], failures: [] }),
}));

vi.mock("../worktree/worktree-paths.js", () => ({
  isInsideConfiguredWorktreesDir: vi.fn(() => true),
  isReclaimableWorktreeCandidate: vi.fn().mockResolvedValue(true),
  isWorktreeContainerDir: vi.fn((name: string) => name === ".ai-merge" || name === ".fusion-recovery" || name === ".fusion-worktree-locks"),
  resolveWorktreesDirScanRoots: vi.fn((rootDir: string) => [`${rootDir}/.worktrees`]),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  lstatSync: vi.fn().mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false }),
  readdirSync: vi.fn().mockReturnValue([]),
  readFileSync: vi.fn().mockReturnValue(""),
  rmSync: vi.fn(),
  realpathSync: vi.fn((path: string) => path),
}));

vi.mock("../worktree/worktree-prune.js", () => ({
  pruneWorktreeAdminEntries: vi.fn().mockResolvedValue(undefined),
}));

import * as desktopArtifacts from "../worktree/worktree-desktop-artifacts.js";
import * as worktreePrune from "../worktree/worktree-prune.js";
import {
  detectGitRepository,
  getRegisteredWorktreeBranchMap,
  getRegisteredWorktreePaths,
  isGitRepository,
  scanIdleWorktrees,
  cleanupOrphanedWorktrees,
  reapOrphanWorktrees,
} from "../worktree/worktree-pool.js";
import { BranchConflictError } from "../execution/branch-conflicts.js";
import * as branchConflictModule from "../execution/branch-conflicts.js";
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
  /*
  FNXC:TestInfrastructure 2026-07-29-17:05:
  worktree-pool logs its checkout-failure at DEBUG level, and createLogger's debug
  writes to console.error like the rest — but debug is GATED on FUSION_DEBUG
  (logger.ts:43), which is unset under vitest. So the line was never emitted and
  the two checkout-failure cases below measured zero calls. One of them is even
  named "logs checkout -- failure at debug level" while asserting a channel debug
  could not reach without this flag. Enabling it is what makes those assertions
  real; re-pointing them at another channel would only describe whatever the code
  happened to do. Deleted in afterEach so the flag cannot leak into sibling files.
  */
  process.env.FUSION_DEBUG = "worktree-pool";
});

afterEach(() => {
  delete process.env.FUSION_DEBUG;
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

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
  return { listTasks: vi.fn().mockResolvedValue(tasks) } as any;
}

function makeDirEntry(name: string) {
  return { name, isDirectory: () => true } as any;
}

function mockRegisteredWorktrees(rootDir: string, names: string[]) {
  mockedExecSync.mockImplementation((cmd: any) => {
    if (String(cmd).includes("rev-parse --git-common-dir")) return Buffer.from(`${rootDir}/.git\n`);
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
      expect.stringContaining("[worktree-pool] Failed to read worktrees directory /root/.worktrees: Permission denied"),
    );
  });

  it("excludes internal containers even when git lists their children", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry(".ai-merge"),
      makeDirEntry(".fusion-recovery"),
      makeDirEntry("registered-wt"),
    ] as any);
    mockRegisteredWorktrees("/root", [
      ".ai-merge/fusion-ai-merge-fn-1-active",
      ".fusion-recovery/worktrees/fn-1-preserved",
      "registered-wt",
    ]);

    const store = createMockStore([]);

    const idle = await scanIdleWorktrees("/root", store);
    expect(idle).toEqual(["/root/.worktrees/registered-wt"]);
    expect(idle).not.toContain("/root/.worktrees/.ai-merge");
    expect(idle).not.toContain("/root/.worktrees/.fusion-recovery");
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
      expect.stringContaining("[worktree-pool] Failed to read worktrees directory /root/.worktrees for cleanup: cleanup permission denied"),
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

  it("excludes internal containers and preserves unregistered orphans", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry(".ai-merge"),
      makeDirEntry(".fusion-recovery"),
      makeDirEntry("broken-wt"),
    ] as any);
    mockRegisteredWorktrees("/root", []);

    const store = createMockStore([]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    expect(cleaned).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/broken-wt", expect.anything());
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/.ai-merge", expect.anything());
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/.fusion-recovery", expect.anything());
  });

  it("preserves unregistered directories referenced by stale active task metadata", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry("broken-wt"),
    ] as any);
    mockRegisteredWorktrees("/root", []);

    const store = createMockStore([
      makeTask("FN-001", "in-progress", "/root/.worktrees/broken-wt"),
    ]);

    const cleaned = await cleanupOrphanedWorktrees("/root", store);

    expect(cleaned).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/broken-wt", expect.anything());
    expect(mockedPruneWorktreeAdminEntries).not.toHaveBeenCalled();
  });
});

describe("reapOrphanWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegisteredWorktrees("/root", []);
    mockedExistsSync.mockImplementation((path) => String(path) === "/root/.worktrees");
    mockedLstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false } as any);
  });

  it("excludes containers and unproven half-initialized directories", async () => {
    mockedReaddirSync.mockReturnValue([
      makeDirEntry(".ai-merge"),
      makeDirEntry(".fusion-recovery"),
      makeDirEntry("half-built"),
    ] as any);

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/half-built", expect.anything());
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/.ai-merge", expect.anything());
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/.fusion-recovery", expect.anything());
  });

  it("preserves a dir with a dangling .git pointer", async () => {
    mockedReaddirSync.mockReturnValue([makeDirEntry("leaked-wt")] as any);
    mockedLstatSync.mockImplementation((p: any) =>
      (String(p).endsWith("/.git")
        ? { isDirectory: () => false, isSymbolicLink: () => false }
        : { isDirectory: () => true, isSymbolicLink: () => false }) as any,
    );
    mockedReadFileSync.mockReturnValue("gitdir: /root/.git/worktrees/leaked-wt\n" as any);
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s === "/root/.worktrees" || s === "/root/.worktrees/leaked-wt/.git";
    });

    const removed = await reapOrphanWorktrees("/root");

    expect(removed).toBe(0);
    expect(mockedRmSync).not.toHaveBeenCalledWith("/root/.worktrees/leaked-wt", expect.anything());
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

