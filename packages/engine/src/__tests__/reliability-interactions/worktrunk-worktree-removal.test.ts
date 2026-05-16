import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, TaskStore, Task } from "@fusion/core";
import { cleanupOrphanedWorktrees } from "../../worktree-pool.js";
import { SelfHealingManager } from "../../self-healing.js";
import { mergerTestHooks } from "../../merger.js";
import { NativeWorktreeBackend, WorktrunkWorktreeBackend } from "../../worktree-backend.js";

const { execSpy, existsSpy, readdirSpy } = vi.hoisted(() => ({
  execSpy: vi.fn(),
  existsSpy: vi.fn(() => true),
  readdirSpy: vi.fn(() => []),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: execSpy };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSpy, readdirSync: readdirSpy };
});

function storeForSelfHealing(settings: Partial<Settings>, task: Partial<Task>): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, ...settings } as Settings)),
    listTasks: vi.fn(async ({ column }: any = {}) => (column === "in-review" ? [task] : [])),
    updateTask: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    getTask: vi.fn(async () => task),
  }) as unknown as TaskStore & EventEmitter;
}

describe("reliability interactions: worktrunk worktree removal routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execSpy.mockImplementation((_cmd: string, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => cb(null, "", ""));
    existsSpy.mockReturnValue(true);
  });

  it("merger post-merge cleanup calls worktrunk backend remove and avoids native git remove", async () => {
    const removeSpy = vi.spyOn(WorktrunkWorktreeBackend.prototype, "remove").mockResolvedValue(undefined);

    await mergerTestHooks.removePostMergeWorktree("/repo", "/repo/.worktrees/post", "FN-100", {
      worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fail" } as any,
    });

    expect(removeSpy).toHaveBeenCalledWith(expect.objectContaining({ rootDir: "/repo", worktreePath: "/repo/.worktrees/post", taskId: "FN-100" }));
    expect(execSpy.mock.calls.some((call) => String(call[0]).includes("git worktree remove"))).toBe(false);
  });

  it("self-healing recover path calls worktrunk backend remove and not native remove", async () => {
    const removeSpy = vi.spyOn(WorktrunkWorktreeBackend.prototype, "remove").mockResolvedValue(undefined);
    const task = {
      id: "FN-999",
      column: "in-review",
      status: "failed",
      branch: "fusion/fn-999",
      worktree: "/repo/.worktrees/fn-999",
      mergeDetails: { mergeConfirmed: false },
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Task;
    const store = storeForSelfHealing({ worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fail" } as any }, task);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo", getExecutingTaskIds: () => new Set() });

    vi.spyOn(mgr as any, "isBranchTipMisboundToTask").mockResolvedValue({ misbound: true, branchTip: "abc", landed: { sha: "abc", strategy: "tip-reachable" } });
    vi.spyOn(mgr as any, "clearCompletionBranchIfSubsumed").mockResolvedValue(true);

    await mgr.recoverBranchMisboundInReviewTasks();

    expect(removeSpy).toHaveBeenCalledWith(expect.objectContaining({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-999", taskId: "FN-999" }));
    expect(execSpy.mock.calls.some((call) => String(call[0]).includes("git worktree remove"))).toBe(false);
  });

  it("worktree-pool cleanup registered branch calls native backend remove", async () => {
    const removeSpy = vi.spyOn(NativeWorktreeBackend.prototype, "remove").mockResolvedValue(undefined);
    readdirSpy.mockReturnValue([{ isDirectory: () => true, name: "fn-1" }]);
    execSpy.mockImplementation((cmd: string, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      if (cmd.includes("git worktree list --porcelain")) {
        cb(null, "worktree /repo/.worktrees/fn-1\n", "");
        return;
      }
      cb(null, "", "");
    });

    const store = { listTasks: vi.fn(async () => []) } as unknown as TaskStore;
    await cleanupOrphanedWorktrees("/repo", store, { worktreesDir: "/repo/.worktrees" });

    expect(removeSpy).toHaveBeenCalledWith(expect.objectContaining({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1" }));
  });
});
