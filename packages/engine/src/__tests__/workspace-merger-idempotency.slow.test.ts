/*
FNXC:Workspace 2026-06-22-00:30 (Phase C U2, KTD3):
Per-repo landed-predicate + finalize-once + idempotent-retry tests. They drive the REAL
`landWorkspaceTask` against a REAL two-repo git fixture (createWorkspaceFixture) under a
NON-git workspace root, asserting LOCAL integration-ref shas directly (FN-5048: real git
only where the invariant requires it; the AI merge/review agents are injected so NO real
AI calls happen and the squash is a plain `git merge --squash`). The retry/park decision
is tested via the engine's narrow exported seam `shouldRetryWorkspacePartialLand` with
fake timers — NOT by spinning real engine retries.

Coverage (FN-5893 surfaces):
- idempotency: re-run after repo A landed + repo B failed → A is SKIPPED (its integration
  ref does NOT advance a second time — assert the ref sha is unchanged), B is retried.
- predicate: landed predicate true when branch tip is an ancestor of integration tip;
  false otherwise (ref rebuilt / no landedSha).
- no premature done: finalizeTask/move-done runs EXACTLY ONCE, only after BOTH repos land
  — assert the task is NOT moved done after the first repo (partial run).
- completion: all repos landed → task reaches done with aggregate mergeDetails
  (workspaceLandedShas map + representative commitSha).
- retry/park: a partial-land failure consumes one mergeRetry; after MAX it parks
  (shouldRetryWorkspacePartialLand boundary, fake timers).
*/
/*
FNXC:TestVelocity 2026-07-14-19:10:
Tier multi-repo real-git landWorkspaceTask suite into engine-slow (FN-5048). ~12s wall-time with createWorkspaceFixture.
*/

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { landWorkspaceTask, WorkspacePartialLandError } from "../merge/merger-ai.js";
import { shouldRetryAutoMergeConflict } from "../project-engine.js";

/*
FNXC:Workspace 2026-06-22-05:10 (Phase C review B6):
`shouldRetryWorkspacePartialLand` was collapsed into `shouldRetryAutoMergeConflict` via the
`skipAutoResolveCheck` flag (one place owns the resolveMaxAutoMergeRetries arithmetic). The
workspace partial-land decision is `shouldRetryAutoMergeConflict(retries, settings, { skipAutoResolveCheck: true })`.
*/
const shouldRetryWorkspacePartialLand = (
  currentRetries: number,
  settings: { maxAutoMergeRetries?: unknown } | null | undefined,
) => shouldRetryAutoMergeConflict(currentRetries, settings, { skipAutoResolveCheck: true });
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

const TASK_ID = "FN-2002";
const BRANCH = "fusion/fn-2002";

function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

interface RecordingStore extends EventEmitter {
  task: Task;
  moveTaskCalls: Array<{ id: string; column: string }>;
  emitted: Array<{ event: string; payload: unknown }>;
}

/**
 * A store that PERSISTS workspaceWorktrees + mergeDetails updates on a single in-memory
 * task and returns it from getTask, so the landed-predicate retry reads back the
 * `landedSha` that landWorkspaceTask wrote (real fresh-read-then-merge behavior).
 */
function createStore(task: Task, settings: Record<string, unknown> = {}): TaskStore & RecordingStore {
  const emitter = new EventEmitter();
  const moveTaskCalls: Array<{ id: string; column: string }> = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const realEmit = emitter.emit.bind(emitter);
  const store = Object.assign(emitter, {
    task,
    moveTaskCalls,
    emitted,
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false, ...settings }),
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
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
      return realEmit(event, payload);
    },
  }) as unknown as TaskStore & RecordingStore;
  return store;
}

