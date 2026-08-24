/*
FNXC:NodeWorktreeIsolation 2026-07-25-22:10 (no lane runs in the shared checkout — regression):
Operator requirement: Plan Review, Code Review, and every other node run in the TASK-SPECIFIC worktree;
the shared main checkout is for merge only. Before this, read-only graph gates fell back to
`this.rootDir` because a pre-execution task has no worktree yet. That is what let two tasks share one
path (the reported FN-1398/FN-1403 Plan Review session collision) and what let reviewers read a checkout
that other tasks and the operator mutate underneath them.

Invariant under test across the node surfaces that previously degraded to the root:
 - Plan Review (no worktree yet) acquires and runs in a task worktree;
 - a custom read-only gate (no worktree yet) does the same — this is not Plan-Review-special;
 - an existing usable worktree is REUSED, not re-acquired;
 - the acquisition is skipped for workspace projects, whose sessions are browse-root-rooted by design.
*/
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedExecSync,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const ROOT = "/tmp/test";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const now = new Date().toISOString();
  return {
    id: "FN-1403",
    title: "Isolation",
    description: "Desc",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    worktree: undefined,
    branch: undefined,
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

const PLAN_REVIEW_NODE = {
  id: "plan-review-step",
  kind: "prompt",
  config: { name: "Plan Review", prompt: "Review the plan.", toolMode: "readonly", reviewKind: "plan" },
};
const CUSTOM_READONLY_GATE = {
  id: "custom-gate",
  kind: "prompt",
  config: { name: "Custom Gate", prompt: "Check something.", toolMode: "readonly" },
};

describe("every workflow node runs in the task worktree, never the shared checkout", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("" as any);
  });

  it.each([
    ["Plan Review", PLAN_REVIEW_NODE],
    ["a custom read-only gate", CUSTOM_READONLY_GATE],
  ])("acquires a task worktree for %s when the task has none", async (_label, node) => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    mockedExistsSync.mockReturnValue(true);

    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask();
    store.getTask.mockResolvedValue(live as any);
    await (executor as any).runGraphCustomNode(node, live, { reviewerInlineFixes: false }, undefined);

    expect(captured.worktreePath).not.toBe(ROOT);
    expect(captured.worktreePath).toContain(`${ROOT}/.worktrees/`);
  });

  it("reuses an existing usable worktree instead of acquiring another", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    const existing = `${ROOT}/.worktrees/existing`;
    mockedExistsSync.mockReturnValue(true);

    const acquireSpy = vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree");
    const captured: { worktreePath?: string } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask({ worktree: existing, branch: "fusion/fn-1403" });
    store.getTask.mockResolvedValue(live as any);
    await (executor as any).runGraphCustomNode(PLAN_REVIEW_NODE, live, {}, undefined);

    expect(captured.worktreePath).toBe(existing);
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it("uses a declared read-only workspace root for workspace Plan Review", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).workspaceConfig = { repos: ["apps/web"] };
    mockedExistsSync.mockReturnValue(true);

    const acquireSpy = vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree");
    const captured: { worktreePath?: string; boundary?: unknown } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      captured.boundary = args[5]?.sessionBoundary;
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask();
    store.getTask.mockResolvedValue(live as any);
    await (executor as any).runGraphCustomNode(PLAN_REVIEW_NODE, live, {}, undefined);

    expect(captured.worktreePath).toBe(ROOT);
    expect(captured.boundary).toMatchObject({ kind: "read-only-root", writableRoot: null, projectRoot: ROOT });
    expect(acquireSpy).not.toHaveBeenCalled();
  });
});
