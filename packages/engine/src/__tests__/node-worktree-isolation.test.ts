/*
FNXC:NodeWorktreeIsolation 2026-09-03-05:40:
Code Review always inspects the task-specific checkout even when its session is read-only. Plan Review
retains its deliberate pre-execution read-only-root boundary because it runs before checkout ownership;
write capability and checkout need are separate policies.
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
const CODE_REVIEW_NODE = {
  id: "code-review-step",
  kind: "prompt",
  config: { name: "Code Review", prompt: "Review the implementation.", toolMode: "readonly", reviewKind: "code" },
};

describe("every workflow node runs in the task worktree, never the shared checkout", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("" as any);
  });

  it("acquires a task worktree for read-only Code Review when the task has none", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    mockedExistsSync.mockReturnValue(false);

    const acquired = makeTask({ worktree: `${ROOT}/.worktrees/fn-1403`, branch: "fusion/fn-1403" });
    const acquireSpy = vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree").mockResolvedValue(acquired);
    vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "APPROVE" });

    const live = makeTask();
    store.getTask.mockResolvedValue(live as any);
    await (executor as any).runGraphCustomNode(CODE_REVIEW_NODE, live, {}, undefined);

    expect(acquireSpy).toHaveBeenCalledOnce();
    expect(acquireSpy).toHaveBeenCalledWith(expect.objectContaining({ id: live.id }), expect.anything(), CODE_REVIEW_NODE.id);
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

  it("keeps workspace Plan Review on its declared read-only root boundary", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).workspaceConfig = { repos: ["apps/web"] };
    mockedExistsSync.mockReturnValue(true);

    const acquiredPath = `${ROOT}/.fusion/worktrees/fn-1403/apps/web`;
    const acquiredTask = makeTask({
      workspaceWorktrees: { "apps/web": { worktreePath: acquiredPath, branch: "fusion/fn-1403-apps-web" } },
    });
    const acquireSpy = vi.spyOn(executor as any, "ensureGraphCustomNodeWorktree").mockResolvedValue(acquiredTask);
    const captured: { worktreePath?: string; boundary?: unknown } = {};
    vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
      captured.worktreePath = args[2];
      captured.boundary = args[5]?.sessionBoundary;
      return { success: true, output: "APPROVE" };
    });

    const live = makeTask();
    store.getTask.mockResolvedValueOnce(live as any).mockResolvedValueOnce(live as any).mockResolvedValue(acquiredTask as any);
    await (executor as any).runGraphCustomNode(PLAN_REVIEW_NODE, live, {}, undefined);

    expect(captured.worktreePath).toBe(ROOT);
    expect(captured.boundary).toMatchObject({ kind: "read-only-root", writableRoot: null, projectRoot: ROOT });
    expect(acquireSpy).not.toHaveBeenCalled();
  });
});
