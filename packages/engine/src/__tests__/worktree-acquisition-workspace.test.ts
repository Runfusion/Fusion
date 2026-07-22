/*
FNXC:Workspace 2026-06-21-20:10:
U2 per-repo acquisition hardening tests. A REAL two-repo git fixture is required
because the invariants under test are git-shaped: local-ahead-of-origin base
capture, a resolved-per-repo (non-shared) integration branch, and a working
identity-guard hook that actually rejects a commit. The shared harness from
./_workspace-fixture.ts builds genuine on-disk repos under a NON-git workspace
root. The TaskStore is an in-memory fake (no DB / no network) per FN-5048 — real
git only where the invariant needs it; everything else is a narrow seam.
*/
import { execSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import {
  acquireWorkspaceRepoWorktree,
  WorkspaceRepoAcquireBusyError,
} from "../worktree/worktree-acquisition.js";
import { ActiveSessionRegistry } from "../agents/active-session-registry.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Minimal in-memory TaskStore covering exactly what acquireWorkspaceRepoWorktree
 * and its acquireTaskWorktree callee touch: updateTask (merge-in-place so the
 * idempotency re-read sees persisted workspaceWorktrees), logEntry, getTask.
 */
function makeFakeStore(task: Task): { store: TaskStore; current: () => Task; logs: string[] } {
  let current = task;
  const logs: string[] = [];
  const store = {
    async updateTask(id: string, patch: Partial<Task>): Promise<void> {
      if (id === current.id) current = { ...current, ...patch };
    },
    async logEntry(_id: string, message: string): Promise<void> {
      logs.push(message);
    },
    async getTask(id: string): Promise<Task | null> {
      return id === current.id ? current : null;
    },
  } as unknown as TaskStore;
  return { store, current: () => current, logs };
}

function makeTask(id: string): Task {
  return {
    id,
    title: `task ${id}`,
    description: "workspace task",
    status: "in-progress",
  } as unknown as Task;
}

const SETTINGS: Partial<Settings> = {
  worktreeNaming: "task-id",
  commitMsgHookEnabled: true,
  taskPrefix: "FN",
  taskAttributionTrailerNames: ["Fusion-Task-Id"],
};

describeIfGit("acquireWorkspaceRepoWorktree (U2 per-repo hardening)", { timeout: 60_000 }, () => {
  let fixture: WorkspaceFixture;

  afterEach(() => {
    fixture?.cleanup();
  });

  it("captures the LOCAL integration tip as baseCommitSha even when origin is behind (inflation invariant)", async () => {
    // Give repo-a a real origin so origin/main can lag behind local main.
    fixture = await createWorkspaceFixture(["repo-a"]);
    const repoA = fixture.repoPath("repo-a");
    const origin = `${repoA}-origin`;
    git(repoA, "git init --bare " + JSON.stringify(origin));
    git(repoA, `git remote add origin ${JSON.stringify(origin)}`);
    git(repoA, "git push -u origin main");

    // Local main advances by an unpushed predecessor commit (FN-5937 shape).
    git(repoA, "git commit --allow-empty -m 'FN-9000: unpushed predecessor'");
    const localTip = git(repoA, "git rev-parse HEAD");
    const originTip = git(repoA, "git rev-parse origin/main");
    expect(localTip).not.toBe(originTip);

    const { store, current } = makeFakeStore(makeTask("FN-1"));
    const registry = new ActiveSessionRegistry();
    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry,
    });

    // Base must be the LOCAL tip, never the behind origin tip.
    expect(result.baseCommitSha).toBe(localTip);
    expect(current().workspaceWorktrees?.["repo-a"]?.baseCommitSha).toBe(localTip);
  });

  it("captures against a NON-main integration branch and does not inherit a shared settings.integrationBranch (KTD3)", async () => {
    // repo-a's default branch is 'develop'; origin/HEAD points at it. A shared
    // settings.integrationBranch override must be STRIPPED so per-repo resolution
    // falls through to this repo's own origin/HEAD.
    fixture = await createWorkspaceFixture(["repo-a"], "develop");
    const repoA = fixture.repoPath("repo-a");
    const origin = `${repoA}-origin`;
    git(repoA, "git init --bare " + JSON.stringify(origin));
    git(repoA, `git remote add origin ${JSON.stringify(origin)}`);
    git(repoA, "git push -u origin develop");
    // Point origin/HEAD at develop so resolveIntegrationBranch resolves it.
    git(repoA, "git remote set-head origin develop");
    const developTip = git(repoA, "git rev-parse develop");

    const { store, current } = makeFakeStore(makeTask("FN-2"));
    const registry = new ActiveSessionRegistry();
    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      // A SHARED integration branch that does NOT exist in this sub-repo. If it
      // leaked through, base capture would resolve against 'shared-trunk' and
      // (absent that branch) fall back to HEAD — not develop's tip.
      settings: { ...SETTINGS, integrationBranch: "shared-trunk" },
      registry,
    });

    expect(result.baseCommitSha).toBe(developTip);
  });

  it("reconciles a sub-repo dangling collision branch from its resolved integration tip", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const repoA = fixture.repoPath("repo-a");
    const mainTip = git(repoA, "git rev-parse main");
    // Leave ambient HEAD on unrelated work to prove fresh acquisition uses the
    // sub-repo integration branch, not whichever branch the root currently has checked out.
    git(repoA, "git checkout -qb ambient-work");
    git(repoA, "git commit --allow-empty -m 'chore: ambient work'");
    git(repoA, "git branch fusion/fn-7 main");

    const { store, current } = makeFakeStore(makeTask("FN-7"));
    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: current(), store,
      settings: SETTINGS, registry: new ActiveSessionRegistry(),
    });

    expect(result.branch).toBe("fusion/fn-7");
    expect(git(repoA, "git rev-parse fusion/fn-7")).toBe(mainTip);
    expect(git(repoA, "git merge-base fusion/fn-7 main")).toBe(mainTip);
  });

  it("installs the identity-guard hook so a commit on a non-fusion branch is rejected", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current } = makeFakeStore(makeTask("FN-3"));
    const registry = new ActiveSessionRegistry();
    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      settings: SETTINGS,
      store,
      registry,
    });

    const wt = result.worktreePath;
    expect(existsSync(join(wt, ".git"))).toBe(true);
    git(wt, 'git config user.email "test@example.com"');
    git(wt, 'git config user.name "Test"');

    // On the fusion/<id> branch the guard permits a commit (real staged change,
    // so the FN-5345 empty-commit guard also installed by the identity guard
    // does not refuse it).
    git(wt, "git checkout fusion/fn-3");
    writeFileSync(join(wt, "own.txt"), "own work\n", "utf-8");
    git(wt, "git add own.txt");
    git(wt, "git commit -m 'FN-3: ok on own branch'");

    // Switch to a foreign branch; the pre-commit identity guard must refuse.
    git(wt, "git checkout -B rogue-branch");
    writeFileSync(join(wt, "rogue.txt"), "rogue work\n", "utf-8");
    git(wt, "git add rogue.txt");
    const attempt = spawnSync("git", ["commit", "-m", "rogue"], {
      cwd: wt,
      encoding: "utf-8",
    });
    expect(attempt.status).not.toBe(0);
    expect(`${attempt.stderr}`).toMatch(/refusing commit/i);
  });

  it("serializes two concurrent acquisitions of the SAME sub-repo via the exclusivity registry (KTD4)", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const repoAbs = fixture.repoPath("repo-a");
    const registry = new ActiveSessionRegistry();

    // Pre-register the sub-repo path as if task FN-A is mid-acquisition, then
    // prove a second task is rejected while it is held.
    registry.registerPath(repoAbs, { taskId: "FN-A", kind: "workspace-repo-acquire", ownerKey: "workspace-repo-acquire" });

    const { store, current } = makeFakeStore(makeTask("FN-B"));
    await expect(
      acquireWorkspaceRepoWorktree({
        repoRelPath: "repo-a",
        workspaceRootDir: fixture.rootDir,
        task: current(),
        store,
        settings: SETTINGS,
        registry,
      }),
    ).rejects.toBeInstanceOf(WorkspaceRepoAcquireBusyError);

    // The holder's entry is untouched by the rejected loser.
    expect(registry.lookupByPath(repoAbs)?.taskId).toBe("FN-A");

    // Once released, the same task acquires cleanly and the registry is freed.
    registry.unregisterPath(repoAbs);
    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry,
    });
    expect(result.alreadyAcquired).toBe(false);
    // Acquisition releases its own exclusivity entry on completion.
    expect(registry.isPathActive(repoAbs)).toBe(false);
  });

  it("is idempotent across (taskId, repo): re-acquire returns the existing entry without re-capture", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current } = makeFakeStore(makeTask("FN-4"));
    const registry = new ActiveSessionRegistry();

    const first = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry,
    });
    expect(first.alreadyAcquired).toBe(false);

    // Re-acquire with the now-populated task: returns the persisted entry,
    // does not re-register exclusivity, does not re-create a worktree.
    const second = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry,
    });
    expect(second.alreadyAcquired).toBe(true);
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.baseCommitSha).toBe(first.baseCommitSha);
    expect(registry.isPathActive(fixture.repoPath("repo-a"))).toBe(false);
  });

  it("surfaces an error and persists an audit event when acquisition fails (no swallowed stall)", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current, logs } = makeFakeStore(makeTask("FN-5"));
    const registry = new ActiveSessionRegistry();
    const auditEvents: Array<{ type: string }> = [];
    const audit = {
      async git(e: { type: string }): Promise<void> {
        auditEvents.push(e);
      },
      async filesystem(): Promise<void> {},
    };

    await expect(
      acquireWorkspaceRepoWorktree({
        repoRelPath: "does-not-exist",
        workspaceRootDir: fixture.rootDir,
        task: current(),
        store,
        settings: SETTINGS,
        registry,
        audit: audit as never,
      }),
    ).rejects.toThrow();

    expect(auditEvents.some((e) => e.type === "worktree:workspace-repo-acquire-failed")).toBe(true);
    expect(logs.some((m) => /acquisition failed/i.test(m))).toBe(true);
    // The exclusivity entry is released even on the failure path.
    expect(registry.isPathActive(join(fixture.rootDir, "does-not-exist"))).toBe(false);
  });

  /*
  FNXC:Workspace 2026-06-21-22:30:
  F4 — resolveFromSettings falls back integrationBranch → settings.baseBranch →
  origin/HEAD. A shared settings.baseBranch must be STRIPPED alongside
  integrationBranch, otherwise a baseBranch absent from this sub-repo leaks through
  and the per-repo base resolves against the wrong branch. Here repo-a's only branch
  is its own origin/HEAD (develop); a shared baseBranch of 'shared-trunk' (absent in
  the sub-repo) must NOT be honored — the base must resolve to develop's tip.
  */
  it("strips a shared settings.baseBranch so the base resolves against the sub-repo's own origin/HEAD (KTD3 / F4)", async () => {
    fixture = await createWorkspaceFixture(["repo-a"], "develop");
    const repoA = fixture.repoPath("repo-a");
    const origin = `${repoA}-origin`;
    git(repoA, "git init --bare " + JSON.stringify(origin));
    git(repoA, `git remote add origin ${JSON.stringify(origin)}`);
    git(repoA, "git push -u origin develop");
    git(repoA, "git remote set-head origin develop");
    const developTip = git(repoA, "git rev-parse develop");

    const { store, current } = makeFakeStore(makeTask("FN-6"));
    const registry = new ActiveSessionRegistry();
    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      // A shared baseBranch (no integrationBranch) that does NOT exist in this
      // sub-repo. If it leaked through, base capture would resolve against
      // 'shared-trunk' instead of develop.
      settings: { ...SETTINGS, baseBranch: "shared-trunk" } as Partial<Settings>,
      registry,
    });

    expect(result.baseCommitSha).toBe(developTip);
  });

  /*
  FNXC:Workspace 2026-06-21-22:30:
  F5 — two sequential acquires for DIFFERENT sub-repos in one task must each persist
  their own workspaceWorktrees entry. The acquisition re-reads the task fresh before
  the merge so the second acquire does not clobber the first repo's entry.
  */
  it("preserves a sibling sub-repo's workspaceWorktrees entry across two different-repo acquires (F5)", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const { store, current } = makeFakeStore(makeTask("FN-7"));
    const registry = new ActiveSessionRegistry();

    const first = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry,
    });
    expect(first.alreadyAcquired).toBe(false);

    const second = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-b",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry,
    });
    expect(second.alreadyAcquired).toBe(false);

    // Both entries survive — the second acquire merged into the latest map, not the
    // stale snapshot, so repo-a was not clobbered.
    const persisted = current().workspaceWorktrees ?? {};
    expect(persisted["repo-a"]?.worktreePath).toBe(first.worktreePath);
    expect(persisted["repo-b"]?.worktreePath).toBe(second.worktreePath);
  });
});
