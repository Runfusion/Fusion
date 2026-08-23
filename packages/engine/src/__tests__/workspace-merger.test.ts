/*
FNXC:Workspace 2026-06-21-23:40 (Phase C U1, KTD1/KTD2):
Per-repo workspace merge-loop tests. They drive the REAL `landWorkspaceTask` /
`landOneRepo` against a REAL two-repo git fixture under a NON-git workspace root
(createWorkspaceFixture), so a leaked rootDir git preflight would actually fail and a
shared clean-room root would race. Real git is used only where the invariant requires
it (the local-ref advance, the no-push assertion); the AI merge/review agents are
injected (deps) so NO real AI calls happen and the squash is produced by a plain
`git merge --squash` inside the clean room — no mock-the-world child_process.

Coverage (FN-5893 surfaces):
- happy: two acquired repos both clean → BOTH local integration refs advance against
  each repo's own resolved branch; NO remote ref/push happened; result tags both. Since
  Phase C U2, a fully-landed workspace task also finalizes ONCE (moves done, emits
  task:merged) — asserted here; the landed-predicate/finalize-once/retry mechanics have
  dedicated coverage in workspace-merger-idempotency.test.ts.
- per-repo resolution: repos with DIFFERENT origin/HEAD integration branches → each
  lands on its own (override-stripping works, not a shared branch).
- partial: a conflict in repo B → repo A lands (landedSha recorded); B reports the
  failure; the task is NOT moved done (no finalizeTask call) — the partial-land retry is U2.
- defense-in-depth: store.mergeTask / aiMergeTask with a workspace task → still throw
  WorkspaceTaskMergeError.
The single-repo runAiMerge regression lives in the existing merger-ai*.test.ts (the
extraction is byte-for-byte; runAiMerge is landOneRepo's single-repo caller).
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import { assertNotWorkspaceTaskMerge } from "@fusion/core";
import { RESOLVED_PRIOR_FINDINGS_MARKER, landWorkspaceTask, runAiMerge } from "../merge/merger-ai.js";
import { PRIOR_FINDING_DISPOSITIONS_MARKER } from "../merge/merger-ai-prompts.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

const TASK_ID = "FN-2001";
const BRANCH = "fusion/fn-2001";

function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

interface RecordingStore extends EventEmitter {
  moveTaskCalls: Array<{ id: string; column: string }>;
  emitted: Array<{ event: string; payload: unknown }>;
}

function createStore(settings: Record<string, unknown> = {}): TaskStore & RecordingStore {
  const emitter = new EventEmitter();
  const moveTaskCalls: Array<{ id: string; column: string }> = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const realEmit = emitter.emit.bind(emitter);
  const store = Object.assign(emitter, {
    moveTaskCalls,
    emitted,
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false, ...settings }),
    updateTask: vi.fn().mockResolvedValue(undefined),
    /* FNXC:WorkspaceMergeTests 2026-08-20-23:23: the durable merge-review reconciliation path atomically records its episode before a workspace repository can land. Keep this narrow store double compatible with that production contract. */
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (task: Task) => Partial<Task> | undefined) => {
      const current = await store.getTask(TASK_ID) as Task;
      const patch = mutate(current);
      if (patch) Object.assign(current, patch);
      return current;
    }),
    mergeWorkspaceWorktreeEntry: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    // FNXC:Test 2026-06-24-23:50: mergeAndReview reads store.getTask().comments for merge/review
    // prompt context (selectUserCommentsForAgentContext); an undefined return throws mid-land. Return
    // a real task shape so the per-repo land reaches landSquash.
    getTask: vi.fn().mockResolvedValue({ id: TASK_ID, column: "in-review", branch: BRANCH, comments: [], steeringComments: [], steps: [], log: [] }),
    moveTask: vi.fn((id: string, column: string) => {
      moveTaskCalls.push({ id, column });
      return Promise.resolve({ id, column } as Task);
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

/**
 * Add a real `fusion/<id>` worktree to a sub-repo with one own commit that EDITS the
 * README the integration tip already has, then remove the worktree (we only need the
 * branch ref). Returns the branch name. By default the edit is non-conflicting.
 */
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

/** Create production-shaped evidence: the persisted path remains a live task worktree at its branch tip. */
function addRegisteredTaskWorktreeWithEdit(
  fx: WorkspaceFixture,
  repoRel: string,
  content: string,
): { worktreePath: string; baseCommitSha: string } {
  const repoDir = fx.repoPath(repoRel);
  // Keep the linked checkout outside its main checkout so the production dirty-root guard stays meaningful.
  const worktreePath = path.join(fx.rootDir, `.task-worktree-${repoRel}`);
  const baseCommitSha = fx.git(repoRel, "git rev-parse HEAD");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
  configureIdentity(worktreePath);
  writeFileSync(path.join(worktreePath, "feature.txt"), content, "utf-8");
  execSync("git add feature.txt", { cwd: worktreePath, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): linked task worktree feature"`, { cwd: worktreePath, stdio: "pipe" });
  return { worktreePath, baseCommitSha };
}

/**
 * FN-8141 shape: a `fusion/<id>` branch that committed work then REVERTED it — AHEAD of the
 * integration tip (two real commits) but net-zero, so its tip is NOT an ancestor of main and the
 * squash lands nothing (empty outcome with zero landed).
 */
function addRepoRevertedBranch(fx: WorkspaceFixture, repoRel: string): void {
  const repoDir = fx.repoPath(repoRel);
  const worktreePath = path.join(repoDir, ".wt-revert");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
  configureIdentity(worktreePath);
  writeFileSync(path.join(worktreePath, "feature.txt"), "work\n", "utf-8");
  execSync("git add feature.txt", { cwd: worktreePath, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): add feature in ${repoRel}"`, { cwd: worktreePath, stdio: "pipe" });
  execSync("git rm feature.txt", { cwd: worktreePath, stdio: "pipe" });
  execSync(`git commit -m "revert(${TASK_ID}): undo feature (net-zero) in ${repoRel}"`, { cwd: worktreePath, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${worktreePath}`);
}

/** Make a sub-repo's integration tip and the task branch BOTH edit README so the
 *  squash conflicts. */
function makeConflictingRepo(fx: WorkspaceFixture, repoRel: string): void {
  const repoDir = fx.repoPath(repoRel);
  // Task branch edits README on a new commit.
  const worktreePath = path.join(repoDir, ".wt-conflict");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${worktreePath} HEAD`);
  configureIdentity(worktreePath);
  writeFileSync(path.join(worktreePath, "README.md"), "# branch-side change\n", "utf-8");
  execSync("git add README.md", { cwd: worktreePath, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): branch README"`, { cwd: worktreePath, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${worktreePath}`);
  // Integration tip (main) diverges with a conflicting README edit.
  writeFileSync(path.join(repoDir, "README.md"), "# main-side change\n", "utf-8");
  fx.git(repoRel, "git add README.md");
  fx.git(repoRel, 'git commit -m "main diverge README"');
}

/** A merge agent that performs the real squash in the clean room (no AI). */
function squashMergeAgent(branch: string) {
  return async (cwd: string): Promise<void> => {
    configureIdentity(cwd);
    try {
      execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    } catch {
      // squash reported conflicts — leave them for the test's expectation.
    }
    // If there are unresolved conflicts, throw so landOneRepo surfaces a failure.
    const unmerged = execSync("git ls-files -u", { cwd, encoding: "utf-8" }).trim();
    if (unmerged.length > 0) {
      throw new Error("merge conflict: unresolved paths in clean room");
    }
    // Nothing staged (already up to date) → leave HEAD unchanged (empty merge).
    const staged = execSync("git diff --cached --name-only", { cwd, encoding: "utf-8" }).trim();
    if (staged.length === 0) return;
    execSync(`git commit -m "${branch}: squashed"`, { cwd, stdio: "pipe" });
  };
}

const approveReviewAgent = async (): Promise<string> => "REVIEW_VERDICT: approve";

function makeTask(workspaceWorktrees: Task["workspaceWorktrees"]): Task {
  return {
    /* FNXC:RequiredPreMergeSteps 2026-08-23-18:07: merge-mechanics fixture, not a review-gating one.
       The door refuses a card whose enabled optional pre-merge groups produced no result, and the
       built-in workflow enables Plan and Code Review by default, so an unspecified list failed the
       door before the behaviour under test ran. An explicit empty list states the intent. */
    enabledWorkflowSteps: [],
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
    // FNXC:RepositoryScope 2026-08-21-00:12: merge fixtures model planner-confirmed intent and fresh qualified diff evidence; acquisition alone is deliberately insufficient to land.
    repositoryScope: {
      repositories: Object.keys(workspaceWorktrees ?? {}).sort(),
      state: "confirmed",
      revision: 1,
      // FNXC:RepositoryScope 2026-08-21-01:36: fixtures persist the same
      // merge-boundary fingerprint that production requires from Code Review.
      reviewEvidence: Object.fromEntries(Object.entries(workspaceWorktrees ?? {}).map(([repo, entry]) => {
        const mergeBase = execSync(`git merge-base HEAD ${entry.branch}`, { cwd: entry.worktreePath, encoding: "utf8" }).trim();
        const diff = execSync(`git diff --binary ${entry.baseCommitSha ?? mergeBase}..${entry.branch}`, { cwd: entry.worktreePath, encoding: "utf8" });
        return [repo, { fingerprint: createHash("sha256").update(diff).digest("hex"), approvedAt: new Date().toISOString() }];
      })),
    },
    modifiedFiles: Object.keys(workspaceWorktrees ?? {}).sort().map((repo) => `${repo}/feature.txt`),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

describeIfGit("landWorkspaceTask — per-repo merge loop (Phase C U1)", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("happy: both clean repos advance their OWN local integration ref with NO push", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    addRepoBranchWithEdit(fx, "repo-b", "b feature\n");

    const tipABefore = fx.git("repo-a", "git rev-parse refs/heads/main");
    const tipBBefore = fx.git("repo-b", "git rev-parse refs/heads/main");

    const store = createStore();
    const task = makeTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });

    const result = await landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });

    expect(result.allLanded).toBe(true);
    expect(result.repos.map((r) => r.repo).sort()).toEqual(["repo-a", "repo-b"]);
    for (const r of result.repos) expect(r.status).toBe("landed");

    // Each repo's LOCAL integration ref advanced (main moved off its prior tip).
    const tipAAfter = fx.git("repo-a", "git rev-parse refs/heads/main");
    const tipBAfter = fx.git("repo-b", "git rev-parse refs/heads/main");
    expect(tipAAfter).not.toBe(tipABefore);
    expect(tipBAfter).not.toBe(tipBBefore);

    // No remote ref / no push: the fixture repos have no remotes at all.
    for (const repo of ["repo-a", "repo-b"]) {
      const remotes = fx.git(repo, "git remote").trim();
      expect(remotes).toBe("");
      const remoteRefs = execSync("git for-each-ref refs/remotes", { cwd: fx.repoPath(repo), encoding: "utf-8" }).trim();
      expect(remoteRefs).toBe("");
    }

    // U2 finalize-once: every repo landed → the task moves to done exactly once.
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "done" }]);
    expect(store.emitted.filter((e) => e.event === "task:merged")).toHaveLength(1);
  });

  it("lands reviewed work from a live linked task worktree baseline", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    const linked = addRegisteredTaskWorktreeWithEdit(fx, "repo-a", "linked feature\n");
    const integrationTipBefore = fx.git("repo-a", "git rev-parse refs/heads/main");
    const store = createStore();
    const task = makeTask({
      "repo-a": { worktreePath: linked.worktreePath, branch: BRANCH, baseCommitSha: linked.baseCommitSha },
    });

    // The production shape that regressed: HEAD and the branch name resolve to the same task tip.
    expect(execSync("git rev-parse HEAD", { cwd: linked.worktreePath, encoding: "utf8" }).trim())
      .toBe(execSync(`git rev-parse ${BRANCH}`, { cwd: linked.worktreePath, encoding: "utf8" }).trim());

    const result = await landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });

    expect(result.repos[0]?.error).toBeUndefined();
    expect(result.repos).toMatchObject([{ repo: "repo-a", status: "landed" }]);
    expect(result.allLanded).toBe(true);
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).not.toBe(integrationTipBefore);
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "done" }]);
  });

  it("reuses reconciled review findings for a workspace sub-repository", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    const store = createStore({ merger: { mode: "ai", maxReviewPasses: 1 } });
    const task = makeTask({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } });
    const finding = "drops the workspace task export";
    const reviewPrompts: string[] = [];
    let reviews = 0;

    const result = await landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: async (_cwd, prompt) => {
        reviewPrompts.push(prompt);
        reviews++;
        return reviews === 1
          ? `${finding}\n${PRIOR_FINDING_DISPOSITIONS_MARKER}\nfinding-1-1: still-present\nSEVERITY: blocking\nREVIEW_VERDICT: reject`
          : `${RESOLVED_PRIOR_FINDINGS_MARKER} ${finding}\n${PRIOR_FINDING_DISPOSITIONS_MARKER}\nfinding-1-1: corrected\nREVIEW_VERDICT: approve`;
      },
    });

    expect(result.allLanded).toBe(true);
    /* FNXC:WorkspaceMergeTests 2026-08-20-23:23: FN-090 requires two clean confirmations after a corrected finding, so the final approval pass is intentionally a second independent reviewer session. */
    expect(reviewPrompts).toHaveLength(3);
    expect(reviewPrompts[1]).toContain(finding);
    expect(reviewPrompts[1]).not.toContain("finding-1-1: still-present");
  });

  it("per-repo resolution: each repo lands on its OWN origin/HEAD branch (override-stripping)", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    // Give each repo a different default integration branch via a bare origin whose
    // HEAD points at that branch. landWorkspaceTask strips integrationBranch/baseBranch
    // overrides, so each repo resolves origin/HEAD independently.
    for (const [repo, intBranch] of [["repo-a", "develop"], ["repo-b", "release"]] as const) {
      const repoDir = fx.repoPath(repo);
      fx.git(repo, `git branch ${intBranch}`);
      const originDir = path.join(repoDir, "..", `${repo}-origin.git`);
      execSync(`git init --bare ${originDir}`, { cwd: repoDir, stdio: "pipe" });
      fx.git(repo, `git remote add origin ${originDir}`);
      fx.git(repo, "git push origin --all");
      execSync(`git symbolic-ref HEAD refs/heads/${intBranch}`, { cwd: originDir, stdio: "pipe" });
      fx.git(repo, "git remote set-head origin -a");
      // task branch off the integration branch with an edit
      const wt = path.join(repoDir, ".wt");
      fx.git(repo, `git worktree add -b ${BRANCH} ${wt} ${intBranch}`);
      configureIdentity(wt);
      writeFileSync(path.join(wt, "feature.txt"), `${repo} feature\n`, "utf-8");
      execSync("git add feature.txt", { cwd: wt, stdio: "pipe" });
      execSync(`git commit -m "feat(${TASK_ID}): add"`, { cwd: wt, stdio: "pipe" });
      fx.git(repo, `git worktree remove --force ${wt}`);
    }

    const store = createStore();
    const task = makeTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });

    const result = await landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });

    expect(result.allLanded).toBe(true);
    const byRepo = Object.fromEntries(result.repos.map((r) => [r.repo, r]));
    expect(byRepo["repo-a"].integrationBranch).toBe("develop");
    expect(byRepo["repo-b"].integrationBranch).toBe("release");
    // Each landed onto its OWN integration branch's local ref.
    expect(byRepo["repo-a"].status).toBe("landed");
    expect(byRepo["repo-b"].status).toBe("landed");
    expect(fx.git("repo-a", "git rev-parse refs/heads/develop")).toBe(byRepo["repo-a"].landedSha);
    expect(fx.git("repo-b", "git rev-parse refs/heads/release")).toBe(byRepo["repo-b"].landedSha);
  });

  it("rejects a modified repository with no approving review fingerprint", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "review evidence is mandatory\n");
    const store = createStore();
    const task = makeTask({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } });
    task.repositoryScope!.reviewEvidence = {};

    await expect(landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    })).rejects.toThrow("approval is missing");
    expect(store.mergeWorkspaceWorktreeEntry).not.toHaveBeenCalled();
  });

  it("returns a fresh repository file to Code Review instead of landing it without review evidence", async () => {
    fx = await createWorkspaceFixture(["repo-a"]);
    addRepoBranchWithEdit(fx, "repo-a", "review this newly discovered file\n");
    const store = createStore();
    const task = makeTask({ "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH } });
    task.modifiedFiles = [];

    await expect(landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    })).rejects.toThrow("content changed after approval");
    expect(store.mergeWorkspaceWorktreeEntry).not.toHaveBeenCalled();
  });

  it("partial: repo B conflict → repo A lands, B reports failure, task NOT moved done", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    makeConflictingRepo(fx, "repo-b");

    const tipABefore = fx.git("repo-a", "git rev-parse refs/heads/main");

    const store = createStore();
    const task = makeTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    // FNXC:RepositoryScope 2026-08-21-00:58: the merge boundary only admits fresh
    // changes that were present in the persisted Code Review evidence.
    task.modifiedFiles = ["repo-a/feature.txt", "repo-b/README.md"];

    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    const result = await landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });

    expect(result.allLanded).toBe(false);
    const byRepo = Object.fromEntries(result.repos.map((r) => [r.repo, r]));
    expect(byRepo["repo-a"].status).toBe("landed");
    expect(byRepo["repo-b"].status).toBe("failed");
    expect(byRepo["repo-b"].error).toMatch(/conflict/i);
    expect(store.mergeWorkspaceWorktreeEntry).toHaveBeenCalledWith(
      TASK_ID,
      "repo-b",
      expect.objectContaining({ landFailure: expect.objectContaining({ message: expect.stringMatching(/conflict/i), branch: BRANCH }) }),
      { requireExistingEntry: true },
    );

    // Repo A landed locally (its ref advanced).
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).not.toBe(tipABefore);

    // The task was NOT finalized/moved done on a partial land.
    expect(store.moveTaskCalls).toHaveLength(0);
    expect(store.emitted.some((e) => e.event === "task:merged")).toBe(false);
  });

  /*
   * FN-8141 workspace parity: an all-empty workspace where every sub-repo branch committed work then
   * REVERTED it (ahead of main, net-zero, tip NOT an ancestor) has zero landed sub-repos and no
   * already-landed proof. It must be blocked back to todo with error — NOT laundered into `done`.
   */
  it("FN-8141: blocks a commit-expected all-empty (reverted) workspace to todo, not done", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoRevertedBranch(fx, "repo-a");
    addRepoRevertedBranch(fx, "repo-b");

    const tipABefore = fx.git("repo-a", "git rev-parse refs/heads/main");
    const tipBBefore = fx.git("repo-b", "git rev-parse refs/heads/main");

    const store = createStore();
    const task = makeTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });

    const result = await landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });

    // No sub-repo FAILED, but nothing landed → blocked, NOT finalized.
    expect(result.allLanded).toBe(true);
    expect(result.finalized).toBe(false);
    expect(result.finalizeBlockedReason).toEqual(expect.stringContaining("operator review required"));
    for (const r of result.repos) expect(r.status).toBe("empty");

    // Moved back to todo with error set; never moved done and never emitted task:merged.
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "todo" }]);
    expect(store.updateTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ error: expect.stringContaining("operator review required") }),
    );
    expect(store.emitted.some((e) => e.event === "task:merged")).toBe(false);

    // Integration refs unchanged.
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).toBe(tipABefore);
    expect(fx.git("repo-b", "git rev-parse refs/heads/main")).toBe(tipBBefore);
  });
});

