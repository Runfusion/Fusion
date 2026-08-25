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
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_GROUP_MARKER_FILENAME,
  WORKSPACE_RESERVED_TASK_DIR_SEGMENTS,
  workspaceRepoSegment,
  workspaceWorktreeGroupSegment,
  type Settings,
  type Task,
  type TaskStore,
} from "@fusion/core";
import {
  acquireTaskWorktree,
  acquireWorkspaceRepoWorktree,
  acquireWorkspaceTaskWorktrees,
  WorkspaceRepoAcquireBusyError,
} from "../worktree/worktree-acquisition.js";
import { ActiveSessionRegistry } from "../agents/active-session-registry.js";
import { cleanupOrphanedWorktrees } from "../worktree/worktree-pool.js";
import { AI_MERGE_DIRNAME, WORKTREE_RECOVERY_DIRNAME } from "../worktree/worktree-paths.js";
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
function makeFakeStore(
  task: Task,
  options: {
    failWhen?: (patch: Partial<Task>) => boolean;
    beforeWorkspaceMerge?: (repoRelPath: string) => Promise<void>;
  } = {},
): { store: TaskStore; current: () => Task; logs: string[]; patches: Partial<Task>[]; mutationsDuringMerge: () => number } {
  let current = task;
  let mergeTail = Promise.resolve();
  let mergeCallbackActive = false;
  let nestedMutationCount = 0;
  const logs: string[] = [];
  const patches: Partial<Task>[] = [];
  const store = {
    async updateTask(id: string, patch: Partial<Task>): Promise<void> {
      if (mergeCallbackActive) nestedMutationCount += 1;
      // Deliberately retain wholesale replacement: the concurrent regression below must fail
      // if production returns to updateTask({ workspaceWorktrees }) instead of the key merge.
      patches.push(patch);
      if (options.failWhen?.(patch)) throw new Error("injected update failure");
      if (id === current.id) current = { ...current, ...patch };
    },
    async mergeWorkspaceWorktreeEntry(
      id: string,
      repoRelPath: string,
      patch:
        | Partial<NonNullable<Task["workspaceWorktrees"]>[string]>
        | ((freshTask: Task) => Promise<Partial<NonNullable<Task["workspaceWorktrees"]>[string]>>),
      mergeOptions?: {
        requireExistingEntry?: boolean;
        clearSingularWorktree?: boolean;
        validateBeforePersist?: (freshTask: Task) => Promise<void>;
      },
    ): Promise<Task> {
      if (id !== current.id) throw new Error(`Task ${id} not found`);
      await options.beforeWorkspaceMerge?.(repoRelPath);
      // Mirror TaskStore.withTaskLock after the deterministic overlap gate so both contenders
      // can arrive, then serialize the fresh read + callback + key merge exactly like production.
      const previousMerge = mergeTail;
      let releaseMerge!: () => void;
      mergeTail = new Promise<void>((resolve) => { releaseMerge = resolve; });
      await previousMerge;
      try {
        const workspaceWorktrees = current.workspaceWorktrees ?? {};
        const existing = workspaceWorktrees[repoRelPath];
        if (mergeOptions?.requireExistingEntry && !existing) return current;
        mergeCallbackActive = true;
        let resolvedPatch: Partial<NonNullable<Task["workspaceWorktrees"]>[string]>;
        try {
          resolvedPatch = typeof patch === "function" ? await patch(current) : patch;
        } finally {
          mergeCallbackActive = false;
        }
        await mergeOptions?.validateBeforePersist?.(current);
        const mergedPatch: Partial<Task> = {
          workspaceWorktrees: { ...workspaceWorktrees, [repoRelPath]: { ...existing, ...resolvedPatch } },
          ...(mergeOptions?.clearSingularWorktree ? { worktree: undefined, branch: undefined } : {}),
        };
        patches.push(mergedPatch);
        if (options.failWhen?.(mergedPatch)) throw new Error("injected update failure");
        current = { ...current, ...mergedPatch };
        return current;
      } finally {
        releaseMerge();
      }
    },
    async logEntry(_id: string, message: string): Promise<void> {
      if (mergeCallbackActive) nestedMutationCount += 1;
      logs.push(message);
    },
    async getTask(id: string): Promise<Task | null> {
      return id === current.id ? current : null;
    },
  } as unknown as TaskStore;
  return { store, current: () => current, logs, patches, mutationsDuringMerge: () => nestedMutationCount };
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

  it("records a repository-qualified dependency-readiness decision through the workspace callback store", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current, logs } = makeFakeStore(makeTask("FN-255"));
    const ensureDependencyReadiness = vi.fn().mockResolvedValue({ readiness: "satisfied" });

    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      ensureDependencyReadiness,
      registry: new ActiveSessionRegistry(),
    });

    expect(ensureDependencyReadiness).toHaveBeenCalledTimes(1);
    expect(ensureDependencyReadiness.mock.calls[0]?.[0]).toMatchObject({
      worktreePath: result.worktreePath,
      taskId: "FN-255",
    });
    expect(logs).toContain("Worktree dependency readiness [repo-a]: satisfied");
  });

  it("runs the real dependency bootstrap through workspace acquisition", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const repo = fixture.repoPath("repo-a");
    writeFileSync(join(repo, "package.json"), "{\"name\":\"fixture\"}\n", "utf8");
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    fixture.git("repo-a", "git add package.json pnpm-lock.yaml && git commit -m 'add dependency manifests'");
    writeFileSync(join(fixture.rootDir, "pnpm"), "fixture", "utf8");
    const { store, current, logs } = makeFakeStore(makeTask("FN-258-workspace-bootstrap"));
    const runConfiguredCommand = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry: new ActiveSessionRegistry(),
      runConfiguredCommand,
      taskEnv: { PATH: fixture.rootDir },
    });

    expect(result.alreadyAcquired).toBe(false);
    expect(runConfiguredCommand).toHaveBeenCalledWith(
      "pnpm install --frozen-lockfile",
      result.worktreePath,
      300_000,
      { PATH: fixture.rootDir },
    );
    expect(logs).toContain("Worktree dependency readiness [repo-a]: satisfied");
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

  it("materializes a remote-tracking-only requested base as a local land target", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const repoA = fixture.repoPath("repo-a");
    const origin = `${repoA}-origin`;
    git(repoA, "git init --bare " + JSON.stringify(origin));
    git(repoA, `git remote add origin ${JSON.stringify(origin)}`);
    git(repoA, "git checkout -qb release/remote-only");
    git(repoA, "git commit --allow-empty -m 'release base'");
    const releaseTip = git(repoA, "git rev-parse HEAD");
    git(repoA, "git push -u origin release/remote-only");
    git(repoA, "git checkout main");
    git(repoA, "git branch -D release/remote-only");
    expect(git(repoA, "git rev-parse origin/release/remote-only")).toBe(releaseTip);

    const remoteBaseTask = makeTask("FN-9164-remote");
    remoteBaseTask.baseBranch = "release/remote-only";
    const { store, current } = makeFakeStore(remoteBaseTask);
    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: current(), store,
      settings: SETTINGS, registry: new ActiveSessionRegistry(),
    });

    expect(git(repoA, "git rev-parse release/remote-only")).toBe(releaseTip);
    expect(git(repoA, `git merge-base ${result.branch} release/remote-only`)).toBe(releaseTip);
    expect(current().workspaceWorktrees?.["repo-a"]?.baseBranch).toBe("release/remote-only");
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

    const { store, current, patches } = makeFakeStore(makeTask("FN-B"));
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
    expect(patches).toHaveLength(0);

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

  it("replaces a same-kind live registry cache after durable lease admission", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const repoAbs = fixture.repoPath("repo-a");
    const registry = new ActiveSessionRegistry();
    registry.registerPath(repoAbs, { taskId: "FN-stale", kind: "workspace-repo-acquire", ownerKey: "workspace-repo-acquire" });
    const { store, current } = makeFakeStore(makeTask("FN-authority"));
    const events: Array<{ mutationType?: string; metadata?: Record<string, unknown> }> = [];
    const lease = {
      leaseKey: "repo:repo-a",
      owner: { taskId: "FN-authority", nodeId: "node", incarnationId: "incarnation" },
      fenceToken: 1n,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    Object.assign(store as object, {
      acquireWorkspaceLease: async () => ({ outcome: "reclaimed-expired", handle: lease }),
      renewWorkspaceLease: async () => lease,
      releaseWorkspaceLease: async () => true,
      recordRunAuditEvent: async (event: { mutationType?: string; metadata?: Record<string, unknown> }) => { events.push(event); },
    });

    await expect(acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: current(), store, settings: SETTINGS, registry,
      holderLiveProbe: () => true,
    })).resolves.toMatchObject({ alreadyAcquired: false });

    expect(events).toContainEqual(expect.objectContaining({
      mutationType: "worktree:workspace-repo-acquire-reclaimed",
      metadata: expect.objectContaining({ holderTaskId: "FN-stale", outcome: "lease-authority" }),
    }));
    expect(registry.lookupByPath(repoAbs)).toBeNull();
  });

  it("is idempotent across (taskId, repo): re-acquire returns the existing entry without re-capture", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current, patches } = makeFakeStore(makeTask("FN-4"));
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
    expect(patches).toHaveLength(1);
    expect(registry.isPathActive(fixture.repoPath("repo-a"))).toBe(false);
  });

  it("defers task mutations until the lifecycle-locked workspace merge callback has returned", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current, logs, mutationsDuringMerge } = makeFakeStore(makeTask("FN-4-lock"));

    await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry: new ActiveSessionRegistry(),
    });

    expect(mutationsDuringMerge()).toBe(0);
    expect(logs.some((message) => message.includes("Worktree created at"))).toBe(true);
  });

  it("creates one durable worktree when the same task acquires the same repository concurrently", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const initial = makeTask("FN-4-concurrent");
    const { store, current } = makeFakeStore(initial);
    const registry = new ActiveSessionRegistry();
    const auditEvents: Array<{ type: string }> = [];
    const audit = {
      async git(event: { type: string }): Promise<void> { auditEvents.push(event); },
      async filesystem(): Promise<void> {},
    };

    const [first, second] = await Promise.all([
      acquireWorkspaceRepoWorktree({
        repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: initial, store,
        settings: SETTINGS, registry, audit,
      }),
      acquireWorkspaceRepoWorktree({
        repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: initial, store,
        settings: SETTINGS, registry, audit,
      }),
    ]);

    expect([first.alreadyAcquired, second.alreadyAcquired].sort()).toEqual([false, true]);
    expect(first.worktreePath).toBe(second.worktreePath);
    expect(Object.keys(current().workspaceWorktrees ?? {})).toEqual(["repo-a"]);
    expect(auditEvents.filter((event) => event.type === "worktree:create")).toHaveLength(1);
  });

  it("replaces a concurrently persisted directory that is not a usable git worktree", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const initial = makeTask("FN-4-stale-concurrent");
    let store!: TaskStore;
    const fake = makeFakeStore(initial, {
      beforeWorkspaceMerge: async () => {
        await store.updateTask(initial.id, {
          workspaceWorktrees: {
            "repo-a": { worktreePath: fixture.rootDir, branch: "fusion/stale-directory" },
          },
        });
      },
    });
    store = fake.store;

    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: initial,
      store,
      settings: SETTINGS,
      registry: new ActiveSessionRegistry(),
    });

    expect(result.alreadyAcquired).toBe(false);
    expect(result.worktreePath).not.toBe(fixture.rootDir);
    expect(fake.current().workspaceWorktrees?.["repo-a"]?.worktreePath).toBe(result.worktreePath);
  });

  it("removes a prepared worktree when authoritative pre-persist validation rejects it", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current } = makeFakeStore(makeTask("FN-4-rejected-persist"));
    const auditEvents: Array<{ type: string; target?: string }> = [];
    let validationCalls = 0;

    await expect(acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry: new ActiveSessionRegistry(),
      audit: {
        async git(event: { type: string; target?: string }): Promise<void> { auditEvents.push(event); },
        async filesystem(): Promise<void> {},
      },
      validateTaskBeforeCreate: async () => {
        validationCalls += 1;
        if (validationCalls === 2) throw new Error("lifecycle moved before persistence");
      },
    })).rejects.toThrow("lifecycle moved before persistence");

    const createdPath = auditEvents.find((event) => event.type === "worktree:create")?.target;
    expect(validationCalls).toBe(2);
    expect(createdPath).toBeTruthy();
    expect(existsSync(createdPath!)).toBe(false);
    expect(current().workspaceWorktrees?.["repo-a"]).toBeUndefined();
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
    const { store, current, patches } = makeFakeStore(makeTask("FN-7"));
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
    expect(patches.every((patch) => !patch.worktree && !patch.branch)).toBe(true);
  });

  it("retains both sibling entries when different repo acquisitions overlap deterministically", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    let firstAtMerge!: () => void;
    const firstReachedMerge = new Promise<void>((resolve) => { firstAtMerge = resolve; });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let mergeCalls = 0;
    const { store, current } = makeFakeStore(makeTask("FN-7-concurrent"), {
      beforeWorkspaceMerge: async () => {
        mergeCalls += 1;
        if (mergeCalls === 1) {
          firstAtMerge();
          await release;
        } else {
          // The second acquisition reaches the atomic merge before the first writes.
          releaseFirst();
        }
      },
    });
    const registry = new ActiveSessionRegistry();

    const first = acquireWorkspaceRepoWorktree({ repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: current(), store, settings: SETTINGS, registry });
    await firstReachedMerge;
    const second = acquireWorkspaceRepoWorktree({ repoRelPath: "repo-b", workspaceRootDir: fixture.rootDir, task: current(), store, settings: SETTINGS, registry });
    const [a, b] = await Promise.all([first, second]);

    expect(a.alreadyAcquired).toBe(false);
    expect(b.alreadyAcquired).toBe(false);
    expect(current().workspaceWorktrees).toMatchObject({
      "repo-a": { worktreePath: a.worktreePath, branch: a.branch },
      "repo-b": { worktreePath: b.worktreePath, branch: b.branch },
    });
    expect(current().worktree).toBeFalsy();
    expect(current().branch).toBeFalsy();
  });

  it("keeps same-repo concurrent acquisition exclusive while the winning merge is pending", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    let reachedMerge!: () => void;
    const firstReachedMerge = new Promise<void>((resolve) => { reachedMerge = resolve; });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const { store, current } = makeFakeStore(makeTask("FN-7-same-repo"), {
      beforeWorkspaceMerge: async () => { reachedMerge(); await release; },
    });
    const registry = new ActiveSessionRegistry();
    const first = acquireWorkspaceRepoWorktree({ repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: current(), store, settings: SETTINGS, registry });
    await firstReachedMerge;
    await expect(acquireWorkspaceRepoWorktree({ repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: makeTask("FN-7-same-repo-loser"), store, settings: SETTINGS, registry })).rejects.toBeInstanceOf(WorkspaceRepoAcquireBusyError);
    releaseFirst();
    const winner = await first;
    expect(current().workspaceWorktrees?.["repo-a"]?.worktreePath).toBe(winner.worktreePath);
  });

  it("re-acquires a dead remembered workspace entry without singular persistence", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const initial = {
      ...makeTask("FN-8"),
      workspaceWorktrees: {
        "repo-a": { worktreePath: join(fixture.rootDir, "missing-worktree"), branch: "fusion/fn-8" },
      },
    };
    const { store, current, patches } = makeFakeStore(initial);

    const result = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: initial, store,
      settings: SETTINGS, registry: new ActiveSessionRegistry(),
    });

    expect(result.alreadyAcquired).toBe(false);
    expect(current().workspaceWorktrees?.["repo-a"]?.worktreePath).toBe(result.worktreePath);
    expect(patches.every((patch) => !patch.worktree && !patch.branch)).toBe(true);
  });

  it("never exposes a singular worktree assignment while acquiring a workspace repo", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const initial = makeTask("FN-8");
    const { store, patches } = makeFakeStore(initial);

    await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: initial, store,
      settings: SETTINGS, registry: new ActiveSessionRegistry(),
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]).toHaveProperty("workspaceWorktrees");
    expect(patches.every((patch) => !patch.worktree && !patch.branch)).toBe(true);

    let replayed = initial;
    for (const patch of patches) {
      replayed = { ...replayed, ...patch };
      expect(replayed.worktree).toBeFalsy();
      expect(replayed.branch).toBeFalsy();
    }
  });

  it("leaves the task workspace-shaped when the final workspace state write fails", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const initial = makeTask("FN-9");
    const { store, current, patches } = makeFakeStore(initial, {
      failWhen: (patch) => "workspaceWorktrees" in patch,
    });

    await expect(acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a", workspaceRootDir: fixture.rootDir, task: initial, store,
      settings: SETTINGS, registry: new ActiveSessionRegistry(),
    })).rejects.toThrow("injected update failure");

    expect(patches).toHaveLength(1);
    expect(patches[0]).toHaveProperty("workspaceWorktrees");
    expect(patches.every((patch) => !patch.worktree && !patch.branch)).toBe(true);
    expect(current().worktree).toBeFalsy();
    expect(current().branch).toBeFalsy();
    expect(Boolean(current().worktree)).toBe(false);
    expect(current().workspaceWorktrees).toBeUndefined();
  });

  /*
  FNXC:WorkspaceWorktree 2026-08-20-02:04:
  Grouped workspace roots must be proven through real `git worktree add` calls.
  A path-helper fixture cannot detect the task-id collision that occurs when two
  member repositories share a configured root.
  */
  it("groups real multi-repo acquisitions and protects their shared-root container from a foreign project sweep", async () => {
    fixture = await createWorkspaceFixture(["api", "web", "foreign"]);
    const sharedRoot = join(dirname(fixture.rootDir), "shared-worktrees");
    const settings = { ...SETTINGS, worktreesDir: sharedRoot };
    const { store, current } = makeFakeStore(makeTask("FN-9162"));
    const registry = new ActiveSessionRegistry();

    const api = await acquireWorkspaceRepoWorktree({
      repoRelPath: "api", workspaceRootDir: fixture.rootDir, task: current(), store, settings, registry,
    });
    const web = await acquireWorkspaceRepoWorktree({
      repoRelPath: "web", workspaceRootDir: fixture.rootDir, task: current(), store, settings, registry,
    });

    const group = workspaceWorktreeGroupSegment(fixture.rootDir);
    expect(api.worktreePath).toBe(join(sharedRoot, group, workspaceRepoSegment("api"), "fn-9162"));
    expect(web.worktreePath).toBe(join(sharedRoot, group, workspaceRepoSegment("web"), "fn-9162"));
    expect(api.worktreePath).not.toBe(web.worktreePath);
    expect(existsSync(join(api.worktreePath, ".git"))).toBe(true);
    expect(existsSync(join(web.worktreePath, ".git"))).toBe(true);
    expect(readFileSync(join(sharedRoot, group, WORKSPACE_GROUP_MARKER_FILENAME), "utf8").trim()).toBe(fixture.rootDir);

    // A non-workspace project can share the configured root. Its real cleanup
    // path must not interpret this workspace's group container as an orphan.
    const cleaned = await cleanupOrphanedWorktrees(
      fixture.repoPath("foreign"),
      { listTasks: async () => [] } as unknown as TaskStore,
      { worktreesDir: sharedRoot, workspaceMode: false },
    );
    expect(cleaned).toBe(0);
    expect(existsSync(api.worktreePath)).toBe(true);
    expect(existsSync(web.worktreePath)).toBe(true);
    expect(existsSync(join(sharedRoot, group, WORKSPACE_GROUP_MARKER_FILENAME))).toBe(true);
  });

  it("keeps the single-repo acquisition persistence contract when suppression is absent", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const initial = makeTask("FN-10");
    const { store, patches } = makeFakeStore(initial);

    const result = await acquireTaskWorktree({
      task: initial,
      rootDir: fixture.repoPath("repo-a"),
      store,
      settings: SETTINGS,
    });

    expect(patches).toContainEqual({
      worktree: result.worktreePath,
      branch: result.branch,
      branchWriteOrigin: "engine",
    });
  });
});

