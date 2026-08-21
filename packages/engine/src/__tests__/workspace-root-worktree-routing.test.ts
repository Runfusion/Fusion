/*
FNXC:WorkspaceRootRouting 2026-08-19-12:15:
The production workspace acquisition seam is exercised against the real two-repository fixture so a
regression cannot silently replace declared repository worktrees with a root checkout. The fixture's
workspace root is intentionally non-Git; only repo-local `.worktrees` paths may be acquired.
*/
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import {
  acquireWorkspaceTaskWorktrees,
  type AcquireWorkspaceTaskWorktreesOptions,
} from "../worktree/worktree-acquisition.js";
import { ActiveSessionRegistry } from "../agents/active-session-registry.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

function makeFakeStore(task: Task): { store: TaskStore; current: () => Task } {
  let current = task;
  const store = {
    async updateTask(id: string, patch: Partial<Task>): Promise<void> {
      if (id === current.id) current = { ...current, ...patch };
    },
    async mergeWorkspaceWorktreeEntry(
      id: string,
      repoRelPath: string,
      patch: Partial<NonNullable<Task["workspaceWorktrees"]>[string]>
        | ((freshTask: Task) => Promise<Partial<NonNullable<Task["workspaceWorktrees"]>[string]>>),
      options?: {
        requireExistingEntry?: boolean;
        clearSingularWorktree?: boolean;
        validateBeforePersist?: (freshTask: Task) => Promise<void>;
      },
    ): Promise<Task> {
      if (id !== current.id) throw new Error(`Task ${id} not found`);
      const existing = current.workspaceWorktrees?.[repoRelPath];
      if (options?.requireExistingEntry && !existing) {
        throw new Error(`Workspace worktree entry ${repoRelPath} does not exist`);
      }
      const resolvedPatch = typeof patch === "function" ? await patch(current) : patch;
      await options?.validateBeforePersist?.(current);
      current = {
        ...current,
        workspaceWorktrees: {
          ...(current.workspaceWorktrees ?? {}),
          [repoRelPath]: { ...existing, ...resolvedPatch },
        },
        ...(options?.clearSingularWorktree ? { worktree: undefined, branch: undefined } : {}),
      };
      return current;
    },
    async logEntry(): Promise<void> {},
    async getTask(id: string): Promise<Task> {
      if (id !== current.id) throw new Error(`Task ${id} not found`);
      return current;
    },
  } as unknown as TaskStore;
  return { store, current: () => current };
}

function makeTask(id: string): Task {
  return {
    id,
    title: "workspace routing",
    description: "workspace routing",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implementation", status: "done" }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

const settings: Partial<Settings> = {
  worktreeNaming: "task-id",
  commitMsgHookEnabled: true,
  taskPrefix: "FN",
  taskAttributionTrailerNames: ["Fusion-Task-Id"],
};

describeIfGit("FN-034 workspace root worktree routing", { timeout: 60_000 }, () => {
  let fixture: WorkspaceFixture | undefined;

  afterEach(() => fixture?.cleanup());

  it("acquires only declared repository worktrees and returns a real coordinator cwd", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const { store, current } = makeFakeStore(makeTask("FN-034"));
    const activePaths: string[] = [];
    const options: AcquireWorkspaceTaskWorktreesOptions = {
      workspaceConfig: { repos: fixture.repos },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings,
      registry: new ActiveSessionRegistry(),
      addActiveWorktree: (_taskId, path) => activePaths.push(path),
    };

    const result = await acquireWorkspaceTaskWorktrees(options);
    const entries = result.task.workspaceWorktrees ?? {};

    expect(result.coordinatorWorktreePath).toBe(entries["repo-a"]?.worktreePath);
    expect(Object.keys(entries).sort()).toEqual(["repo-a", "repo-b"]);
    expect(entries["repo-a"]?.worktreePath).toContain(join("repo-a", ".worktrees"));
    expect(entries["repo-b"]?.worktreePath).toContain(join("repo-b", ".worktrees"));
    expect(activePaths.sort()).toEqual([
      entries["repo-a"]?.worktreePath,
      entries["repo-b"]?.worktreePath,
    ].sort());
    expect(existsSync(join(fixture.rootDir, ".worktrees", "FN-034"))).toBe(false);
  });

  it("uses a current-scope later review target instead of the default coordinator", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const task = makeTask("FN-106");
    task.repositoryScope = {
      state: "confirmed",
      revision: 7,
      repositories: ["repo-a", "repo-b"],
      reviewRemediation: { scopeRevision: 7, repository: "repo-b", inputSignature: "node\\0repo-b" },
    };
    const { store, current } = makeFakeStore(task);
    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: fixture.repos },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings,
      registry: new ActiveSessionRegistry(),
      remediationRepository: "repo-b",
    });

    expect(result.coordinatorWorktreePath).toBe(result.task.workspaceWorktrees?.["repo-b"]?.worktreePath);
    expect(result.coordinatorWorktreePath).not.toContain(join(fixture.rootDir, ".worktrees"));
    expect(result.task.worktree).toBeUndefined();
  });

  it("rejects a stale review target instead of falling back to another repository", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const task = makeTask("FN-107");
    task.repositoryScope = {
      state: "confirmed",
      revision: 8,
      repositories: ["repo-a", "repo-b"],
      reviewRemediation: { scopeRevision: 7, repository: "repo-b", inputSignature: "stale" },
    };
    const { store, current } = makeFakeStore(task);

    await expect(acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: fixture.repos },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings,
      registry: new ActiveSessionRegistry(),
      remediationRepository: "repo-b",
    })).rejects.toThrow("remediation target is stale");
  });
});