/** Add a real `fusion/<id>` branch to a sub-repo with one own non-conflicting commit. */
function addRepoBranchWithEdit(fx: WorkspaceFixture, repoRel: string, content: string): void {
  const repoDir = fx.repoPath(repoRel);
  const worktreePath = path.join(repoDir, ".wt-branch");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
  configureIdentity(worktreePath);
  writeFileSync(path.join(worktreePath, "feature.txt"), content, "utf-8");
  execSync("git add feature.txt", { cwd: worktreePath, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): add feature in ${repoRel}"`, { cwd: worktreePath, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${worktreePath}`);
}

/** Make a sub-repo's integration tip + task branch BOTH edit README → squash conflicts. */
function makeConflictingRepo(fx: WorkspaceFixture, repoRel: string): void {
  const repoDir = fx.repoPath(repoRel);
  const worktreePath = path.join(repoDir, ".wt-conflict");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
  configureIdentity(worktreePath);
  writeFileSync(path.join(worktreePath, "README.md"), "# branch-side change\n", "utf-8");
  execSync("git add README.md", { cwd: worktreePath, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): branch README"`, { cwd: worktreePath, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${worktreePath}`);
  writeFileSync(path.join(repoDir, "README.md"), "# main-side change\n", "utf-8");
  fx.git(repoRel, "git add README.md");
  fx.git(repoRel, 'git commit -m "main diverge README"');
}

/** Resolve repo-b's conflict by replacing the conflicting README content (no markers). */
function resolveConflictInRepo(fx: WorkspaceFixture, repoRel: string): void {
  // Re-point the task branch so the squash no longer conflicts: drop the branch's
  // README edit and add a clean feature file instead.
  const repoDir = fx.repoPath(repoRel);
  fx.git(repoRel, `git branch -D ${BRANCH}`);
  const worktreePath = path.join(repoDir, ".wt-resolved");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
  configureIdentity(worktreePath);
  writeFileSync(path.join(worktreePath, "feature.txt"), "resolved feature\n", "utf-8");
  execSync("git add feature.txt", { cwd: worktreePath, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): resolved"`, { cwd: worktreePath, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${worktreePath}`);
}

/** A merge agent that performs the real squash in the clean room (no AI). */
function squashMergeAgent(branch: string) {
  return async (cwd: string): Promise<void> => {
    configureIdentity(cwd);
    try {
      execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    } catch {
      // squash reported conflicts — fall through to the unmerged check.
    }
    const unmerged = execSync("git ls-files -u", { cwd, encoding: "utf-8" }).trim();
    if (unmerged.length > 0) {
      throw new Error("merge conflict: unresolved paths in clean room");
    }
    const staged = execSync("git diff --cached --name-only", { cwd, encoding: "utf-8" }).trim();
    if (staged.length === 0) return;
    execSync(`git commit -m "${branch}: squashed"`, { cwd, stdio: "pipe" });
  };
}

const approveReviewAgent = async (): Promise<string> => "REVIEW_VERDICT: approve";

function makeTask(workspaceWorktrees: Task["workspaceWorktrees"]): Task {
  return {
    id: TASK_ID,
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

describeIfGit("landWorkspaceTask — landed predicate + finalize-once + idempotent retry (Phase C U2)", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("idempotency: re-run after A landed + B failed skips A (ref unchanged) and retries B", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    makeConflictingRepo(fx, "repo-b");

    const task = makeTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    const store = createStore(task);

    // First run: A lands, B conflicts → partial.
    const first = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });
    expect(first.allLanded).toBe(false);
    expect(first.finalized).toBe(false);
    const tipAAfterFirst = fx.git("repo-a", "git rev-parse refs/heads/main");
    // A's landedSha was persisted onto the task entry.
    expect(store.task.workspaceWorktrees!["repo-a"].landedSha).toBe(tipAAfterFirst);
    // Not moved done on a partial land.
    expect(store.moveTaskCalls).toHaveLength(0);

    // Operator resolves repo B's conflict, then the merge is re-run (auto-retry).
    resolveConflictInRepo(fx, "repo-b");

    const second = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });

    // A was SKIPPED (already landed): its integration ref did NOT advance a second time.
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).toBe(tipAAfterFirst);
    const repoA = second.repos.find((r) => r.repo === "repo-a")!;
    expect(repoA.alreadyLanded).toBe(true);
    expect(repoA.status).toBe("landed");
    // B was retried and landed this time.
    const repoB = second.repos.find((r) => r.repo === "repo-b")!;
    expect(repoB.status).toBe("landed");
    expect(repoB.alreadyLanded).toBeFalsy();
    expect(second.allLanded).toBe(true);
    // Finalize-once ran on the completing run.
    expect(second.finalized).toBe(true);
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "done" }]);
  });

  it("predicate: landedSha that is an ancestor of the integration tip reads as landed; a non-ancestor does not", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    const task = makeTask({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } });
    const store = createStore(task);

    // Land repo-a once.
    const first = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });
    expect(first.allLanded).toBe(true);
    const landedSha = store.task.workspaceWorktrees!["repo-a"].landedSha!;
    const tip = fx.git("repo-a", "git rev-parse refs/heads/main");
    // landedSha == tip → ancestor-or-equal → landed. Advance main with an UNRELATED
    // commit; the landedSha is still an ancestor, so it must STILL read as landed.
    writeFileSync(path.join(fx.repoPath("repo-a"), "unrelated.txt"), "x\n", "utf-8");
    fx.git("repo-a", "git add unrelated.txt");
    fx.git("repo-a", 'git commit -m "unrelated advance"');
    expect(fx.git("repo-a", "git merge-base --is-ancestor " + landedSha + " refs/heads/main && echo yes").trim()).toBe("yes");

    // Re-run: predicate true (ancestor) → repo skipped, no re-land.
    const tipBeforeRerun = fx.git("repo-a", "git rev-parse refs/heads/main");
    const second = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });
    expect(second.repos[0].alreadyLanded).toBe(true);
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).toBe(tipBeforeRerun);

    // Non-ancestor: reset main to before the landedSha → landedSha no longer reachable →
    // predicate false → the repo re-lands.
    void tip;
    fx.git("repo-a", "git reset --hard HEAD~2"); // before the squash + unrelated commit
    const tipReset = fx.git("repo-a", "git rev-parse refs/heads/main");
    expect(fx.git("repo-a", `git merge-base --is-ancestor ${landedSha} refs/heads/main || echo no`).trim()).toBe("no");
    const third = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });
    expect(third.repos[0].alreadyLanded).toBeFalsy();
    expect(third.repos[0].status).toBe("landed");
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).not.toBe(tipReset);
  });

  it("no premature done: a partial run (one repo failed) does NOT move the task done", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    makeConflictingRepo(fx, "repo-b");
    const task = makeTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    const store = createStore(task);

    const result = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });

    // repo-a landed first, but the task must NOT be done because repo-b failed.
    expect(result.repos.find((r) => r.repo === "repo-a")!.status).toBe("landed");
    expect(result.finalized).toBe(false);
    expect(store.moveTaskCalls).toHaveLength(0);
    expect(store.emitted.some((e) => e.event === "task:merged")).toBe(false);
  });

  it("completion: all repos landed → task moves done ONCE with aggregate mergeDetails", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    addRepoBranchWithEdit(fx, "repo-b", "b feature\n");
    const task = makeTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    const store = createStore(task);

    const result = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });

    expect(result.allLanded).toBe(true);
    expect(result.finalized).toBe(true);
    // Moved done exactly once and emitted task:merged exactly once.
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "done" }]);
    const mergedEvents = store.emitted.filter((e) => e.event === "task:merged");
    expect(mergedEvents).toHaveLength(1);

    // Aggregate mergeDetails: a representative commitSha + the per-repo landed map.
    const md = store.task.mergeDetails!;
    expect(md.mergeConfirmed).toBe(true);
    const landedShaA = fx.git("repo-a", "git rev-parse refs/heads/main");
    const landedShaB = fx.git("repo-b", "git rev-parse refs/heads/main");
    expect(md.workspaceLandedShas).toEqual({ "repo-a": landedShaA, "repo-b": landedShaB });
    // commitSha is one of the landed repo shas (representative for the task:merged consumer).
    expect([landedShaA, landedShaB]).toContain(md.commitSha);
  });
});

