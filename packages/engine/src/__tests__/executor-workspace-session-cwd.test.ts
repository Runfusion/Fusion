/*
FNXC:Workspace 2026-06-21-12:00:
U1 session-cwd scenarios that require driving the real TaskExecutor.execute() to the agent-session boundary. Uses the shared executor-test-helpers harness — it mocks the AI/session/git/fs seams (NOT the workspace gating, NOT acquireTaskWorktree), so setting `(executor as any).workspaceConfig` exercises the genuine KTD1 gate: root acquisition is skipped, and every agent session (initial + retry) is created with `cwd === rootDir` (browse-only workspace root). The non-workspace path is the regression control (cwd === the acquired worktree path).
*/
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { acquireTaskWorktree, acquireWorkspaceTaskWorktrees } from "../worktree/worktree-acquisition.js";
import type { WorkspaceConfig } from "@fusion/core";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

vi.mock("../worktree/worktree-acquisition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree/worktree-acquisition.js")>();
  return {
    ...actual,
    acquireTaskWorktree: vi.fn(actual.acquireTaskWorktree),
    acquireWorkspaceTaskWorktrees: vi.fn(actual.acquireWorkspaceTaskWorktrees),
  };
});

const mockedAcquireTaskWorktree = vi.mocked(acquireTaskWorktree);
const mockedAcquireWorkspaceTaskWorktrees = vi.mocked(acquireWorkspaceTaskWorktrees);

const ROOT = "/tmp/workspace-root";

function inProgressTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-001",
    title: "Test",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

describe("FN-158 — workspace sessions use one task directory", () => {
  beforeEach(() => {
    resetExecutorMocks();
    // Make any accidental git invocation observable: empty stdout keeps real-git
    // helpers from throwing, but acquireTaskWorktree assertions catch a leak.
    mockedExecSync.mockReturnValue("");
  });
  afterEach(() => vi.restoreAllMocks());

  it("skips root acquireTaskWorktree and creates every session in the task directory", async () => {
    const store = createMockStore();
    const scopedTask = inProgressTask({
      worktree: null,
      repositoryScope: { state: "confirmed", revision: 1, repositories: ["repo-a", "repo-b"] },
    });
    (store.getTask as any).mockResolvedValue(scopedTask);
    mockedAcquireWorkspaceTaskWorktrees.mockResolvedValue({
      task: inProgressTask({
        repositoryScope: { state: "confirmed", revision: 1, repositories: ["repo-a", "repo-b"] },
        workspaceWorktrees: {
          "repo-a": { worktreePath: "/tmp/workspace-root/.fusion/worktrees/fn-001/repo-a", branch: "fusion/fn-001" },
          "repo-b": { worktreePath: "/tmp/workspace-root/.fusion/worktrees/fn-001/repo-b", branch: "fusion/fn-001" },
        },
      }),
      taskWorktreeDir: "/tmp/workspace-root/.fusion/worktrees/fn-001",
    });
    const mockPrompt = vi.fn().mockResolvedValue(undefined); // no fn_task_done → drives retries too
    mockedCreateFnAgent.mockResolvedValue({
      session: { prompt: mockPrompt, dispose: vi.fn() },
      sessionFile: "/tmp/sessions/ws.jsonl",
    } as any);

    const executor = new TaskExecutor(store, ROOT);
    // Drive the genuine workspace gate (loadWorkspaceConfig is covered elsewhere).
    (executor as any).workspaceConfig = { repos: ["repo-a", "repo-b"] } as WorkspaceConfig;

    await executor.execute(scopedTask);

    // The workspace root is never acquired as a task worktree.
    expect(mockedAcquireTaskWorktree).not.toHaveBeenCalled();
    expect(mockedAcquireWorkspaceTaskWorktrees).toHaveBeenCalled();

    // The execution session is rooted at the task directory containing every repository.
    const taskDirectory = "/tmp/workspace-root/.fusion/worktrees/fn-001";
    expect(mockedCreateFnAgent.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockedCreateFnAgent.mock.calls) {
      expect((call[0] as any).cwd).toBe(taskDirectory);
      expect((call[0] as any).cwd).not.toBe(ROOT);
      expect((call[0] as any).sessionBoundary).toMatchObject({
        kind: "workspace-task-dir",
        writableRoot: taskDirectory,
        projectRoot: ROOT,
      });
    }

    // task.worktree is never set in workspace mode.
    const worktreeWrites = (store.updateTask as any).mock.calls.filter(
      (c: any[]) => c[1] && Object.prototype.hasOwnProperty.call(c[1], "worktree") && c[1].worktree,
    );
    expect(worktreeWrites).toHaveLength(0);
  });

  it("passes a current-scope later repository REVISE to normal executor acquisition", async () => {
    const store = createMockStore();
    mockedAcquireWorkspaceTaskWorktrees.mockResolvedValue({
      task: inProgressTask({
        workspaceWorktrees: {
          "repo-a": { worktreePath: "/tmp/workspace-root/.fusion/worktrees/fn-001/repo-a", branch: "fusion/fn-001" },
          "repo-b": { worktreePath: "/tmp/workspace-root/.fusion/worktrees/fn-001/repo-b", branch: "fusion/fn-001" },
        },
      }),
      taskWorktreeDir: "/tmp/workspace-root/.fusion/worktrees/fn-001",
    });
    mockedCreateFnAgent.mockResolvedValue({
      session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
      sessionFile: "/tmp/sessions/ws-remediation.jsonl",
    } as any);
    const task = inProgressTask({
      repositoryScope: {
        state: "confirmed",
        revision: 4,
        repositories: ["repo-a", "repo-b"],
        reviewRemediation: { scopeRevision: 4, repository: "repo-b", inputSignature: "review" },
      },
    });
    (store.getTask as any).mockResolvedValue(task);
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).workspaceConfig = { repos: ["repo-a", "repo-b"] } as WorkspaceConfig;

    await executor.execute(task);

    expect(mockedAcquireWorkspaceTaskWorktrees).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRootDir: ROOT,
    }));
    expect(mockedCreateFnAgent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      cwd: "/tmp/workspace-root/.fusion/worktrees/fn-001",
    }));
  });
});

describe("U1 regression — non-workspace task acquires a worktree and roots the session there", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockReturnValue("");
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls acquireTaskWorktree and creates the session with cwd === the acquired worktree path", async () => {
    const store = createMockStore();
    const ACQUIRED = "/tmp/test/.worktrees/swift-falcon";
    mockedAcquireTaskWorktree.mockResolvedValue({
      worktreePath: ACQUIRED,
      branch: "fusion/fn-001",
      source: "fresh",
      hydrated: false,
      isResume: false,
    });

    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    mockedCreateFnAgent.mockResolvedValue({
      session: { prompt: mockPrompt, dispose: vi.fn() },
      sessionFile: "/tmp/sessions/ns.jsonl",
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    // No workspaceConfig → single-repo path. Pin the lazy-load guard so the real
    // loader is never consulted (it would return null for /tmp/test anyway).
    (executor as any).workspaceConfig = null;

    await executor.execute(inProgressTask({ worktree: null }));

    expect(mockedAcquireTaskWorktree).toHaveBeenCalledTimes(1);
    expect(mockedCreateFnAgent.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of mockedCreateFnAgent.mock.calls) {
      expect((call[0] as any).cwd).toBe(ACQUIRED);
    }
  });
});