/*
FNXC:WorkspaceWorktree 2026-08-24-06:10:
R15: the workspace task directory segment is minted once, at first acquisition, and every later
resolution reads that pin. These tests drive the production task-level acquisition seam against the
real two-repository fixture, because the failure this pin prevents is a path disagreement between
what was recorded and what a later resolution derives.
*/
describeIfGit("workspace task directory segment pin (R15)", { timeout: 60_000 }, () => {
  let fixture: WorkspaceFixture | undefined;

  afterEach(() => fixture?.cleanup());

  it("mints the historic task-id segment at first acquisition and records it on the task", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const { store, current } = makeFakeStore(makeTask("FN-PIN-1"));

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: fixture.repos },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry: new ActiveSessionRegistry(),
    });

    expect(current().workspaceWorktreeDirSegment).toBe("fn-pin-1");
    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "fn-pin-1"));
    expect(result.taskWorktreeDir.endsWith(join(".fusion", "worktrees", current().workspaceWorktreeDirSegment!))).toBe(true);
    expect(existsSync(result.taskWorktreeDir)).toBe(true);
  });

  /*
  FNXC:WorkspaceWorktree 2026-08-24-06:11:
  The mint is a compare-and-set, so a store whose row ALREADY carries a pin (another node, or the
  sibling acquisition that won the race) must be adopted rather than overwritten — the losing caller
  has to build its paths from the winner's segment or the two disagree about one task's directory.
  */
  it("adopts a pin another writer already recorded instead of overwriting it", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const racing = makeTask("FN-PIN-5");
    (racing as Task).branch = "feature/PRD-1234-my-slug";
    const { store, current } = makeFakeStore(racing);
    (store as unknown as { pinWorkspaceWorktreeDirSegment: (id: string, segment: string) => Promise<unknown> })
      .pinWorkspaceWorktreeDirSegment = async (id: string, segment: string) => {
        expect(segment).toBe("prd-1234-my-slug");
        // The winner already pinned a different segment for this task.
        await store.updateTask(id, { workspaceWorktreeDirSegment: "won-by-another-writer" });
        return { task: current(), segment: "won-by-another-writer", minted: false };
      };

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: ["repo-a"] },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: { ...SETTINGS, worktreeNaming: "branch" },
      registry: new ActiveSessionRegistry(),
    });

    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "won-by-another-writer"));
    expect(current().workspaceWorktrees?.["repo-a"]?.worktreePath).toBe(join(result.taskWorktreeDir, "repo-a"));
  });

  /*
  FNXC:WorkspaceWorktree 2026-08-25-07:53:
  The pin never changes after it is minted. A post-mint rewrite (the earlier collision "yield") could
  always move a root that a concurrent acquisition for the SAME task was already building under, so
  the collision defense is entirely pre-mint and the pin is strictly write-once.
  */
  it("never rewrites a segment it just minted, even when a sibling turns out to hold it", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const racing = makeTask("FN-PIN-7");
    (racing as Task).branch = "feature/PRD-1234-my-slug";
    const { store, current } = makeFakeStore(racing);
    const rival = { ...makeTask("FN-PIN-6"), workspaceWorktreeDirSegment: "prd-1234-my-slug" } as Task;
    // The rival's pin becomes visible only AFTER this mint lands — the mint race the pre-mint scan
    // cannot see. The pin must stand regardless.
    let rivalVisible = false;
    const pinWrites: string[] = [];
    (store as unknown as { pinWorkspaceWorktreeDirSegment: (id: string, segment: string) => Promise<unknown> })
      .pinWorkspaceWorktreeDirSegment = async (id: string, segment: string) => {
        const existing = current().workspaceWorktreeDirSegment;
        if (typeof existing === "string" && existing.length > 0) return { task: current(), segment: existing, minted: false };
        pinWrites.push(segment);
        await store.updateTask(id, { workspaceWorktreeDirSegment: segment });
        rivalVisible = true;
        return { task: current(), segment, minted: true };
      };
    (store as unknown as { listTasks: () => Promise<Task[]> }).listTasks = async () =>
      (rivalVisible ? [rival, current()] : [current()]);

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: ["repo-a"] },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: { ...SETTINGS, worktreeNaming: "branch" },
      registry: new ActiveSessionRegistry(),
    });

    expect(pinWrites).toEqual(["prd-1234-my-slug"]);
    expect(current().workspaceWorktreeDirSegment).toBe("prd-1234-my-slug");
    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "prd-1234-my-slug"));
    expect(current().workspaceWorktrees?.["repo-a"]?.worktreePath).toBe(join(result.taskWorktreeDir, "repo-a"));
  });

  it("falls back before minting when a sibling's segment is already visible", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const second = makeTask("FN-PIN-12");
    (second as Task).branch = "feature/PRD-1234-my-slug";
    const { store, current, logs } = makeFakeStore(second);
    const holder = { ...makeTask("FN-PIN-13"), workspaceWorktreeDirSegment: "prd-1234-my-slug", column: "in-progress" } as Task;
    (store as unknown as { listTasks: () => Promise<Task[]> }).listTasks = async () => [holder, current()];

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: ["repo-a"] },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: { ...SETTINGS, worktreeNaming: "branch" },
      registry: new ActiveSessionRegistry(),
    });

    expect(current().workspaceWorktreeDirSegment).toBe("fn-pin-12");
    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "fn-pin-12"));
    expect(logs.some((line) => line.includes("sibling-collision"))).toBe(true);
  });

  it("reuses an existing pin verbatim instead of re-deriving it from the task", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const pinned = makeTask("FN-PIN-2");
    (pinned as Task).workspaceWorktreeDirSegment = "prd-1234-my-slug";
    const { store, current, patches } = makeFakeStore(pinned);

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: fixture.repos },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry: new ActiveSessionRegistry(),
    });

    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "prd-1234-my-slug"));
    expect(current().workspaceWorktreeDirSegment).toBe("prd-1234-my-slug");
    expect(patches.some((patch) => "workspaceWorktreeDirSegment" in patch)).toBe(false);
    for (const repoRelPath of fixture.repos) {
      expect(current().workspaceWorktrees?.[repoRelPath]?.worktreePath).toBe(join(result.taskWorktreeDir, repoRelPath));
    }
  });

  it("mints in the configured grouped layout as well as the unset layout", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const configuredRoot = join(fixture.rootDir, "trees-root");
    const { store, current } = makeFakeStore(makeTask("FN-PIN-3"));

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: ["repo-a"] },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: { ...SETTINGS, worktreesDir: configuredRoot },
      registry: new ActiveSessionRegistry(),
    });

    expect(current().workspaceWorktreeDirSegment).toBe("fn-pin-3");
    expect(result.taskWorktreeDir).toBe(join(configuredRoot, workspaceWorktreeGroupSegment(fixture.rootDir), "fn-pin-3"));
    expect(existsSync(result.taskWorktreeDir)).toBe(true);
  });

  it("keeps a pre-pinning task on its recorded legacy paths", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const legacy = makeTask("FN-PIN-4");
    const legacyPath = join(fixture.repoPath("repo-a"), ".worktrees", "fn-pin-4");
    (legacy as Task).workspaceWorktrees = { "repo-a": { worktreePath: legacyPath, branch: "fusion/fn-pin-4" } } as Task["workspaceWorktrees"];
    const { store, current } = makeFakeStore(legacy);
    const acquired = await acquireWorkspaceRepoWorktree({
      repoRelPath: "repo-a",
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry: new ActiveSessionRegistry(),
    });
    expect(acquired.worktreePath).toBe(legacyPath);

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: ["repo-a"] },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: SETTINGS,
      registry: new ActiveSessionRegistry(),
    });

    // Legacy classification wins: the session root stays the recorded per-repository path.
    expect(result.taskWorktreeDir).toBe(legacyPath);
    expect(current().workspaceWorktrees?.["repo-a"]?.worktreePath).toBe(legacyPath);
  });

  /*
  FNXC:WorkspaceWorktree 2026-08-24-06:10:
  Structural guard, not prose: a call site that passes a task id straight into
  resolveWorkspaceTaskWorktreeDir re-derives its own segment and reintroduces the split-directory
  failure the pin exists to prevent. Every production call site must route through
  resolveWorkspaceTaskDirSegment.
  */
  it("resolves every production workspace task directory through the pin reader", () => {
    const roots = [
      join(import.meta.dirname, "..", "..", "..", "engine", "src"),
      join(import.meta.dirname, "..", "..", "..", "core", "src"),
      join(import.meta.dirname, "..", "..", "..", "cli", "src"),
    ];
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { visit(full); continue; }
        if (!entry.name.endsWith(".ts")) continue;
        const source = readFileSync(full, "utf8");
        for (const call of source.matchAll(/resolveWorkspaceTaskWorktreeDir\(([^;]*?)\)/gs)) {
          const args = call[1];
          if (/\bresolveWorkspaceTaskDirSegment\(/.test(args)) continue;
          if (full.endsWith(join("tasks", "worktree-layout.ts"))) continue; // the definition itself
          offenders.push(`${full}: ${args.replace(/\s+/g, " ").slice(0, 120)}`);
        }
      }
    };
    for (const root of roots) visit(root);
    expect(offenders).toEqual([]);
  });
});