/*
FNXC:Workspace 2026-06-22-04:10 (Phase C review A1/A4/A5 — DB-failure resilience):
These drive the REAL `landWorkspaceTask` against the REAL two-repo fixture but inject a
store whose `updateTask` REJECTS on a chosen patch, exercising the persist-failure windows
that the review fixes close. No mock-the-world: the git lands are real; only the targeted
DB write is forced to fail.
*/
describeIfGit("landWorkspaceTask — DB-failure resilience (Phase C review A1/A4/A5)", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("A1/A4: a persist-failure AFTER the ref advanced escalates to WorkspacePartialLandError (no silent continue); a retry skips the actually-landed repo (no double squash)", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    const task = makeTask({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } });

    // A store that FAILS the landedSha persist (the workspaceWorktrees write) exactly once,
    // then persists normally — simulating a transient DB hiccup in the A1 window.
    let failLandedShaWrite = true;
    const store = createStore(task);
    const realUpdate = store.updateTask as unknown as (id: string, patch: Partial<Task>) => Promise<undefined>;
    (store as { updateTask: unknown }).updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
      if (failLandedShaWrite && patch.workspaceWorktrees) {
        failLandedShaWrite = false;
        throw new Error("synthetic DB write failure (landedSha persist)");
      }
      return realUpdate(id, patch);
    });

    const tipBefore = fx.git("repo-a", "git rev-parse refs/heads/main");

    // First run: repo-a squashes + advances the ref, but the landedSha persist throws.
    await expect(
      landWorkspaceTask(store, store.task, fx.rootDir, {}, {
        mergeAgent: squashMergeAgent(BRANCH),
        reviewAgent: approveReviewAgent,
      }),
    ).rejects.toBeInstanceOf(WorkspacePartialLandError);

    // The ref DID advance (the repo is actually landed) — but landedSha was NOT recorded.
    const tipAfterFirst = fx.git("repo-a", "git rev-parse refs/heads/main");
    expect(tipAfterFirst).not.toBe(tipBefore);
    expect(store.task.workspaceWorktrees!["repo-a"].landedSha).toBeUndefined();
    // Not finalized to done (the throw aborted before finalize).
    expect(store.moveTaskCalls).toHaveLength(0);
    // Status was reset off 'merging' before the throw escaped (A3).
    expect(store.task.status ?? null).toBeNull();

    /*
    FNXC:Workspace 2026-07-07-10:55 (Phase C A1 precision regression — Greptile P1, two surfaces):
    Advance repo-a's integration tip with an intervening commit whose MESSAGE BODY mentions the
    trailer text "Fusion-Task-Id: FN-2002" (a changelog/diagnostic-style mention, NOT a real trailer
    line) AFTER the task's squash landed (tipAfterFirst) but BEFORE the lost-persist retry. This
    covers both precision surfaces: (1) the recovered landedSha must be the task's OWN landing commit
    (tipAfterFirst), not the later tip; (2) the substring --grep prefilter must NOT select the
    body-mention commit — findProvenLandedCommit requires an actual trailer line, so it skips the
    mention and returns the real squash commit.
    */
    configureIdentity(fx.repoPath("repo-a"));
    fx.git(
      "repo-a",
      'git commit --allow-empty -m "unrelated intervening land" -m "changelog: relates to Fusion-Task-Id: FN-2002 (body mention, not a trailer line)"',
    );
    const tipAfterIntervening = fx.git("repo-a", "git rev-parse refs/heads/main");
    expect(tipAfterIntervening).not.toBe(tipAfterFirst);

    // Retry: the A1 trailer scan recognises the actually-landed repo via its Fusion-Task-Id
    // trailer and SKIPS it — the ref must NOT advance a 2nd time (stays at the intervening tip).
    const second = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).toBe(tipAfterIntervening); // no double squash
    expect(second.repos[0].alreadyLanded).toBe(true);
    // Precision invariant: the recovered landedSha is the task's exact landing commit, not the
    // later unrelated integration tip.
    expect(second.repos[0].landedSha).toBe(tipAfterFirst);
    expect(second.allLanded).toBe(true);
    expect(second.finalized).toBe(true);
  });

  it("A4: WorkspacePartialLandError is a real class (instanceof + retryable + payload)", () => {
    const err = new WorkspacePartialLandError(2, ["repo-b"], "partial");
    expect(err).toBeInstanceOf(WorkspacePartialLandError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WorkspacePartialLandError");
    expect(err.retryable).toBe(true);
    expect(err.landedCount).toBe(2);
    expect(err.failedRepos).toEqual(["repo-b"]);
  });

  it("A5: a rejecting mergeDetails persist aborts finalization (does NOT silently finalize on a stale row)", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    const task = makeTask({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } });

    // Fail the mergeDetails write (the finalize TOCTOU window) — the landedSha write succeeds.
    const store = createStore(task);
    const realUpdate = store.updateTask as unknown as (id: string, patch: Partial<Task>) => Promise<undefined>;
    (store as { updateTask: unknown }).updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
      if (patch.mergeDetails) {
        throw new Error("synthetic DB write failure (mergeDetails)");
      }
      return realUpdate(id, patch);
    });

    await expect(
      landWorkspaceTask(store, store.task, fx.rootDir, {}, {
        mergeAgent: squashMergeAgent(BRANCH),
        reviewAgent: approveReviewAgent,
      }),
    ).rejects.toThrow(/mergeDetails/);

    // Finalization aborted: the task was NOT moved done and no task:merged was emitted on a
    // stale/unpersisted row.
    expect(store.moveTaskCalls).toHaveLength(0);
    expect(store.emitted.some((e) => e.event === "task:merged")).toBe(false);
    // Status was still reset off 'merging' (A3 finally runs before finalize).
    expect(store.task.status ?? null).toBeNull();
  });
});

