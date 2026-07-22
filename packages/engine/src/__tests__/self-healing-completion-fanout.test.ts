import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

const { execMock, existsSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  existsSyncMock: vi.fn(() => false),
}));
vi.mock("node:child_process", () => ({ exec: execMock, execSync: vi.fn(), execFile: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});

const { uniqueCommitsMock } = vi.hoisted(() => ({
  uniqueCommitsMock: vi.fn(async () => ({ commits: [], mainRef: "main", degraded: false })),
}));
vi.mock("../execution/branch-conflicts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../execution/branch-conflicts.js")>();
  return { ...actual, listUniqueBranchCommits: uniqueCommitsMock };
});

const { logger } = vi.hoisted(() => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../logger.js", () => ({ createLogger: vi.fn(() => logger) }));

import { SelfHealingManager } from "../self-healing.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function createStore(tasks: Task[], settings?: Partial<Settings>): TaskStore & EventEmitter {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const emitter = new EventEmitter();
  const cfg: Settings = { globalPause: false, enginePaused: false } as Settings;
  Object.assign(cfg, settings ?? {});
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => cfg),
    listTasks: vi.fn(async (opts?: { column?: Task["column"]; includeArchived?: boolean }) => {
      const all = [...map.values()];
      if (!opts?.column) return all;
      return all.filter((t) => t.column === opts.column);
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
  }) as unknown as TaskStore & EventEmitter;
}

