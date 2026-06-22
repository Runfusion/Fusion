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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { landWorkspaceTask, WorkspaceRepoLandBusyError } from "../merger-ai.js";
import { activeSessionRegistry } from "../active-session-registry.js";
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

describeIfGit("landWorkspaceTask — per-repo land lease (Phase C U3, KTD4)", () => {
  let fx: WorkspaceFixture;
  afterEach(() => {
    fx?.cleanup();
    activeSessionRegistry.clear();
    vi.restoreAllMocks();
  });
  beforeEach(() => activeSessionRegistry.clear());

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
});
