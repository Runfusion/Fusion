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
  /*
  FNXC:WorkspaceRootRouting 2026-08-21-08:34:
  This focused routing fake mirrors TaskStore's per-task merge lock and post-callback authoritative
  re-read so callback-based acquisitions cannot clobber sibling entries or external task updates.
  */
  let workspaceMergeTail = Promise.resolve();
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
      const operation = workspaceMergeTail.then(async () => {
        if (id !== current.id) throw new Error(`Task ${id} not found`);
        const existing = current.workspaceWorktrees?.[repoRelPath];
        if (options?.requireExistingEntry && !existing) return current;
        const callbackTask = current;
        const resolvedPatch = typeof patch === "function" ? await patch(callbackTask) : patch;
        const freshExisting = current.workspaceWorktrees?.[repoRelPath];
        if (options?.requireExistingEntry && !freshExisting) return current;
        await options?.validateBeforePersist?.(current);
        current = {
          ...current,
          workspaceWorktrees: {
            ...(current.workspaceWorktrees ?? {}),
            [repoRelPath]: {
              ...freshExisting,
              ...resolvedPatch,
            } as NonNullable<Task["workspaceWorktrees"]>[string],
          },
          ...(options?.clearSingularWorktree
            ? {
                worktree: null,
                branch: null,
                branchWriteOrigin: "engine" as const,
                executionStartBranch: null,
                baseCommitSha: null,
              }
            : {}),
        };
        return current;
      });
      workspaceMergeTail = operation.then(() => undefined, () => undefined);
      return operation;
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

describe("workspace root routing store fake", () => {
  /*
  FNXC:WorkspaceRootRouting 2026-08-21-08:34:
  The focused routing fake must hold the same concurrent-merge invariant as the shared executor fake;
  exercising both surfaces prevents one fixture from silently reverting to stale snapshot writes.

  FNXC:WorkspaceRootRouting 2026-08-21-16:42:
  Clearing singular routing metadata must return null on this focused fake, matching persisted TaskStore
  reads and the shared executor fake instead of exposing fixture-only undefined values.
  */
  it("serializes callback merges without dropping sibling repository entries", async () => {
    const task = makeTask("FN-routing-merge");
    Object.assign(task, {
      worktree: "/tmp/singular",
      branch: "fusion/singular",
      executionStartBranch: "main",
      baseCommitSha: "base",
    });
    const { store, current } = makeFakeStore(task);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

    const first = store.mergeWorkspaceWorktreeEntry(
      "FN-routing-merge",
      "repo-a",
      async () => {
        markFirstStarted();
        await firstGate;
        return { worktreePath: "/tmp/repo-a", branch: "fusion/a" };
      },
    );
    await firstStarted;
    await store.updateTask("FN-routing-merge", {
      workspaceWorktrees: {
        "repo-c": { worktreePath: "/tmp/repo-c", branch: "fusion/c" },
      },
    });

    let secondStarted = false;
    const second = store.mergeWorkspaceWorktreeEntry(
      "FN-routing-merge",
      "repo-b",
      async (freshTask) => {
        secondStarted = true;
        expect(freshTask.workspaceWorktrees?.["repo-a"]?.worktreePath).toBe("/tmp/repo-a");
        return { worktreePath: "/tmp/repo-b", branch: "fusion/b" };
      },
      { clearSingularWorktree: true },
    );

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(Object.keys(current().workspaceWorktrees ?? {}).sort()).toEqual(["repo-a", "repo-b", "repo-c"]);
    expect(current()).toEqual(expect.objectContaining({
      worktree: null,
      branch: null,
      branchWriteOrigin: "engine",
      executionStartBranch: null,
      baseCommitSha: null,
    }));
  });
});

const settings: Partial<Settings> = {
  commitMsgHookEnabled: true,
  taskPrefix: "FN",
  taskAttributionTrailerNames: ["Fusion-Task-Id"],
};

describeIfGit("FN-034 workspace root worktree routing", { timeout: 60_000 }, () => {
  let fixture: WorkspaceFixture | undefined;

  afterEach(() => fixture?.cleanup());

  it("acquires declared repository worktrees beneath one task directory", async () => {
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

    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "fn-034"));
    expect(Object.keys(entries).sort()).toEqual(["repo-a", "repo-b"]);
    expect(entries["repo-a"]?.worktreePath).toBe(join(result.taskWorktreeDir, "repo-a"));
    expect(entries["repo-b"]?.worktreePath).toBe(join(result.taskWorktreeDir, "repo-b"));
    expect(activePaths.sort()).toEqual([
      entries["repo-a"]?.worktreePath,
      entries["repo-b"]?.worktreePath,
    ].sort());
    expect(existsSync(result.taskWorktreeDir)).toBe(true);
  });

  it("does not let a current-scope review target choose the task session root", async () => {
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
    });

    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "fn-106"));
    expect(result.taskWorktreeDir).not.toBe(result.task.workspaceWorktrees?.["repo-b"]?.worktreePath);
    expect(result.task.worktree).toBeNull();
  });

  it("acquires configured repositories even when legacy remediation metadata is stale", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const task = makeTask("FN-107");
    task.repositoryScope = {
      state: "confirmed",
      revision: 8,
      repositories: ["repo-a", "repo-b"],
      reviewRemediation: { scopeRevision: 7, repository: "repo-b", inputSignature: "stale" },
    };
    const { store, current } = makeFakeStore(task);

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: fixture.repos },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings,
      registry: new ActiveSessionRegistry(),
    });

    expect(Object.keys(result.task.workspaceWorktrees ?? {}).sort()).toEqual(["repo-a", "repo-b"]);
    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "fn-107"));
  });
});