// FNXC:Workspace 2026-06-22-09:30 (Phase C review nit): the former generic "fake-timer backoff
// schedule does not spin real retries" smoke test only proved Vitest's fake timers work — it never
// drove the production retry seam. The real backoff-cap invariant is now asserted against the live
// ProjectEngine in project-engine.test.ts ("B4/B5: busy contention re-enqueues with capped backoff").
describe("workspace partial-land retry/park decision (engine seam)", () => {
  it("consumes a mergeRetry up to MAX, then parks (shouldRetryWorkspacePartialLand)", () => {
    // Default MAX = 3. currentRetries + 1 < MAX gates retry.
    expect(shouldRetryWorkspacePartialLand(0, {})).toMatchObject({
      shouldRetry: true,
      maxAutoMergeRetries: 3,
      nextRetryCount: 1,
    });
    expect(shouldRetryWorkspacePartialLand(1, {})).toMatchObject({
      shouldRetry: true,
      maxAutoMergeRetries: 3,
      nextRetryCount: 2,
    });
    // Last attempt: currentRetries + 1 === MAX → park (no further retry).
    expect(shouldRetryWorkspacePartialLand(2, {})).toMatchObject({
      shouldRetry: false,
      maxAutoMergeRetries: 3,
      nextRetryCount: 3,
    });
    // Custom cap honored.
    expect(shouldRetryWorkspacePartialLand(3, { maxAutoMergeRetries: 5 }).shouldRetry).toBe(true);
    expect(shouldRetryWorkspacePartialLand(4, { maxAutoMergeRetries: 5 }).shouldRetry).toBe(false);
  });
});