describe("self-healing completion fan-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execMock.mockImplementation((cmd: string, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
      cb(null, "", "");
    });
  });

  it("clears/advances dependents and respects paused in-review", async () => {
    const blocker = makeTask("FN-B", { column: "done", branch: "fusion/fn-b" });
    const other = makeTask("FN-OTHER", { column: "todo" });
    const clearTodo = makeTask("FN-CLEAR", { blockedBy: "FN-B", column: "todo" });
    const queuedTodo = makeTask("FN-QUEUE", { blockedBy: "FN-B", column: "todo", dependencies: ["FN-B", "FN-OTHER"], status: "queued" as any });
    const inProgress = makeTask("FN-P", { blockedBy: "FN-B", column: "in-progress" });
    const pausedReview = makeTask("FN-PAUSE", { blockedBy: "FN-B", column: "in-review", paused: true });
    const store = createStore([blocker, other, clearTodo, queuedTodo, inProgress, pausedReview]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const res = await mgr.reconcileCompletedTask("FN-B");
    expect(res.blockedByCleared).toBe(3);
    expect((await store.getTask("FN-CLEAR"))?.blockedBy).toBeNull();
    expect((await store.getTask("FN-CLEAR"))?.status).toBeNull();
    expect((await store.getTask("FN-QUEUE"))?.blockedBy).toBe("FN-OTHER");
    expect((await store.getTask("FN-QUEUE"))?.status).toBe("queued");
    expect((await store.getTask("FN-P"))?.blockedBy).toBeNull();
    expect((await store.getTask("FN-PAUSE"))?.blockedBy).toBe("FN-B");
    expect((store as any).logEntry).toHaveBeenCalledWith(
      "FN-CLEAR",
      expect.stringContaining("FN-4523"),
    );
  });

  it("prefers worktree hint and is idempotent when missing", async () => {
    (existsSyncMock as any).mockImplementation((p: string) => p === "/wt/fn-b");
    const blocker = makeTask("FN-B", { column: "done", branch: "fusion/fn-b" });
    const store = createStore([blocker]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const first = await mgr.reconcileCompletedTask("FN-B", { worktreeHint: "/wt/fn-b" });
    expect(first.worktreeRemoved).toBe(true);
    expect(execMock.mock.calls.some((c) => String(c[0]).includes("git worktree remove --force") && String(c[0]).includes("/wt/fn-b"))).toBe(true);

    existsSyncMock.mockReturnValue(false);
    const second = await mgr.reconcileCompletedTask("FN-B");
    expect(second.worktreeRemoved).toBe(false);
    const rmCalls = execMock.mock.calls.filter((c) => String(c[0]).includes("git worktree remove --force") && String(c[0]).includes("/wt/fn-b"));
    expect(rmCalls).toHaveLength(1);
  });

  it("falls back to task.worktree when hint/branch mapping are unavailable", async () => {
    (existsSyncMock as any).mockImplementation((p: string) => p === "/wt/fn-c");
    uniqueCommitsMock.mockResolvedValue({ commits: [{ sha: "abc", subject: "x" }] as any, mainRef: "main", degraded: false });

    const blocker = makeTask("FN-C", { column: "done", branch: null as any, worktree: "/wt/fn-c" });
    const store = createStore([blocker]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });
    const findSpy = vi.spyOn(mgr as any, "findWorktreePathForBranch");

    const out = await mgr.reconcileCompletedTask("FN-C");
    expect(out.worktreeRemoved).toBe(true);
    expect(findSpy).not.toHaveBeenCalled();
    expect(execMock.mock.calls.some((c) => String(c[0]).includes("git worktree remove --force") && String(c[0]).includes("/wt/fn-c"))).toBe(true);
    expect((await store.getTask("FN-C"))?.worktree).toBeNull();
    expect((await store.getTask("FN-C"))?.branch).toBeNull();
    expect(out.branchRemoved).toBe(false);
  });

  it("globalPause short-circuits", async () => {
    const blocker = makeTask("FN-B", { column: "done" });
    const dependent = makeTask("FN-D", { blockedBy: "FN-B", column: "todo" });
    const store = createStore([blocker, dependent], { globalPause: true });
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });
    const out = await mgr.reconcileCompletedTask("FN-B");
    expect(out).toEqual({ blockedByCleared: 0, worktreeRemoved: false, branchRemoved: false });
    expect((store as any).updateTask).not.toHaveBeenCalled();
  });

  it("recoverAlreadyMergedReviewTasks calls reconcile with worktreeHint", async () => {
    const t = makeTask("FN-R", { column: "in-review", status: "failed" as any, mergeRetries: 3, branch: "fusion/fn-r", worktree: "/wt/fn-r" });
    const store = createStore([t]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo", getExecutingTaskIds: () => new Set() });
    vi.spyOn(mgr as any, "findAlreadyMergedTaskCommit").mockResolvedValue({ sha: "abc123", strategy: "trailer" });
    const spy = vi.spyOn(mgr, "reconcileCompletedTask").mockResolvedValue({ blockedByCleared: 0, worktreeRemoved: false, branchRemoved: false });
    await mgr.recoverAlreadyMergedReviewTasks();
    expect(spy).toHaveBeenCalledWith("FN-R", { worktreeHint: "/wt/fn-r" });
  });

  it("wires and unwires task:moved listener", async () => {
    const t = makeTask("FN-L", { column: "in-review" });
    const store = createStore([t]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });
    const spy = vi.spyOn(mgr, "reconcileCompletedTask").mockResolvedValue({ blockedByCleared: 0, worktreeRemoved: false, branchRemoved: false });

    mgr.start();
    store.emit("task:moved", { task: t, from: "in-review", to: "done", source: "user" });
    store.emit("task:moved", { task: t, from: "done", to: "archived", source: "engine" });
    store.emit("task:moved", { task: t, from: "in-review", to: "todo", source: "user" });
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, "FN-L", { worktreeHint: undefined });

    mgr.stop();
    store.emit("task:moved", { task: t, from: "in-review", to: "done", source: "user" });
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("clears task.worktree and matching task.branch after successful removal", async () => {
    (existsSyncMock as any).mockImplementation((p: string) => p === "/wt/fn-d");
    uniqueCommitsMock.mockResolvedValue({ commits: [], mainRef: "main", degraded: false });
    const blocker = makeTask("FN-D", { column: "done", branch: "fusion/fn-d", worktree: "/wt/fn-d" });
    const store = createStore([blocker]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const out = await mgr.reconcileCompletedTask("FN-D", { worktreeHint: "/wt/fn-d" });
    expect(out.worktreeRemoved).toBe(true);
    expect((await store.getTask("FN-D"))?.worktree).toBeNull();
    expect((await store.getTask("FN-D"))?.branch).toBeNull();
  });
});
