/*
FNXC:Workspace 2026-06-22-02:10 (Phase C U3, KTD4):
Per-repo LAND lease tests. They drive the REAL `landWorkspaceTask` against a REAL
two-repo git fixture (createWorkspaceFixture) and assert the lease seam directly on
the REAL module-level `activeSessionRegistry` singleton (FN-5048: narrow seam — we
assert registry state + a merge-agent spy, NO real concurrent processes, NO
mock-the-world; the AI merge/review agents are injected so no real AI calls happen
and the squash is a plain `git merge --squash`).

The lease is keyed by the sub-repo ABSOLUTE path under kind "workspace-repo-land".
It is for SERIALIZATION / clean-room-collision avoidance only — `advanceIntegration
BranchRef`'s CAS already makes the interleaved `update-ref` correct — so we assert
serialization behavior (one wins, the other fast-fails) and that the lease never leaks.

Coverage (FN-5893 surfaces):
- concurrency: two tasks landing the SAME sub-repo → one acquires the land lease,
  the other FAST-FAILS with WorkspaceRepoLandBusyError; no interleaved update-ref on
  that repo's ref (the loser advances nothing). Lease kind/path asserted while held.
- independence: disjoint sub-repos (task1→repo-a, task2→repo-b) → both proceed, no
  false serialization (neither sees the other's lease path).
- cleanup: a repo land that THROWS → the lease for that path is released (not stuck),
  so a subsequent land of the same repo can acquire it.
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { landSquash, landWorkspaceTask, WorkspaceMergeDispatchSupersededError, WorkspaceRepoLandBusyError } from "../merge/merger-ai.js";
import { ensureTenancyFenceRef, mergeDispatchFenceRef, WorkspaceFenceRefError } from "../merge/workspace-fence-ref.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

const BRANCH = "fusion/fn-3003";
const LAND_KIND = "workspace-repo-land";

function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

interface RecordingStore extends EventEmitter {
  task: Task;
  moveTaskCalls: Array<{ id: string; column: string }>;
}

/** A store that persists workspaceWorktrees/mergeDetails on one in-memory task. */
function createStore(task: Task): TaskStore & RecordingStore {
  const emitter = new EventEmitter();
  const moveTaskCalls: Array<{ id: string; column: string }> = [];
  const store = Object.assign(emitter, {
    task,
    moveTaskCalls,
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(store.task, patch);
      return undefined;
    }),
    mergeWorkspaceWorktreeEntry: vi.fn(async (
      _id: string,
      repoRelPath: string,
      patch: Partial<NonNullable<Task["workspaceWorktrees"]>[string]>,
      options?: { requireExistingEntry?: boolean },
    ) => {
      const current = store.task.workspaceWorktrees ?? {};
      const existing = current[repoRelPath];
      if (options?.requireExistingEntry && !existing) return store.task;
      store.task.workspaceWorktrees = { ...current, [repoRelPath]: { ...existing, ...patch } };
      return store.task;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn(async () => store.task),
    moveTask: vi.fn((id: string, column: string) => {
      moveTaskCalls.push({ id, column });
      store.task.column = column as Task["column"];
      return Promise.resolve(store.task);
    }),
    upsertTaskCommitAssociation: vi.fn().mockResolvedValue(undefined),
    accumulateTokenUsage: vi.fn().mockResolvedValue(undefined),
  }) as unknown as TaskStore & RecordingStore;
  return store;
}