describe("workspace merge defense-in-depth (non-routed doors keep throwing)", () => {
  it("assertNotWorkspaceTaskMerge throws WorkspaceTaskMergeError for a workspace task (store.mergeTask/aiMergeTask door)", () => {
    const task = {
      id: TASK_ID,
      workspaceWorktrees: { "repo-a": { worktreePath: "/x/repo-a", branch: BRANCH } },
    } as unknown as Task;
    expect(() => assertNotWorkspaceTaskMerge(task)).toThrowError(/reached a single-repo merge path/i);
    try {
      assertNotWorkspaceTaskMerge(task);
    } catch (err) {
      expect((err as Error).name).toBe("WorkspaceTaskMergeError");
    }
  });

  it("assertNotWorkspaceTaskMerge is a no-op for a single-repo task", () => {
    const task = { id: TASK_ID } as unknown as Task;
    expect(() => assertNotWorkspaceTaskMerge(task)).not.toThrow();
  });

  /*
  FNXC:Workspace 2026-06-22-09:30 (Phase C review B11 — exercise the REAL merge door, not only the helper):
  Calling `assertNotWorkspaceTaskMerge` directly proves the helper, but a regression where `runAiMerge`
  (the sole engine merge door, R7 chokepoint) stopped invoking it would slip through. Drive the actual
  door with a minimal store whose `getTask` returns the workspace task: `runAiMerge` reads the task and
  calls the guard BEFORE any git work, so it rejects with WorkspaceTaskMergeError without a real repo.
  */
  it("runAiMerge (engine merge door) rejects a workspace task with WorkspaceTaskMergeError", async () => {
    const workspaceTask = {
      id: TASK_ID,
      workspaceWorktrees: { "repo-a": { worktreePath: "/x/repo-a", branch: BRANCH } },
    } as unknown as Task;
    const store = {
      getTask: vi.fn(async () => workspaceTask),
    } as unknown as TaskStore;
    await expect(runAiMerge(store, "/x", TASK_ID)).rejects.toMatchObject({
      name: "WorkspaceTaskMergeError",
    });
  });
});
