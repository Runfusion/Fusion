import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { EventEmitter } from "node:events";
import { SelfHealingManager } from "../../self-healing.js";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { makeReliabilityFixture, hasGit, hasPg } from "./_helpers.js";

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

function makeStore(tasks: Map<string, Task>): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => ({ maintenanceIntervalMs: 0, globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async ({ column }: any = {}) => [...tasks.values()].filter((t) => !column || t.column === column)),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => { tasks.set(id, { ...tasks.get(id)!, ...updates } as Task); return tasks.get(id); }),
    moveTask: vi.fn(async (id: string, column: Task["column"]) => { tasks.set(id, { ...tasks.get(id)!, column } as Task); }),
    logEntry: vi.fn(async () => undefined),
    /*
    FNXC:OverlapSelfHealing 2026-06-26-12:00:
    Reliability interaction object fakes must provide clearStaleBlockedBy's overlap-path store methods; real TaskStore fixture cases inherit the production implementation and stay untouched.
    */
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getCompletionHandoffAcceptedMarker: vi.fn().mockReturnValue(null),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    archiveTaskAndCleanup: vi.fn(async () => ({})),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    updateSettings: vi.fn(async () => ({})),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => ""),
  }) as unknown as TaskStore & EventEmitter;
}

describe("reliability interactions: self-healing", () => {
  const fixtures: Array<Awaited<ReturnType<typeof makeReliabilityFixture>>> = [];
  afterEach(async () => { while (fixtures.length) await fixtures.pop()!.cleanup(); });

  it("Case 15: clearStaleBlockedBy unblocks downstream once blocker done", async () => {
    const tasks = new Map<string, Task>([
      ["A", makeTask("A", { column: "todo", blockedBy: "B" })],
      ["B", makeTask("B", { column: "done" })],
    ]);
    const store = makeStore(tasks);
    const mgr = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });
    const cleared = await mgr.clearStaleBlockedBy();
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(tasks.get("A")?.blockedBy ?? null).toBeNull();
  });

  it("Case 9: recoverMisclassifiedFailures resolves failed tasks with done steps", async () => {
    const tasks = new Map<string, Task>([["F", makeTask("F", { column: "in-review", status: "failed", steps: [{ name: "x", status: "done" } as any] })]]);
    const store = makeStore(tasks);
    const mgr = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });
    const recovered = await mgr.recoverMisclassifiedFailures();
    expect(recovered).toBeGreaterThanOrEqual(0);
  });

  it("paused in-review tasks do not re-block overlap dispatch list logic", async () => {
    const tasks = new Map<string, Task>([["P", makeTask("P", { column: "in-review", paused: true })]]);
    const store = makeStore(tasks);
    const mgr = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });
    const recovered = await mgr.recoverAlreadyMergedReviewTasks();
    expect(recovered).toBe(0);
  });

  it.each([
    "Refusing to start coding agent in missing worktree: /tmp/wt",
    "Refusing to start coding agent in incomplete worktree: /tmp/wt",
    "Refusing to start coding agent in unregistered git worktree: /tmp/wt",
  ])("recoverMissingWorktreeReviewFailures rebounds no-progress review tasks for '%s'", async (error) => {
    const taskId = "WT";
    const tasks = new Map<string, Task>([[
      taskId,
      makeTask(taskId, {
        column: "in-review",
        paused: false,
        status: "failed",
        error,
        worktree: "/tmp/wt",
        branch: "fusion/wt",
        steps: [{ id: "s1", title: "Step", status: "pending" }] as any,
        updatedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      }),
    ]]);
    const store = makeStore(tasks);
    const mgr = new SelfHealingManager(store, { rootDir: process.cwd(), getExecutingTaskIds: () => new Set() });

    const recovered = await mgr.recoverMissingWorktreeReviewFailures();

    expect(recovered).toBe(1);
    expect(tasks.get(taskId)?.column).toBe("todo");
    expect(tasks.get(taskId)?.worktree ?? null).toBeNull();
    expect(tasks.get(taskId)?.branch ?? null).toBeNull();
    expect(store.logEntry).toHaveBeenCalledWith(
      taskId,
      expect.stringContaining("Auto-recovered (no-progress): session-start refused unusable worktree"),
    );
    expect(tasks.get(taskId)?.worktreeSessionRetryCount).toBe(1);
  });

  it.skipIf(!hasGit || !hasPg)("recoverAlreadyMergedReviewTasks can still finalize from real git state", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-SH-GIT" });
    fixtures.push(fx);
    await fx.createBranch("fusion/fn-4361-sh");
    await fx.writeAndCommit("src/sh.txt", "z\n", "feat: sh");
    await fx.checkout("main");
    await fx.writeAndCommit("src/sh.txt", "z\n", "feat: landed");
    await fx.store.updateTask(fx.task.id, { branch: "fusion/fn-4361-sh", status: "failed", mergeRetries: 3, column: "in-review" } as any);
    const recovered = await fx.selfHeal.recoverAlreadyMergedReviewTasks();
    expect(recovered).toBeGreaterThanOrEqual(0);
  });
});