/*
FNXC:WorkspaceWorktree 2026-08-24-06:11:
R14/R16 at the production acquisition seam: the mode names the real directory that gets created,
and every rung of the fallback ladder lands on the task id instead of failing the acquisition.
*/
describeIfGit("ticket-derived workspace worktree directory names (R14/R16)", { timeout: 60_000 }, () => {
  let fixture: WorkspaceFixture | undefined;

  afterEach(() => fixture?.cleanup());

  const BRANCH_SETTINGS: Partial<Settings> = { ...SETTINGS, worktreeNaming: "branch" };

  function branchTask(id: string, branch: string): Task {
    const task = makeTask(id);
    (task as Task).branch = branch;
    return task;
  }

  /*
  FNXC:WorkspaceWorktree 2026-08-24-06:11:
  Core cannot import engine, so core's reserved-segment list is a forced duplicate of the engine
  container-directory constants. This drift guard lives on the engine side, where both are
  importable: a rename on either side that desyncs them stops the fallback ladder from refusing a
  name that would collide with a real container directory.
  */
  it("keeps the reserved-segment list in sync with the engine container-directory constants", () => {
    expect(WORKSPACE_RESERVED_TASK_DIR_SEGMENTS).toContain(AI_MERGE_DIRNAME);
    expect(WORKSPACE_RESERVED_TASK_DIR_SEGMENTS).toContain(WORKTREE_RECOVERY_DIRNAME);
    expect(WORKSPACE_RESERVED_TASK_DIR_SEGMENTS).toContain(WORKSPACE_GROUP_MARKER_FILENAME);
  });

  it("names the checkout after the ticket in the configured grouped layout", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const configuredRoot = join(fixture.rootDir, "trees-root");
    const { store, current } = makeFakeStore(branchTask("FN-9210", "feature/PRD-1234-my-slug"));

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: fixture.repos },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: { ...BRANCH_SETTINGS, worktreesDir: configuredRoot },
      registry: new ActiveSessionRegistry(),
    });

    expect(result.taskWorktreeDir).toBe(join(configuredRoot, workspaceWorktreeGroupSegment(fixture.rootDir), "prd-1234-my-slug"));
    expect(current().workspaceWorktreeDirSegment).toBe("prd-1234-my-slug");
    expect(existsSync(join(result.taskWorktreeDir, "repo-a"))).toBe(true);
    expect(existsSync(join(result.taskWorktreeDir, "repo-b"))).toBe(true);
  });

  it("names the checkout with worktreesDir unset, since only grouping is opt-in", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const { store, current } = makeFakeStore(branchTask("FN-9211", "feature/PRD-1234-my-slug"));

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: ["repo-a"] },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: BRANCH_SETTINGS,
      registry: new ActiveSessionRegistry(),
    });

    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "prd-1234-my-slug"));
    expect(existsSync(join(result.taskWorktreeDir, "repo-a"))).toBe(true);
  });

  it("does not move or re-derive the directory when the branch is renamed after acquisition", async () => {
    fixture = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const { store, current } = makeFakeStore(branchTask("FN-9212", "feature/PRD-1234-my-slug"));
    const first = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: fixture.repos },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: BRANCH_SETTINGS,
      registry: new ActiveSessionRegistry(),
    });
    expect(first.taskWorktreeDir.endsWith("prd-1234-my-slug")).toBe(true);

    await store.updateTask("FN-9212", { branch: "feature/PRD-9999-renamed" });
    const second = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: fixture.repos },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: BRANCH_SETTINGS,
      registry: new ActiveSessionRegistry(),
    });

    expect(second.taskWorktreeDir).toBe(first.taskWorktreeDir);
    expect(current().workspaceWorktreeDirSegment).toBe("prd-1234-my-slug");
    for (const repoRelPath of fixture.repos) {
      expect(current().workspaceWorktrees?.[repoRelPath]?.worktreePath).toBe(join(first.taskWorktreeDir, repoRelPath));
    }
  });

  it("falls back to the task id and logs why for an empty slug and a reserved name", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    for (const [id, branch, reason] of [
      ["FN-9213", "feature/---", "empty-slug"],
      ["FN-9214", "feature/.AI-Merge", "reserved-name"],
    ] as const) {
      const { store, current, logs } = makeFakeStore(branchTask(id, branch));
      const result = await acquireWorkspaceTaskWorktrees({
        workspaceConfig: { repos: ["repo-a"] },
        workspaceRootDir: fixture.rootDir,
        task: current(),
        store,
        settings: BRANCH_SETTINGS,
        registry: new ActiveSessionRegistry(),
      });
      expect(result.taskWorktreeDir, branch).toBe(join(fixture.rootDir, ".fusion", "worktrees", id.toLowerCase()));
      expect(current().workspaceWorktreeDirSegment).toBe(id.toLowerCase());
      expect(logs.some((line) => line.includes(reason)), `${branch} -> ${reason}`).toBe(true);
    }
  });

  it("gives a second task with an identical slug its own directory", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    // A done sibling counts too: its checkout survives until archive cleanup removes it.
    const sibling = makeTask("FN-9215");
    (sibling as Task).workspaceWorktreeDirSegment = "prd-1234-my-slug";
    (sibling as Task).column = "done";
    const { store, current, logs } = makeFakeStore(branchTask("FN-9216", "feature/PRD-1234-MY-SLUG"));
    (store as unknown as { listTasks: () => Promise<Task[]> }).listTasks = async () => [sibling, current()];

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: ["repo-a"] },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: BRANCH_SETTINGS,
      registry: new ActiveSessionRegistry(),
    });

    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "fn-9216"));
    expect(logs.some((line) => line.includes("sibling-collision"))).toBe(true);
  });

  it("reproduces the task-id path for task-id naming and for an unset mode", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    for (const worktreeNaming of ["task-id", undefined] as const) {
      const { store, current } = makeFakeStore(branchTask("FN-9217", "feature/PRD-1234-my-slug"));
      const result = await acquireWorkspaceTaskWorktrees({
        workspaceConfig: { repos: ["repo-a"] },
        workspaceRootDir: fixture.rootDir,
        task: current(),
        store,
        settings: { ...SETTINGS, worktreeNaming },
        registry: new ActiveSessionRegistry(),
      });
      expect(result.taskWorktreeDir, String(worktreeNaming)).toBe(join(fixture.rootDir, ".fusion", "worktrees", "fn-9217"));
    }
  });

  it("slugs the title for task-title naming", async () => {
    fixture = await createWorkspaceFixture(["repo-a"]);
    const titled = makeTask("FN-9218");
    (titled as Task).title = "Close the late acquire gap";
    const { store, current } = makeFakeStore(titled);

    const result = await acquireWorkspaceTaskWorktrees({
      workspaceConfig: { repos: ["repo-a"] },
      workspaceRootDir: fixture.rootDir,
      task: current(),
      store,
      settings: { ...SETTINGS, worktreeNaming: "task-title" },
      registry: new ActiveSessionRegistry(),
    });

    expect(result.taskWorktreeDir).toBe(join(fixture.rootDir, ".fusion", "worktrees", "close-the-late-acquire-gap"));
  });
});
