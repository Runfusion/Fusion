import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { persistWorktreeBackendKind } from "../worktree/worktree-backend.js";
import { refreshWorkspaceRepoWorktreeBases } from "../worktree/workspace-base-refresh.js";
import { acquireWorkspaceTaskWorktrees } from "../worktree/worktree-acquisition.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
}

function makeTask(id: string): Task {
  return {
    id,
    title: id,
    description: "workspace base refresh fixture",
    column: "in-progress",
    dependencies: [],
    steps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

function makeStore(
  initial: Task,
  options: { onLogEntry?: (message: string) => void | Promise<void> } = {},
): { store: TaskStore; current: () => Task; logs: string[] } {
  let current = initial;
  const logs: string[] = [];
  const store = {
    async getTask(id: string): Promise<Task> {
      if (id !== current.id) throw new Error(`missing ${id}`);
      return current;
    },
    async updateTask(id: string, patch: Partial<Task>): Promise<void> {
      if (id !== current.id) throw new Error(`missing ${id}`);
      current = { ...current, ...patch };
    },
    async mergeWorkspaceWorktreeEntry(
      id: string,
      repoRelPath: string,
      patch:
        | Partial<NonNullable<Task["workspaceWorktrees"]>[string]>
        | ((task: Task) => Promise<Partial<NonNullable<Task["workspaceWorktrees"]>[string]>>),
      options?: { requireExistingEntry?: boolean; clearSingularWorktree?: boolean },
    ): Promise<Task> {
      if (id !== current.id) throw new Error(`missing ${id}`);
      const existing = current.workspaceWorktrees?.[repoRelPath];
      if (options?.requireExistingEntry && !existing) return current;
      const resolved = typeof patch === "function" ? await patch(current) : patch;
      current = {
        ...current,
        workspaceWorktrees: {
          ...current.workspaceWorktrees,
          [repoRelPath]: { ...existing, ...resolved },
        },
        ...(options?.clearSingularWorktree ? { worktree: null, branch: null } : {}),
      };
      return current;
    },
    async logEntry(_id: string, message: string): Promise<void> {
      logs.push(message);
      await options.onLogEntry?.(message);
    },
  } as unknown as TaskStore;
  return { store, current: () => current, logs };
}

const settings: Partial<Settings> = {
  commitMsgHookEnabled: false,
  taskPrefix: "FN",
  taskAttributionTrailerNames: ["Fusion-Task-Id"],
};

async function acquire(
  fixture: WorkspaceFixture,
  store: TaskStore,
  task: Task,
  refreshStaleBase = false,
  repos = fixture.repos,
) {
  return acquireWorkspaceTaskWorktrees({
    workspaceConfig: { repos },
    workspaceRootDir: fixture.rootDir,
    task,
    store,
    settings,
    refreshStaleBase,
  });
}

function advanceIntegrationTip(fixture: WorkspaceFixture, repo: string, contents: string): string {
  writeFileSync(join(fixture.repoPath(repo), "README.md"), contents, "utf8");
  fixture.git(repo, "git add README.md && git commit -m advance-base");
  return fixture.git(repo, "git rev-parse HEAD");
}

describeIfGit("workspace base refresh", { timeout: 60_000 }, () => {
  let fixture: WorkspaceFixture;

  afterEach(() => fixture?.cleanup());

  it("refreshes every reused workspace checkout and its recorded baseline after the integration tips advance", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const { store, current } = makeStore(makeTask("FN-273-refresh"));
    const initial = await acquire(fixture, store, current());
    const initialBases = Object.fromEntries(fixture.repos.map((repo) => [repo, initial.task.workspaceWorktrees?.[repo]?.baseCommitSha]));
    const advancedBases = Object.fromEntries(fixture.repos.map((repo) => [repo, advanceIntegrationTip(fixture, repo, `# ${repo} C1\n`)]));

    const refreshed = await acquire(fixture, store, current(), true);

    for (const repo of fixture.repos) {
      const entry = refreshed.task.workspaceWorktrees?.[repo];
      expect(initialBases[repo]).not.toBe(advancedBases[repo]);
      expect(git(entry!.worktreePath, "rev-parse HEAD")).toBe(advancedBases[repo]);
      expect(entry?.baseCommitSha).toBe(advancedBases[repo]);
    }
  });

  it("keeps a dirty repository checkout on its existing base while refreshing an independent sibling", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const { store, current, logs } = makeStore(makeTask("FN-273-dirty"));
    const initial = await acquire(fixture, store, current());
    const initialRepoA = initial.task.workspaceWorktrees?.["repo-a"]!;
    const advancedRepoB = advanceIntegrationTip(fixture, "repo-b", "# repo-b C1\n");
    advanceIntegrationTip(fixture, "repo-a", "# repo-a C1\n");
    writeFileSync(join(initialRepoA.worktreePath, "dirty.txt"), "keep local edits\n", "utf8");

    const refreshed = await acquire(fixture, store, current(), true);

    expect(git(initialRepoA.worktreePath, "rev-parse HEAD")).toBe(initialRepoA.baseCommitSha);
    expect(refreshed.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha).toBe(initialRepoA.baseCommitSha);
    expect(git(refreshed.task.workspaceWorktrees?.["repo-b"]!.worktreePath, "rev-parse HEAD")).toBe(advancedRepoB);
    expect(logs.some((message) => message.includes("Workspace base refresh skipped [repo-a] (dirty-worktree)"))).toBe(true);
  });

  it("does not refresh a missing remembered workspace checkout", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const task = makeTask("FN-273-missing");
    const { store, current } = makeStore({
      ...task,
      workspaceWorktrees: {
        "repo-a": { worktreePath: join(fixture.rootDir, "missing-worktree"), baseCommitSha: fixture.git("repo-a", "git rev-parse HEAD") },
      } as Task["workspaceWorktrees"],
    });

    await expect(acquire(fixture, store, current(), true)).resolves.toMatchObject({ task: { id: task.id } });
  });

  it("rebases a repository's own commit onto its advanced recorded base without persisting the task tip as the baseline", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current } = makeStore(makeTask("FN-273-own-commit"));
    const initial = await acquire(fixture, store, current());
    const entry = initial.task.workspaceWorktrees?.["repo-a"]!;
    writeFileSync(join(entry.worktreePath, "implementation.ts"), "export const taskCommit = true;\n", "utf8");
    git(entry.worktreePath, "add implementation.ts && git commit -m task-commit");
    const taskCommit = git(entry.worktreePath, "rev-parse HEAD");
    const base = advanceIntegrationTip(fixture, "repo-a", "# repo-a C1\n");

    const refreshed = await acquire(fixture, store, current(), true);
    const refreshedEntry = refreshed.task.workspaceWorktrees?.["repo-a"]!;
    const rebasedHead = git(refreshedEntry.worktreePath, "rev-parse HEAD");

    expect(rebasedHead).not.toBe(taskCommit);
    expect(rebasedHead).not.toBe(base);
    expect(git(refreshedEntry.worktreePath, `merge-base --is-ancestor ${base} ${rebasedHead}; echo $?`)).toBe("0");
    expect(refreshedEntry.baseCommitSha).toBe(base);
  });

  it("compensates a conflicting workspace rebase back to the task commit and keeps the recorded baseline", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current, logs } = makeStore(makeTask("FN-273-conflict"));
    const initial = await acquire(fixture, store, current());
    const entry = initial.task.workspaceWorktrees?.["repo-a"]!;
    const originalBase = entry.baseCommitSha;
    writeFileSync(join(entry.worktreePath, "README.md"), "# task-side\n", "utf8");
    git(entry.worktreePath, "add README.md && git commit -m task-side");
    const taskCommit = git(entry.worktreePath, "rev-parse HEAD");
    advanceIntegrationTip(fixture, "repo-a", "# integration-side\n");

    const refreshed = await acquire(fixture, store, current(), true);

    expect(git(entry.worktreePath, "rev-parse HEAD")).toBe(taskCommit);
    expect(git(entry.worktreePath, "status --porcelain")).toBe("");
    expect(refreshed.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha).toBe(originalBase);
    expect(logs.some((message) => message.includes("stale-base-conflict"))).toBe(true);
  });

  it("isolates an unresolvable recorded base while refreshing a sibling checkout", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    let removeRecordedBase = true;
    const { store, current, logs } = makeStore(makeTask("FN-273-base-isolation"), {
      onLogEntry: (message) => {
        if (removeRecordedBase && message.includes("repo-a acquire uses base branch recorded-base")) {
          removeRecordedBase = false;
          fixture.git("repo-a", "git branch -D recorded-base");
        }
      },
    });
    const initial = await acquire(fixture, store, current());
    fixture.git("repo-a", `git branch recorded-base ${initial.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha}`);
    await store.mergeWorkspaceWorktreeEntry("FN-273-base-isolation", "repo-a", { baseBranch: "recorded-base" }, { requireExistingEntry: true });
    const repoBBase = advanceIntegrationTip(fixture, "repo-b", "# repo-b C1\n");
    advanceIntegrationTip(fixture, "repo-a", "# repo-a C1\n");

    const refreshed = await acquire(fixture, store, current(), true);

    expect(git(refreshed.task.workspaceWorktrees?.["repo-a"]!.worktreePath, "rev-parse HEAD"))
      .toBe(initial.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha);
    expect(refreshed.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha)
      .toBe(initial.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha);
    expect(git(refreshed.task.workspaceWorktrees?.["repo-b"]!.worktreePath, "rev-parse HEAD")).toBe(repoBBase);
    expect(logs.some((message) => message.includes("Workspace base refresh skipped [repo-a] (base-unresolvable)"))).toBe(true);
  });

  it("refreshes a landed repository and an unlanded sibling independently", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const { store, current } = makeStore(makeTask("FN-273-landed"));
    const initial = await acquire(fixture, store, current());
    const landedSha = initial.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha!;
    await store.mergeWorkspaceWorktreeEntry("FN-273-landed", "repo-a", { landedSha }, { requireExistingEntry: true });
    const bases = Object.fromEntries(fixture.repos.map((repo) => [repo, advanceIntegrationTip(fixture, repo, `# ${repo} C1\n`)]));

    const refreshed = await acquire(fixture, store, current(), true);

    for (const repo of fixture.repos) {
      const entry = refreshed.task.workspaceWorktrees?.[repo]!;
      expect(git(entry.worktreePath, "rev-parse HEAD")).toBe(bases[repo]);
      expect(entry.baseCommitSha).toBe(bases[repo]);
    }
    expect(refreshed.task.workspaceWorktrees?.["repo-a"]?.landedSha).toBe(landedSha);
  });

  it("honors a recorded repository base before falling back to that repository's integration branch", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current } = makeStore(makeTask("FN-273-recorded-base"));
    const initial = await acquire(fixture, store, current());
    const c0 = initial.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha!;
    const c1 = advanceIntegrationTip(fixture, "repo-a", "# repo-a C1\n");
    fixture.git("repo-a", `git branch release-base ${c0}`);
    await store.mergeWorkspaceWorktreeEntry("FN-273-recorded-base", "repo-a", { baseBranch: "release-base" }, { requireExistingEntry: true });

    const recorded = await acquire(fixture, store, current(), true);
    expect(git(recorded.task.workspaceWorktrees?.["repo-a"]!.worktreePath, "rev-parse HEAD")).toBe(c0);
    expect(recorded.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha).toBe(c0);

    await store.mergeWorkspaceWorktreeEntry("FN-273-recorded-base", "repo-a", { baseBranch: undefined }, { requireExistingEntry: true });
    const fallback = await acquire(fixture, store, current(), true);
    expect(git(fallback.task.workspaceWorktrees?.["repo-a"]!.worktreePath, "rev-parse HEAD")).toBe(c1);
    expect(fallback.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha).toBe(c1);
  });

  it("ignores undeclared entry aliases and declared repositories with no persisted checkout during refresh", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const { store, current } = makeStore(makeTask("FN-273-aliases"));
    await acquire(fixture, store, current(), false, ["repo-a"]);
    await store.mergeWorkspaceWorktreeEntry(
      "FN-273-aliases",
      "foreign/repo-a",
      { worktreePath: join(fixture.rootDir, "foreign"), baseCommitSha: "not-a-real-sha" },
    );

    const refreshed = await refreshWorkspaceRepoWorktreeBases({
      task: current(),
      workspaceRootDir: fixture.rootDir,
      repoRelPaths: ["repo-a", "repo-b"],
      store,
      settings,
    });

    expect(refreshed.results.map(({ repoRelPath }) => repoRelPath)).toEqual(["repo-a"]);
    expect(refreshed.task.workspaceWorktrees?.["foreign/repo-a"]?.baseCommitSha).toBe("not-a-real-sha");
  });

  it("leaves a Worktrunk-backed workspace checkout untouched", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current } = makeStore(makeTask("FN-273-worktrunk"));
    const initial = await acquire(fixture, store, current());
    const entry = initial.task.workspaceWorktrees?.["repo-a"]!;
    const c0 = entry.baseCommitSha!;
    advanceIntegrationTip(fixture, "repo-a", "# repo-a C1\n");
    await persistWorktreeBackendKind(entry.worktreePath, "worktrunk");

    const refreshed = await acquire(fixture, store, current(), true);

    expect(git(entry.worktreePath, "rev-parse HEAD")).toBe(c0);
    expect(refreshed.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha).toBe(c0);
  });

  it("refreshes an existing legacy positional workspace checkout and preserves its legacy session root", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const legacy = fixture.createLinkedTaskWorktree("repo-a", "fusion/fn-273-legacy");
    const { store, current } = makeStore({
      ...makeTask("FN-273-legacy"),
      workspaceWorktrees: {
        "repo-a": { worktreePath: legacy.worktreePath, branch: "fusion/fn-273-legacy", baseCommitSha: legacy.baseCommitSha },
      },
    });
    const c1 = advanceIntegrationTip(fixture, "repo-a", "# repo-a C1\n");

    const refreshed = await acquire(fixture, store, current(), true);

    expect(refreshed.taskWorktreeDir).toBe(legacy.worktreePath);
    expect(git(legacy.worktreePath, "rev-parse HEAD")).toBe(c1);
    expect(refreshed.task.workspaceWorktrees?.["repo-a"]?.baseCommitSha).toBe(c1);
  });

  it("routes a real workspace refresh safety refusal through the established acquisition error path", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current } = makeStore(makeTask("FN-273-unproven"));
    await acquire(fixture, store, current());

    const unsafeRefresh = {
      kind: "base-reconciliation-required" as const,
      executionSafe: false,
      durableBaseSha: current().workspaceWorktrees?.["repo-a"]?.baseCommitSha ?? null,
      detail: "failed compensation left the checkout unproven",
    };
    const refreshSpy = vi.fn(async () => unsafeRefresh);
    vi.doMock("../worktree-base-refresh.js", async () => {
      const actual = await vi.importActual<typeof import("../worktree-base-refresh.js")>("../worktree-base-refresh.js");
      return { ...actual, refreshReusedWorktreeBase: refreshSpy };
    });
    vi.resetModules();
    try {
      const { acquireWorkspaceTaskWorktrees: acquireWithUnsafeRefresh, WorktreeBaseRefreshError } = await import("../worktree/worktree-acquisition.js");

      await expect(acquireWithUnsafeRefresh({
        workspaceConfig: { repos: fixture.repos },
        workspaceRootDir: fixture.rootDir,
        task: current(),
        store,
        settings,
        refreshStaleBase: true,
      })).rejects.toBeInstanceOf(WorktreeBaseRefreshError);

      expect(refreshSpy).toHaveBeenCalledOnce();
      expect(refreshSpy).toHaveBeenCalledWith(expect.objectContaining({
        task: expect.objectContaining({ id: "FN-273-unproven" }),
        baseline: expect.objectContaining({
          durableBaseSha: unsafeRefresh.durableBaseSha,
        }),
      }));
    } finally {
      vi.doUnmock("../worktree-base-refresh.js");
      vi.resetModules();
    }
  });
});
