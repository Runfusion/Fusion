import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { acquireTaskWorktree } from "../worktree-acquisition.js";

// The pinned-mode branch is validated in isolation with mocked git/liveness seams so the tests stay
// fast and deterministic (no real-git worktree creation). classifyTaskWorktree / branch lookup / fs
// existence are the observable inputs to derive→validate→reuse-or-recreate; we drive each of them.
vi.mock("../worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return {
    ...actual,
    classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: true }),
    isInsideWorktreesDir: vi.fn().mockReturnValue(true),
    getRegisteredWorktreeBranches: vi.fn().mockResolvedValue([]),
    canonicalizePath: (p: string) => p,
    removeWorktree: vi.fn().mockResolvedValue({ removed: true, classification: "removed" }),
  };
});

vi.mock("../branch-conflicts.js", async () => {
  const actual = await vi.importActual<any>("../branch-conflicts.js");
  return {
    ...actual,
    classifyBootstrapMisbinding: vi.fn().mockResolvedValue({
      isBootstrapMisbinding: false,
      ownCommitCount: 0,
      foreignCommitCount: 0,
      nonAttributedCount: 0,
    }),
  };
});

vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0 }),
}));

vi.mock("../worktree-desktop-artifacts.js", () => ({
  removeDesktopBuildArtifacts: vi.fn().mockResolvedValue({ removed: [], skipped: [], failures: [] }),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<any>("node:fs");
  return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
});

import { existsSync } from "node:fs";
import { classifyTaskWorktree, getRegisteredWorktreeBranches, removeWorktree } from "../worktree-pool.js";

const ROOT = "/repo";
const PINNED = join(ROOT, ".worktrees", "fn-7996");

function makeStore() {
  return {
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const baseTask = {
  id: "FN-7996",
  title: "Task",
  description: "Desc",
  branch: null,
  worktree: null,
} as any;

const pinnedSettings = { worktreeNaming: "task-id" } as any;

describe("acquireTaskWorktree — task-pinned mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([]);
    vi.mocked(removeWorktree).mockResolvedValue({ removed: true, classification: "removed" } as any);
  });

  it("creates fresh at the derived <task-id> path when absent, never suffixed", async () => {
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
    const result = await acquireTaskWorktree({
      task: baseTask,
      rootDir: ROOT,
      store: makeStore(),
      settings: pinnedSettings,
      createWorktree,
    });

    expect(result.source).toBe("fresh");
    expect(result.worktreePath).toBe(PINNED);
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-7996", PINNED, "FN-7996", "main", false);
  });

  it("acceptance #2: task B's pinned acquisition yields fn-<B>, never task A's dir", async () => {
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
    const result = await acquireTaskWorktree({
      task: { ...baseTask, id: "FN-8069" },
      rootDir: ROOT,
      store: makeStore(),
      settings: pinnedSettings,
      // A pool is attached with recycleWorktrees on — pinned mode must ignore it entirely.
      pool: { acquire: vi.fn(() => join(ROOT, ".worktrees", "grand-ridge")), prepareForTask: vi.fn(), release: vi.fn() } as any,
      settingsOverride: undefined,
      createWorktree,
    } as any);

    expect(result.worktreePath).toBe(join(ROOT, ".worktrees", "fn-8069"));
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-8069", join(ROOT, ".worktrees", "fn-8069"), "FN-8069", "main", false);
  });

  it("runtime backstop: recycle ON disables pinning (mutually exclusive) so the pool is consulted", async () => {
    // recycleWorktrees + worktreeNaming:"task-id" is rejected at the settings-write boundary; if a legacy
    // on-disk config still carries both, the runtime degrades safely to recycling (pinning off), so the
    // pool IS consulted — pinned mode never calls pool.acquire.
    const acquire = vi.fn(() => null); // empty pool → falls through to fresh
    const release = vi.fn();
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));

    const result = await acquireTaskWorktree({
      task: baseTask,
      rootDir: ROOT,
      store: makeStore(),
      settings: { worktreeNaming: "task-id", recycleWorktrees: true } as any,
      pool: { acquire, prepareForTask: vi.fn(), release } as any,
      createWorktree,
    });

    expect(acquire).toHaveBeenCalledWith("FN-7996");
    // Falls through to the normal fresh path (task-id naming still derives fn-7996 for the directory name).
    expect(result.worktreePath).toBe(PINNED);
  });

  it("warm-reuses the pinned dir when it is usable and on the task branch", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: "fusion/fn-7996", worktreePath: PINNED }]);
    const createWorktree = vi.fn();

    const result = await acquireTaskWorktree({
      task: { ...baseTask, worktree: PINNED, branch: "fusion/fn-7996" },
      rootDir: ROOT,
      store: makeStore(),
      settings: pinnedSettings,
      createWorktree,
    });

    expect(result.source).toBe("existing");
    expect(result.isResume).toBe(true);
    expect(result.worktreePath).toBe(PINNED);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("acceptance #5: reclaims a same-name dir on a foreign branch in place (no suffix)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    // Registered, usable — but checked out on a foreign branch.
    vi.mocked(getRegisteredWorktreeBranches).mockResolvedValue([{ branch: "fusion/fn-0000", worktreePath: PINNED }]);
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
    const audit = { git: vi.fn().mockResolvedValue(undefined), filesystem: vi.fn() } as any;

    const result = await acquireTaskWorktree({
      task: { ...baseTask, worktree: PINNED, branch: "fusion/fn-7996" },
      rootDir: ROOT,
      store: makeStore(),
      settings: pinnedSettings,
      createWorktree,
      audit,
    });

    expect(removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: PINNED }));
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-7996", PINNED, "FN-7996", "main", false);
    expect(result.worktreePath).toBe(PINNED);
    expect(result.source).toBe("fresh");
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:incomplete-detected",
      metadata: expect.objectContaining({ classification: "foreign-branch", source: "pinned-acquire" }),
    }));
  });

  it("reclaims an unregistered same-name dir in place", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: false, classification: "unregistered", reason: "not registered" } as any);
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));

    const result = await acquireTaskWorktree({
      task: baseTask,
      rootDir: ROOT,
      store: makeStore(),
      settings: pinnedSettings,
      createWorktree,
    });

    expect(removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: PINNED }));
    expect(createWorktree).toHaveBeenCalledWith("fusion/fn-7996", PINNED, "FN-7996", "main", false);
    expect(result.worktreePath).toBe(PINNED);
  });

  it("acceptance #3: self-corrects a stale/foreign task.worktree pointer and emits worktree:pin-rederived", async () => {
    // FN-7996 shape: task.worktree points at a foreign, removed pool dir; pinned dir itself is absent.
    vi.mocked(existsSync).mockReturnValue(false);
    const createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
    const audit = { git: vi.fn().mockResolvedValue(undefined), filesystem: vi.fn() } as any;
    const store = makeStore();

    const result = await acquireTaskWorktree({
      task: { ...baseTask, worktree: join(ROOT, ".worktrees", "grand-ridge"), branch: "fusion/fn-7996" },
      rootDir: ROOT,
      store,
      settings: pinnedSettings,
      createWorktree,
      audit,
    });

    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:pin-rederived",
      metadata: expect.objectContaining({ taskId: "FN-7996", derived: PINNED }),
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-7996", { worktree: PINNED });
    expect(result.worktreePath).toBe(PINNED);
    expect(result.source).toBe("fresh");
  });
});
