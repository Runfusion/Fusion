import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import * as worktreePool from "../../worktree/worktree-pool.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import { PrCommentHandler } from "../../merge/pr-comment-handler.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4992",
    title: "t",
    description: "d",
    column: "in-review",
    branch: "fusion/fn-4992",
    worktree: "/tmp/test/.worktrees/fn-4992",
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function store(t: Task): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = { globalPause: false, enginePaused: false } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async (id: string) => (id === t.id ? t : null)),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(t, updates)),
    addTaskComment: vi.fn(async () => undefined),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      t.column = column;
      return t;
    }),
    logEntry: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

describe("reliability interaction (FN-4766): PR changes-requested re-execution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    activeSessionRegistry.clear();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  it.each([
    { column: "in-review" as const, shouldMove: true },
    { column: "in-progress" as const, shouldMove: false },
  ])("enforces in-review precondition for re-execution move: $column", async ({ column, shouldMove }) => {
    const t = task({ column });
    const s = store(t);
    const handler = new PrCommentHandler(s as any);

    await handler.handleChangesRequested(
      t.id,
      { url: "https://github.com/o/r/pull/1", number: 1, status: "open", title: "pr", headBranch: "h", baseBranch: "main", commentCount: 0 },
      "reviewer",
      "please fix X",
    );

    expect((s as any).moveTask).toHaveBeenCalledTimes(shouldMove ? 1 : 0);
    expect((s as any).logEntry).toHaveBeenCalledTimes(shouldMove ? 1 : 0);
  });

  it("preserves task branch/worktree metadata and paused state while moving engine-sourced to in-progress", async () => {
    const t = task({ column: "in-review", paused: true });
    const s = store(t);
    const handler = new PrCommentHandler(s as any);

    await handler.handleChangesRequested(
      t.id,
      { url: "https://github.com/o/r/pull/2", number: 2, status: "open", title: "pr", headBranch: "h", baseBranch: "main", commentCount: 0 },
      "reviewer",
      "please fix Y",
    );

    expect((s as any).moveTask).toHaveBeenCalledWith(t.id, "in-progress");
    expect((s as any).moveTask.mock.calls[0].length).toBe(2);
    expect(t.branch).toBe("fusion/fn-4992");
    expect(t.worktree).toBe("/tmp/test/.worktrees/fn-4992");
    expect(t.paused).toBe(true);
  });

  it("materializes feedback in ordered write sequence comment -> review item -> move -> log", async () => {
    const t = task();
    const s = store(t);
    const handler = new PrCommentHandler(s as any);

    await handler.handleChangesRequested(
      t.id,
      { url: "https://github.com/o/r/pull/3", number: 3, status: "open", title: "pr", headBranch: "h", baseBranch: "main", commentCount: 0 },
      "reviewer",
      "please fix Z",
    );

    expect((s as any).addTaskComment).toHaveBeenCalledTimes(1);
    expect((s as any).updateTask).toHaveBeenCalledTimes(1);
    expect((s as any).moveTask).toHaveBeenCalledTimes(1);
    expect((s as any).logEntry).toHaveBeenCalledTimes(1);

    const commentOrder = (s as any).addTaskComment.mock.invocationCallOrder[0];
    const reviewOrder = (s as any).updateTask.mock.invocationCallOrder[0];
    const moveOrder = (s as any).moveTask.mock.invocationCallOrder[0];
    const logOrder = (s as any).logEntry.mock.invocationCallOrder[0];

    expect(commentOrder).toBeLessThan(reviewOrder);
    expect(reviewOrder).toBeLessThan(moveOrder);
    expect(moveOrder).toBeLessThan(logOrder);
  });

  it("swallows moveTask failures as best-effort", async () => {
    const t = task();
    const s = store(t);
    (s as any).moveTask = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const handler = new PrCommentHandler(s as any);

    await expect(
      handler.handleChangesRequested(
        t.id,
        { url: "https://github.com/o/r/pull/4", number: 4, status: "open", title: "pr", headBranch: "h", baseBranch: "main", commentCount: 0 },
        "reviewer",
        "please fix boom",
      ),
    ).resolves.toBeUndefined();
  });
});
