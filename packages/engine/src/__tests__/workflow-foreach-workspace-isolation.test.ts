import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskStore } from "@fusion/core";

import { TaskExecutor } from "../executor.js";
import { WORKSPACE_ISOLATION_UNSUPPORTED_MESSAGE } from "../executor/build-foreach-worktree-deps.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

/**
 * FNXC:Workspace 2026-08-15-04:22:
 * Workspace roots are intentionally non-git directories. These tests use real sub-repos to prove the isolation gate rejects before allocation can issue git operations against that root.
 */
describeIfGit("foreach workspace worktree-isolation gate", () => {
  let fixture: WorkspaceFixture | undefined;

  afterEach(() => fixture?.cleanup());

  function executorFor(task: Record<string, unknown>, rootDir: string) {
    const store = Object.assign(new EventEmitter(), {
      getTask: vi.fn().mockResolvedValue(task),
    }) as unknown as TaskStore;
    const executor = new TaskExecutor(store, rootDir, {}) as any;
    executor.createWorktree = vi.fn(async (branch: string, path: string) => ({ path, branch }));
    return { executor, deps: executor.buildForeachWorktreeDeps(task) };
  }

  it("rejects a populated workspace task before createWorktree allocation", async () => {
    fixture = await createWorkspaceFixture();
    const task = {
      id: "FN-WS",
      worktree: null,
      branch: null,
      workspaceWorktrees: {
        "repo-a": { worktreePath: fixture.repoPath("repo-a"), branch: "fusion/FN-WS" },
      },
    };
    const { executor, deps } = executorFor(task, fixture.rootDir);

    await expect(deps.allocateInstanceWorktree(0, undefined)).rejects.toThrow(WORKSPACE_ISOLATION_UNSUPPORTED_MESSAGE);
    expect(executor.createWorktree).not.toHaveBeenCalled();
  });

  it("blocks before workspace sub-repo acquisition using project configuration", async () => {
    fixture = await createWorkspaceFixture();
    const { deps } = executorFor({
      id: "FN-WS-PRE",
      worktree: null,
      branch: null,
      workspaceWorktrees: {},
    }, fixture.rootDir);

    await expect(deps.resolveWorktreeIsolationBlock()).resolves.toContain(WORKSPACE_ISOLATION_UNSUPPORTED_MESSAGE);
  });

  it("leaves single-repo allocation unchanged", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const task = {
      id: "FN-SINGLE",
      worktree: fixture.repoPath("repo-a"),
      branch: "main",
      workspaceWorktrees: undefined,
    };
    // The repo itself has no workspace.json, so the config probe is inert.
    const { executor, deps } = executorFor(task, fixture.repoPath("repo-a"));

    await expect(deps.resolveWorktreeIsolationBlock()).resolves.toBeUndefined();
    await deps.allocateInstanceWorktree(0, undefined);
    expect(executor.createWorktree).toHaveBeenCalledTimes(1);
  });
});