/** Add a real `fusion/<id>` branch to a sub-repo with one own non-conflicting commit. */
function addRepoBranchWithEdit(fx: WorkspaceFixture, repoRel: string, taskId: string, content: string): void {
  const repoDir = fx.repoPath(repoRel);
  const worktreePath = path.join(repoDir, `.wt-${taskId}`);
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
  configureIdentity(worktreePath);
  writeFileSync(path.join(worktreePath, "feature.txt"), content, "utf-8");
  execSync("git add feature.txt", { cwd: worktreePath, stdio: "pipe" });
  execSync(`git commit -m "feat(${taskId}): add feature in ${repoRel}"`, { cwd: worktreePath, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${worktreePath}`);
}

/** A merge agent that performs the real squash in the clean room (no AI). */
function squashMergeAgent(branch: string, onEnter?: (cwd: string) => void | Promise<void>) {
  return async (cwd: string): Promise<void> => {
    if (onEnter) await onEnter(cwd);
    configureIdentity(cwd);
    try {
      execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    } catch {
      // squash reported conflicts — fall through to the unmerged check.
    }
    const unmerged = execSync("git ls-files -u", { cwd, encoding: "utf-8" }).trim();
    if (unmerged.length > 0) throw new Error("merge conflict: unresolved paths in clean room");
    const staged = execSync("git diff --cached --name-only", { cwd, encoding: "utf-8" }).trim();
    if (staged.length === 0) return;
    execSync(`git commit -m "${branch}: squashed"`, { cwd, stdio: "pipe" });
  };
}

const approveReviewAgent = async (): Promise<string> => "REVIEW_VERDICT: approve";

function makeTask(id: string, workspaceWorktrees: Task["workspaceWorktrees"]): Task {
  return {
    id,
    title: "Workspace merge task",
    description: "",
    column: "in-review",
    branch: BRANCH,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workspaceWorktrees,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

const pgDescribeIfGit = hasGit ? pgDescribe : describe.skip;

/*
FNXC:WorkspaceMergeDispatch 2026-08-15-10:09:
The post-push finalizer must be proven through the production workspace land path and a real
PostgreSQL owner-and-fence reclaim. A mocked guarded writer cannot show that landWorkspaceTask
reaches the guarded terminal mutation after git has advanced the integration ref.
*/
pgDescribeIfGit("workspace land dispatch finalization (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workspace_land_dispatch_finalization",
  });
  let fx: WorkspaceFixture;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    fx = await createWorkspaceFixture(["repo-a"]);
  });
  afterEach(async () => {
    fx?.cleanup();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("rejects a predecessor's real repo-b push after a successor republished its dispatch fence", async () => {
    fx.cleanup();
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const store = h.store();
    const taskId = "FN-9059-PG-REPO-B";
    for (const repoRel of fx.repos) {
      const remote = path.join(fx.rootDir, `${repoRel}.git`);
      execSync(`git init --bare ${remote}`, { stdio: "pipe" });
      fx.git(repoRel, `git remote add origin ${remote}`);
      fx.git(repoRel, "git push -u origin main");
      addRepoBranchWithEdit(fx, repoRel, taskId, `${repoRel} stale dispatch push\n`);
    }
    await store.createTaskWithReservedId(
      { description: "cross-node repo-b dispatch fence", column: "in-review" },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(taskId, {
      branch: BRANCH,
      workspaceWorktrees: Object.fromEntries(fx.repos.map((repoRel) => [repoRel, {
        worktreePath: fx.repoPath(repoRel), branch: BRANCH,
      }])),
    } as Partial<Task>);
    const task = (await store.getTask(taskId))!;
    const predecessor = await store.acquireWorkspaceLease({
      leaseKey: `merge-dispatch:${taskId}`,
      kind: "merge-dispatch",
      owner: { taskId, nodeId: "node-b", incarnationId: "inc-b" },
      leaseMs: 60_000,
    });
    if (predecessor.outcome === "conflict") throw new Error("expected predecessor dispatch lease");
    const repoBTip = fx.git("repo-b", "git rev-parse refs/heads/main");
    let successorClaimed = false;
    let mergeAgentCalls = 0;

    await expect(landWorkspaceTask(store, task, fx.rootDir, {
      workspaceDispatchFence: predecessor.handle,
    }, {
      mergeAgent: squashMergeAgent(BRANCH, async () => {
        mergeAgentCalls++;
        if (mergeAgentCalls !== 2) return;
        await h.adminSql().unsafe(`UPDATE project.workspace_coordination_leases
          SET expires_at = '${new Date(Date.now() - 1_000).toISOString()}'
          WHERE lease_key = '${predecessor.handle.leaseKey}'`);
        const successor = await store.acquireWorkspaceLease({
          leaseKey: predecessor.handle.leaseKey,
          kind: "merge-dispatch",
          owner: { taskId, nodeId: "node-a", incarnationId: "inc-a" },
          leaseMs: 60_000,
        });
        expect(successor.outcome).toBe("reclaimed-expired");
        let successorHandle = successor.handle;
        for (const repoRel of fx.repos) {
          successorHandle = await ensureTenancyFenceRef({
            store,
            handle: successorHandle,
            claimOutcome: successor.outcome,
            remote: "origin",
            cwd: fx.repoPath(repoRel),
            fenceRefName: mergeDispatchFenceRef(taskId),
          });
        }
        successorClaimed = true;
      }),
      reviewAgent: approveReviewAgent,
    })).rejects.toBeInstanceOf(WorkspaceRepoLandBusyError);

    expect(successorClaimed).toBe(true);
    // FNXC:WorkspaceMergeDispatch 2026-08-15-10:09: repo-b's target was unchanged; git refused only its stale dispatch ref pin.
    expect(fx.git("repo-b", "git rev-parse refs/heads/main")).toBe(repoBTip);
    expect(fx.git("repo-b", `git ls-remote origin ${mergeDispatchFenceRef(taskId)}`)).toMatch(/^[0-9a-f]{40,64}\s/);
  });

  it("leaves a real pushed land unfinalized when a successor reclaims the dispatch fence", async () => {
    const store = h.store();
    const taskId = "FN-9059-PG-DISPATCH";
    const repo = fx.repoPath("repo-a");
    const remote = path.join(fx.rootDir, "origin.git");
    execSync(`git init --bare ${remote}`, { stdio: "pipe" });
    fx.git("repo-a", `git remote add origin ${remote}`);
    fx.git("repo-a", "git push -u origin main");
    addRepoBranchWithEdit(fx, "repo-a", taskId, "production finalization fence\n");

    await store.createTaskWithReservedId(
      { description: "production workspace dispatch finalization", column: "in-review" },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(taskId, {
      branch: BRANCH,
      workspaceWorktrees: { "repo-a": { worktreePath: repo, branch: BRANCH } },
    } as Partial<Task>);
    const task = (await store.getTask(taskId))!;
    const tipBefore = fx.git("repo-a", "git rev-parse refs/heads/main");
    const predecessor = await store.acquireWorkspaceLease({
      leaseKey: `merge-dispatch:${taskId}`,
      kind: "merge-dispatch",
      owner: { taskId, nodeId: "node-b", incarnationId: "inc-b" },
      leaseMs: 60_000,
    });
    if (predecessor.outcome === "conflict") throw new Error("expected predecessor dispatch lease");

    const mergeWorkspaceWorktreeEntry = store.mergeWorkspaceWorktreeEntry.bind(store);
    let successorClaimed = false;
    let terminalCallbackEntered = false;
    const realWithValidWorkspaceLease = store.withValidWorkspaceLease.bind(store);
    const finalizer = vi.spyOn(store, "withValidWorkspaceLease").mockImplementation(async (handle, callback) =>
      realWithValidWorkspaceLease(handle, async () => {
        terminalCallbackEntered = true;
        return callback();
      }));
    vi.spyOn(store, "mergeWorkspaceWorktreeEntry").mockImplementation(async (...args) => {
      const result = await mergeWorkspaceWorktreeEntry(...args);
      if (!successorClaimed && args[0] === taskId && args[1] === "repo-a") {
        successorClaimed = true;
        await h.adminSql().unsafe(`UPDATE project.workspace_coordination_leases
          SET expires_at = '${new Date(Date.now() - 1_000).toISOString()}'
          WHERE lease_key = '${predecessor.handle.leaseKey}'`);
        const successor = await store.acquireWorkspaceLease({
          leaseKey: predecessor.handle.leaseKey,
          kind: "merge-dispatch",
          owner: { taskId, nodeId: "node-a", incarnationId: "inc-a" },
          leaseMs: 60_000,
        });
        expect(successor.outcome).toBe("reclaimed-expired");
      }
      return result;
    });

    await expect(landWorkspaceTask(store, task, fx.rootDir, {
      workspaceDispatchFence: predecessor.handle,
    }, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    })).rejects.toBeInstanceOf(WorkspaceMergeDispatchSupersededError);

    expect(successorClaimed).toBe(true);
    // FNXC:WorkspaceMergeDispatch 2026-08-15-10:09: the real store rejects before invoking the finalizer callback.
    expect(finalizer).toHaveBeenCalledOnce();
    expect(terminalCallbackEntered).toBe(false);
    expect((await store.getTask(taskId))!.column).toBe("in-review");
    expect((await store.getTask(taskId))!.mergeDetails).toBeUndefined();
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).not.toBe(tipBefore);
  });
});

describeIfGit("landWorkspaceTask — per-repo land lease (Phase C U3, KTD4)", () => {
  let fx: WorkspaceFixture;
  afterEach(() => {
    fx?.cleanup();
    activeSessionRegistry.clear();
    vi.restoreAllMocks();
  });
  beforeEach(() => activeSessionRegistry.clear());

  it("rejects a superseded merge-dispatch pin even when the integration tip is unchanged", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const repo = fx.repoPath("repo-a");
    const remote = path.join(fx.rootDir, "origin.git");
    execSync(`git init --bare ${remote}`, { stdio: "pipe" });
    fx.git("repo-a", `git remote add origin ${remote}`);
    fx.git("repo-a", "git push -u origin main");
    fx.git("repo-a", "git checkout -b fusion/fn-9059-fence");
    writeFileSync(path.join(repo, "fence.txt"), "fenced\n", "utf-8");
    fx.git("repo-a", "git add fence.txt && git commit -m 'fenced source'");

    const tipSha = fx.git("repo-a", "git rev-parse origin/main");
    const sourceSha = fx.git("repo-a", "git rev-parse HEAD");
    const tree = fx.git("repo-a", "git mktree </dev/null");
    const landFenceSha = fx.git("repo-a", `git commit-tree ${tree} -m land-fence`);
    const staleDispatchSha = fx.git("repo-a", `git commit-tree ${tree} -m stale-dispatch`);
    const successorDispatchSha = fx.git("repo-a", `git commit-tree ${tree} -m successor-dispatch`);
    const landRef = "refs/fusion/workspace-lease/test-repo";
    const dispatchRef = "refs/fusion/merge-dispatch/FN-9059";
    fx.git("repo-a", `git push origin ${landFenceSha}:${landRef} ${staleDispatchSha}:${dispatchRef}`);
    fx.git("repo-a", `git push --force-with-lease=${dispatchRef}:${staleDispatchSha} origin ${successorDispatchSha}:${dispatchRef}`);

    /*
    FNXC:WorkspaceMergeDispatch 2026-08-15-22:55:
    A dispatch lease renewal may never run while a merge body is suspended. The resource must
    reject its atomic ref advance after a successor republishes the task fence, even when main
    still equals the predecessor's observed tip.
    */
    await expect(landSquash({
      projectRootDir: repo,
      mergeRoot: repo,
      integrationBranch: "main",
      tipSha,
      squashSha: sourceSha,
      taskId: "FN-9059",
      audit: { git: vi.fn().mockResolvedValue(undefined) } as any,
      workspaceFence: { remote: "origin", fenceRefName: landRef, fenceRefSha: landFenceSha },
      workspaceDispatchFence: { fenceRefName: dispatchRef, fenceRefSha: staleDispatchSha },
    })).rejects.toBeInstanceOf(WorkspaceFenceRefError);
    expect(fx.git("repo-a", "git ls-remote origin refs/heads/main").split(/\s+/)[0]).toBe(tipSha);
  });

  it("publishes one dispatch tenancy pin to every sub-repo remote before fenced pushes", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    for (const repoRel of fx.repos) {
      const remote = path.join(fx.rootDir, `${repoRel}.git`);
      execSync(`git init --bare ${remote}`, { stdio: "pipe" });
      fx.git(repoRel, `git remote add origin ${remote}`);
      fx.git(repoRel, "git push -u origin main");
      addRepoBranchWithEdit(fx, repoRel, "FN-9059", `${repoRel} dispatch fence\n`);
    }
    const task = makeTask("FN-9059", Object.fromEntries(fx.repos.map((repoRel) => [repoRel, {
      worktreePath: fx.repoPath(repoRel), branch: BRANCH,
    }])));
    const store = createStore(task);
    let token = 0n;
    Object.assign(store, {
      acquireWorkspaceLease: vi.fn(async (input: any) => ({
        outcome: "acquired",
        handle: {
          leaseKey: input.leaseKey, kind: input.kind, owner: input.owner,
          fenceToken: ++token,
        },
      })),
      recordWorkspaceLeaseFenceRef: vi.fn(async (input: any) => ({
        ...input.handle, fenceRefName: input.fenceRefName, fenceRefSha: input.fenceRefSha,
      })),
      releaseWorkspaceLease: vi.fn().mockResolvedValue(true),
      recordWorkspaceLandIntent: vi.fn().mockResolvedValue({ outcome: "valid" }),
      resolveWorkspaceLandIntent: vi.fn(async (input: any) => {
        await input.persistLandedSha();
        return { outcome: "resolved" };
      }),
    });
    const dispatchHandle = {
      leaseKey: "merge-dispatch:FN-9059", kind: "merge-dispatch" as const,
      owner: { taskId: "FN-9059", nodeId: "node-a", incarnationId: "inc-a" }, fenceToken: ++token,
    };

    /*
    FNXC:WorkspaceMergeDispatch 2026-08-15-09:46:
    A real workspace root is deliberately not a git checkout. Each sub-repo remote must receive
    the dispatch ref before its own atomic push; publishing only at the root cannot fence either.
    */
    const dispatchRef = "refs/fusion/merge-dispatch/FN-9059";
    const result = await landWorkspaceTask(store, task, fx.rootDir, {
      workspaceDispatchFence: dispatchHandle,
    }, {
      mergeAgent: squashMergeAgent(BRANCH, () => {
        /*
        FNXC:WorkspaceMergeDispatch 2026-08-15-10:18:
        The first repository's merge agent is reached only after dispatch fencing has covered every
        target remote. This ordering catches a successor that otherwise protects repo-a while a
        predecessor can still resume and push untouched repo-b.
        */
        expect(fx.git("repo-b", `git ls-remote origin ${dispatchRef}`)).toMatch(/^[0-9a-f]{40,64}\s/);
      }),
      reviewAgent: approveReviewAgent,
    });

    expect(result.allLanded).toBe(true);
    for (const repoRel of fx.repos) {
      expect(fx.git(repoRel, `git ls-remote origin ${dispatchRef}`)).toMatch(/^[0-9a-f]{40,64}\s/);
    }
  });

  it("does not finalize after a dispatch lease expires following a successful workspace push", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "FN-9059", "fenced terminal persist\n");
    const repoAbs = fx.repoPath("repo-a");
    const task = makeTask("FN-9059", { "repo-a": { worktreePath: repoAbs, branch: BRANCH } });
    const tipBefore = fx.git("repo-a", "git rev-parse main");
    const store = createStore(task);
    const terminalWrite = vi.fn().mockRejectedValue(new Error("Workspace lease is no longer valid"));
    Object.assign(store, { withValidWorkspaceLease: terminalWrite });

    /*
    FNXC:WorkspaceMergeDispatch 2026-08-15-09:37:
    Simulate the renewal callback never firing: a successor has already reclaimed dispatch after
    the ref advance. The guarded finalizer callback must never run, so stale work cannot mark the
    task done even though the landed commit remains available to crash recovery.
    */
    await expect(landWorkspaceTask(store, task, fx.rootDir, {
      workspaceDispatchFence: {
        leaseKey: "merge-dispatch:FN-9059",
        kind: "merge-dispatch",
        owner: { taskId: "FN-9059", nodeId: "node-b", incarnationId: "inc-b" },
        fenceToken: 1n,
      },
    }, { mergeAgent: squashMergeAgent(BRANCH), reviewAgent: approveReviewAgent })).rejects.toBeInstanceOf(WorkspaceMergeDispatchSupersededError);

    expect(terminalWrite).toHaveBeenCalledOnce();
    expect(store.moveTaskCalls).toEqual([]);
    expect(store.task.mergeDetails).toBeUndefined();
    expect(fx.git("repo-a", "git rev-parse main")).not.toBe(tipBefore);
  });

  it("concurrency: two tasks landing the SAME sub-repo serialize — one acquires the land lease, the other fast-fails (no interleaved update-ref)", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "FN-3001", "a feature\n");
    const repoAbs = fx.repoPath("repo-a");

    const task1 = makeTask("FN-3001", { "repo-a": { worktreePath: repoAbs, branch: BRANCH } });
    const task2 = makeTask("FN-3001", { "repo-a": { worktreePath: repoAbs, branch: BRANCH } });
    // Distinct task IDs so the lease owner check (taskId !== holder) triggers.
    task2.id = "FN-3002";
    const store1 = createStore(task1);
    const store2 = createStore(task2);

    let loserError: unknown;
    const tipBefore = fx.git("repo-a", "git rev-parse refs/heads/main");

    // task1's merge agent blocks until task2 has tried (and failed) to acquire the
    // land lease for the SAME sub-repo path. While task1 holds the lease we assert it
    // is registered under the right kind + path; task2 fast-fails with the busy error.
    const winner = landWorkspaceTask(store1, store1.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH, async () => {
        // task1 now holds the land lease for repo-a.
        const held = activeSessionRegistry.lookupByPath(repoAbs);
        expect(held?.kind).toBe(LAND_KIND);
        expect(held?.taskId).toBe("FN-3001");

        // task2 attempts the same sub-repo concurrently → must fast-fail.
        try {
          await landWorkspaceTask(store2, store2.task, fx.rootDir, {}, {
            mergeAgent: squashMergeAgent(BRANCH),
            reviewAgent: approveReviewAgent,
          });
        } catch (err) {
          loserError = err;
        }
        // The loser advanced NOTHING: the ref is still at the pre-land tip.
        expect(fx.git("repo-a", "git rev-parse refs/heads/main")).toBe(tipBefore);
      }),
      reviewAgent: approveReviewAgent,
    });

    const result = await winner;

    // Winner landed.
    expect(result.allLanded).toBe(true);
    expect(result.repos[0].status).toBe("landed");
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).not.toBe(tipBefore);

    // Loser fast-failed with the retryable busy error (serialized, not broken).
    expect(loserError).toBeInstanceOf(WorkspaceRepoLandBusyError);
    expect((loserError as WorkspaceRepoLandBusyError).retryable).toBe(true);
    expect((loserError as WorkspaceRepoLandBusyError).holderTaskId).toBe("FN-3001");

    // Lease released after the winner finished — no leak.
    expect(activeSessionRegistry.lookupByPath(repoAbs)).toBeNull();
  });

  it("independence: disjoint sub-repos land without contention (no false serialization)", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranchWithEdit(fx, "repo-a", "FN-3001", "a feature\n");
    addRepoBranchWithEdit(fx, "repo-b", "FN-3002", "b feature\n");
    const repoAAbs = fx.repoPath("repo-a");
    const repoBAbs = fx.repoPath("repo-b");

    const task1 = makeTask("FN-3001", { "repo-a": { worktreePath: repoAAbs, branch: BRANCH } });
    const task2 = makeTask("FN-3002", { "repo-b": { worktreePath: repoBAbs, branch: BRANCH } });
    const store1 = createStore(task1);
    const store2 = createStore(task2);

    let task2Error: unknown;
    let task2Landed = false;

    // task1 lands repo-a; mid-land it kicks off task2 landing the DISJOINT repo-b.
    // task2 leases a DIFFERENT path, so it must NOT serialize against task1.
    const t1 = landWorkspaceTask(store1, store1.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH, async () => {
        // While task1 holds repo-a's lease, repo-b's lease is unheld.
        expect(activeSessionRegistry.lookupByPath(repoAAbs)?.kind).toBe(LAND_KIND);
        expect(activeSessionRegistry.lookupByPath(repoBAbs)).toBeNull();
        try {
          const r2 = await landWorkspaceTask(store2, store2.task, fx.rootDir, {}, {
            mergeAgent: squashMergeAgent(BRANCH),
            reviewAgent: approveReviewAgent,
          });
          task2Landed = r2.allLanded;
        } catch (err) {
          task2Error = err;
        }
      }),
      reviewAgent: approveReviewAgent,
    });

    const r1 = await t1;

    // Both proceeded — no false serialization.
    expect(task2Error).toBeUndefined();
    expect(task2Landed).toBe(true);
    expect(r1.allLanded).toBe(true);
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).not.toBe(
      fx.git("repo-a", "git rev-parse fusion/fn-3003^"),
    );
    // Both leases released.
    expect(activeSessionRegistry.lookupByPath(repoAAbs)).toBeNull();
    expect(activeSessionRegistry.lookupByPath(repoBAbs)).toBeNull();
  });

  it("cleanup: a land failure releases the lease (not stuck) so a subsequent land can acquire", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "FN-3001", "a feature\n");
    const repoAbs = fx.repoPath("repo-a");

    const task = makeTask("FN-3001", { "repo-a": { worktreePath: repoAbs, branch: BRANCH } });
    const store = createStore(task);

    // A merge agent that throws → landOneRepo fails → the per-repo land lease finally
    // must release the lease even on failure.
    const throwingAgent = async (): Promise<void> => {
      // Lease is held at this point.
      expect(activeSessionRegistry.lookupByPath(repoAbs)?.kind).toBe(LAND_KIND);
      throw new Error("synthetic clean-room failure");
    };

    const failed = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: throwingAgent,
      reviewAgent: approveReviewAgent,
    });
    expect(failed.allLanded).toBe(false);
    expect(failed.repos[0].status).toBe("failed");
    // Lease was released despite the failure — NOT stuck.
    expect(activeSessionRegistry.lookupByPath(repoAbs)).toBeNull();

    // A subsequent land of the SAME repo can acquire (real squash this time).
    const retry = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });
    expect(retry.allLanded).toBe(true);
    expect(retry.repos[0].status).toBe("landed");
    expect(activeSessionRegistry.lookupByPath(repoAbs)).toBeNull();
  });

  /*
  FNXC:Workspace 2026-06-22-04:10 (Phase C review A2 — taskId-aware lease across kinds):
  A FOREIGN-task holder of ANY kind on the sub-repo path is contention for the land
  busy-check — not only a "workspace-repo-land" holder. Here an EXECUTING task's
  "workspace-repo-acquire" entry sits on the path; a MERGING task's land must FAST-FAIL
  with WorkspaceRepoLandBusyError and must NOT clobber the foreign entry.
  */
  it("a foreign-task acquire-lease holder is land contention (busy error) and is NOT clobbered", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "FN-3001", "a feature\n");
    const repoAbs = fx.repoPath("repo-a");

    // An EXECUTING task (FN-9001) holds an acquire lease on the shared sub-repo path.
    activeSessionRegistry.registerPath(repoAbs, {
      taskId: "FN-9001",
      kind: "workspace-repo-acquire",
      ownerKey: "workspace-repo-acquire",
    });
    const tipBefore = fx.git("repo-a", "git rev-parse refs/heads/main");

    // The MERGING task (FN-3001) tries to land the SAME sub-repo.
    const task = makeTask("FN-3001", { "repo-a": { worktreePath: repoAbs, branch: BRANCH } });
    const store = createStore(task);

    let landError: unknown;
    try {
      await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
        mergeAgent: squashMergeAgent(BRANCH),
        reviewAgent: approveReviewAgent,
      });
    } catch (err) {
      landError = err;
    }

    // Fast-failed with the retryable busy error — even though the holder kind differs.
    expect(landError).toBeInstanceOf(WorkspaceRepoLandBusyError);
    expect((landError as WorkspaceRepoLandBusyError).holderTaskId).toBe("FN-9001");
    // The foreign acquire entry was NOT clobbered — still owned by FN-9001, same kind.
    const stillHeld = activeSessionRegistry.lookupByPath(repoAbs);
    expect(stillHeld?.taskId).toBe("FN-9001");
    expect(stillHeld?.kind).toBe("workspace-repo-acquire");
    // The merging task advanced NOTHING and its status was reset off 'merging' (A3).
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).toBe(tipBefore);
    expect(store.task.status ?? null).toBeNull();
  });
});
