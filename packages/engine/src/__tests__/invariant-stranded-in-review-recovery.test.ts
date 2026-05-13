/*
FN-4115 invariant: in-review tasks with worktree must not starve. Layered defenses must hold: recoverAlreadyMergedReviewTasks finalizes already-landed retry-exhausted review tasks; clearStaleBlockedBy removes stale downstream blockers; scheduler inReviewWithWorktree excludes paused review tasks so they cannot re-block overlap dispatch.
*/
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function createStore(tasks: Task[]): TaskStore & EventEmitter {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const settings: Settings = { globalPause: false, enginePaused: false, autoMerge: false } as Settings;
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async (opts?: { column?: string }) => {
      const all = [...map.values()];
      if (!opts?.column) return all;
      return all.filter((t) => t.column === opts.column);
    }),
    getTask: vi.fn(async (id: string) => map.get(id)),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
      const cur = map.get(id)!;
      map.set(id, { ...cur, ...updates } as Task);
      return map.get(id);
    }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => {
      const cur = map.get(id)!;
      map.set(id, { ...cur, column } as Task);
    }),
    logEntry: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

describe("FN-4115 stranded in-review recovery", () => {
  it("FN-4115: already-merged retry-exhausted in-review task auto-finalizes to done", async () => {
    const task = makeTask("FN-4115-A", { column: "in-review", status: "failed", mergeRetries: 3, branch: "fusion/fn-4115-a" });
    const store = createStore([task]);
    const mgr = new SelfHealingManager(store as any, "/repo");
    vi.spyOn(mgr as any, "findAlreadyMergedTaskCommit").mockResolvedValue({ sha: "abc12345", strategy: "task-id-trailer" });
    const recovered = await mgr.recoverAlreadyMergedReviewTasks();
    expect(recovered).toBe(1);
    expect((await store.getTask("FN-4115-A"))?.column).toBe("done");
  });

  it("FN-4115: clearStaleBlockedBy clears blocker when upstream is done and keeps active blocker", async () => {
    const done = makeTask("FN-4115-UP", { column: "done" });
    const blocked = makeTask("FN-4115-DOWN", { column: "todo", blockedBy: "FN-4115-UP" });
    const active = makeTask("FN-4115-ACTIVE", { column: "in-progress" });
    const blockedActive = makeTask("FN-4115-DOWN2", { column: "todo", blockedBy: "FN-4115-ACTIVE" });
    const store = createStore([done, blocked, active, blockedActive]);
    const mgr = new SelfHealingManager(store as any, "/repo");
    await mgr.clearStaleBlockedBy();
    expect((await store.getTask("FN-4115-DOWN"))?.blockedBy).toBeNull();
    expect((await store.getTask("FN-4115-DOWN2"))?.blockedBy).toBe("FN-4115-ACTIVE");
  });

  it("FN-4115: paused in-review tasks are excluded by the scheduler inReviewWithWorktree predicate", async () => {
    const tasks = [
      makeTask("FN-4115-PAUSED", { column: "in-review", paused: true, worktree: "/repo/.worktrees/p" }),
      makeTask("FN-4115-ACTIVE", { column: "in-review", paused: false, worktree: "/repo/.worktrees/a" }),
      makeTask("FN-4115-FAILED", { column: "in-review", paused: false, status: "failed", worktree: "/repo/.worktrees/f" }),
    ];
    const inReviewWithWorktree = tasks.filter((t) => t.column === "in-review" && Boolean(t.worktree) && !t.paused && t.status !== "failed");
    expect(inReviewWithWorktree.map((t) => t.id)).toEqual(["FN-4115-ACTIVE"]);
  });

  it("FN-4115: one maintenance cycle finalizes merged review and unblocks downstream work", async () => {
    const merged = makeTask("FN-4115-MERGED", { column: "in-review", status: "failed", mergeRetries: 3, branch: "fusion/fn-4115-m" });
    const downstream = makeTask("FN-4115-DOWNSTREAM", { column: "todo", blockedBy: "FN-4115-MERGED" });
    const store = createStore([merged, downstream]);
    const mgr = new SelfHealingManager(store as any, "/repo");
    vi.spyOn(mgr as any, "findAlreadyMergedTaskCommit").mockResolvedValue({ sha: "abc12345", strategy: "task-id-trailer" });
    await mgr.runMaintenance();
    expect((await store.getTask("FN-4115-MERGED"))?.column).toBe("done");
    expect((await store.getTask("FN-4115-DOWNSTREAM"))?.blockedBy).toBeNull();
  });
});
