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
vi.mock("../branch-conflicts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../branch-conflicts.js")>();
  return { ...actual, listUniqueBranchCommits: uniqueCommitsMock };
});

const { logger } = vi.hoisted(() => ({
  /*
  FNXC:TestInfrastructure 2026-07-29-13:10 (U9):
  `debug` is part of createLogger's real shape and SelfHealingManager.start /
  startMaintenance both call it. Omitting it here threw "log.debug is not a
  function" out of start(), so "wires and unwires task:moved listener" was
  permanently red AND leaked an unhandled rejection from startMaintenance that
  vitest warns can cause false positives in the rest of the file.
  */
  logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    /*
    FNXC:StaleActiveBranchDoneSpam 2026-08-03-01:47:
    Post-completion branch cleanup force-deletes even when the tip still has unique commits vs main
    (squash/AI-merge shape). Previously this case expected branchRemoved=false and left fusion/* forever.
    */
    expect(out.branchRemoved).toBe(true);
    expect(execMock.mock.calls.some((c) => String(c[0]).includes("git branch -D") && String(c[0]).includes("fusion/fn-c"))).toBe(true);
  });

  it("force-deletes completion branch when unique commits remain after squash", async () => {
    uniqueCommitsMock.mockResolvedValue({
      commits: [{ sha: "deadbeef", subject: "feat: pre-squash tip" }] as any,
      mainRef: "main",
      degraded: false,
    });
    const blocker = makeTask("FN-SQUASH", { column: "done", branch: "fusion/fn-squash" });
    const store = createStore([blocker]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const out = await mgr.reconcileCompletedTask("FN-SQUASH");
    expect(out.branchRemoved).toBe(true);
    expect(execMock.mock.calls.some((c) => String(c[0]).includes("git branch -D") && String(c[0]).includes("fusion/fn-squash"))).toBe(true);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("force-deleting post-completion"));
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
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:40:
    `await Promise.resolve()` was draining exactly one microtask, which coupled this case to the
    number of awaits inside a FIRE-AND-FORGET path. The listener does not await the fan-out and never
    did, so how many microtasks it takes is not the contract — "it ran, twice, for the right
    transitions" is. Resolving the lanes adds an await, so the drain is now written against the
    invariant instead of against the old await count.
    */
    await vi.waitFor(() => { expect(spy).toHaveBeenCalledTimes(2); });
    expect(spy).toHaveBeenNthCalledWith(1, "FN-L", { worktreeHint: undefined });

    mgr.stop();
    store.emit("task:moved", { task: t, from: "in-review", to: "done", source: "user" });
    /* The negative keeps a real drain: an unwired listener must stay silent after several ticks,
       not merely after one. */
    await new Promise((resolve) => setTimeout(resolve, 10));
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

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:45:
THE `task:moved` FAN-OUT ON A RENAMED BOARD.

Two of this listener's guards were keyed on `in-review`/`done`/`archived`, so on a board using none
of those ids a card entering its own review lane never had its branch rebound, and a card reaching
its own complete or archive lane never ran the completion fan-out — the worktree was never reclaimed
and dependents kept a `blockedBy` pointing at a blocker that had already finished.

The SYNC-IR conversion of this listener is inert and was withdrawn. These two guards gate work the
listener already `void`s, so they can ask the ASYNC resolver instead without changing anything an
observer can see; the resolution reads `listWorkflowDefinitions()`, which is answerable under
PostgreSQL.

The board-stall counter above them is deliberately NOT converted here: it mutates in-memory state in
the handler's own tick, so it is the one guard that genuinely needs a synchronous answer.
*/
describe("the task:moved fan-out resolves the board's own lanes", () => {
  /** Review `checking`, complete `shipped`, archive `filed` — no legacy id anywhere. */
  const RENAMED_IR = {
    version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
    columns: [
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      { id: "filed", name: "Filed", traits: [{ trait: "archived" }] },
    ],
  };

  function renamedStore(task: Task) {
    const base = createStore([task]) as unknown as TaskStore & EventEmitter;
    (base as unknown as { listWorkflowDefinitions: unknown }).listWorkflowDefinitions =
      vi.fn(async () => [{ ir: RENAMED_IR }]);
    return base;
  }

  it("runs the completion fan-out for the board's own review -> complete transition", async () => {
    const t = makeTask("FN-R1", { column: "shipped" });
    const store = renamedStore(t);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });
    const spy = vi.spyOn(mgr, "reconcileCompletedTask").mockResolvedValue({ blockedByCleared: 0, worktreeRemoved: false, branchRemoved: false });

    mgr.start();
    store.emit("task:moved", { task: t, from: "checking", to: "shipped", source: "engine" });

    await vi.waitFor(() => { expect(spy).toHaveBeenCalledWith("FN-R1", { worktreeHint: undefined }); });
    mgr.stop();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-19:30:
  `completedReviewColumns` was UNCOVERED on the #3115 map. It reads the DEPENDENTS resting in review
  when a blocker completes; no case here put a dependent in a renamed review lane, so blinding it left
  the file green.

  What the literal costs: a dependent sitting in review is never read, so its `blockedBy` is never
  cleared when the blocker finishes. It stays blocked by work that is already done — the most visible
  form of this class, because the board simply stops moving.
  */
  it("clears blockedBy for a dependent resting in the board's own review lane", async () => {
    const blocker = makeTask("FN-BLOCKER", { column: "shipped" });
    const dependent = makeTask("FN-DEP", { column: "checking", blockedBy: "FN-BLOCKER", status: "queued" });
    const store = createStore([blocker, dependent]) as unknown as TaskStore & EventEmitter;
    (store as unknown as { listWorkflowDefinitions: unknown }).listWorkflowDefinitions =
      vi.fn(async () => [{ id: "wf-renamed", ir: RENAMED_IR }]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    await mgr.reconcileCompletedTask("FN-BLOCKER");

    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-DEP",
      expect.objectContaining({ blockedBy: null }),
    );
    mgr.stop();
  });

  it("rebinds the branch on a move into the board's own review lane", async () => {
    const t = makeTask("FN-R2", { column: "checking" });
    const store = renamedStore(t);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });
    const rebind = vi.spyOn(mgr, "reconcileInReviewBranchRebind").mockResolvedValue(0 as never);

    mgr.start();
    store.emit("task:moved", { task: t, from: "building", to: "checking", source: "engine" });

    await vi.waitFor(() => { expect(rebind).toHaveBeenCalledWith({ includeTaskIds: new Set(["FN-R2"]) }); });
    mgr.stop();
  });

  /*
  The paired negative. The conversion widens membership, so it must not fan out on every move: a
  `checking -> building` bounce is not a completion, and reconciling it would remove the worktree of
  a card that is about to run again.
  */
  it("does NOT run the completion fan-out for a bounce back into the wip lane", async () => {
    const t = makeTask("FN-R3", { column: "building" });
    const store = renamedStore(t);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });
    const spy = vi.spyOn(mgr, "reconcileCompletedTask").mockResolvedValue({ blockedByCleared: 0, worktreeRemoved: false, branchRemoved: false });

    mgr.start();
    store.emit("task:moved", { task: t, from: "checking", to: "building", source: "engine" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spy).not.toHaveBeenCalled();
    mgr.stop();
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:45:
THE BOARD-STALL COUNTER, the last fan-out guard and the only one that needed a SYNCHRONOUS answer.

It increments in-memory state in the handler's own tick, so it could not follow the other two guards
onto the async resolver, and the sync IR path cannot resolve a custom workflow at all — a conversion
through it would have been inert. #3109's emitter-carried `lanes` removes the dilemma: reading them
needs no await, so the increment stays in the same tick and the guard becomes correct.

On a renamed board this counter read ZERO, so the board-stall watchdog was blind to a board whose
cards were moving out of implementation the whole time.

Asserted through the counter itself rather than a downstream alert: the increment IS what the guard
decides, and routing the assertion through the watchdog would let an unrelated threshold change mask
a regression here.
*/
describe("the board-stall counter follows the board's own lanes", () => {
  const RENAMED_LANES = { hold: "drafting", intake: "inbox", wip: "building", review: "checking", complete: "shipped", archived: "filed" };

  function startedManager(store: TaskStore & EventEmitter) {
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });
    vi.spyOn(mgr as unknown as { startMaintenance: () => void }, "startMaintenance").mockImplementation(() => {});
    vi.spyOn(mgr, "reconcileCompletedTask").mockResolvedValue({ blockedByCleared: 0, worktreeRemoved: false, branchRemoved: false });
    vi.spyOn(mgr, "reconcileInReviewBranchRebind").mockResolvedValue(0 as never);
    mgr.start();
    (mgr as unknown as { boardStallWindow: { transitionsOutOfInProgressInWindow: number } }).boardStallWindow =
      { transitionsOutOfInProgressInWindow: 0 };
    return mgr;
  }

  const counterOf = (mgr: SelfHealingManager) =>
    (mgr as unknown as { boardStallWindow: { transitionsOutOfInProgressInWindow: number } }).boardStallWindow
      .transitionsOutOfInProgressInWindow;

  it("counts a move out of the RENAMED wip lane into the renamed review lane", () => {
    const t = makeTask("FN-C1", { column: "checking" });
    const store = createStore([t]);
    const mgr = startedManager(store);

    store.emit("task:moved", { task: t, from: "building", to: "checking", source: "engine", lanes: RENAMED_LANES });

    expect(counterOf(mgr)).toBe(1);
    mgr.stop();
  });

  /*
  The paired negative. The guard is "left implementation for somewhere that is NOT implementation",
  so a move BETWEEN two non-wip lanes must not count — otherwise the watchdog's denominator inflates
  and it stops firing for the opposite reason.
  */
  it("does NOT count a move that did not leave the wip lane", () => {
    const t = makeTask("FN-C2", { column: "shipped" });
    const store = createStore([t]);
    const mgr = startedManager(store);

    store.emit("task:moved", { task: t, from: "checking", to: "shipped", source: "engine", lanes: RENAMED_LANES });

    expect(counterOf(mgr)).toBe(0);
    mgr.stop();
  });

  it("falls back to the legacy ids when the emitter sent no lanes", () => {
    const t = makeTask("FN-C3", { column: "in-review" });
    const store = createStore([t]);
    const mgr = startedManager(store);

    store.emit("task:moved", { task: t, from: "in-progress", to: "in-review", source: "engine" });

    expect(counterOf(mgr)).toBe(1);
    mgr.stop();
  });
});
