/*
FNXC:Workspace 2026-06-22-11:30 (Phase D U2, KTD5 — end-to-end merge + recovery harness):
LANE CHOICE — this is an ENGINE-DEFAULT, git-gated lane (the SAME `describeIfGit` guard as
workspace-merger.test.ts), NOT a merge-gate (engine-core) test. The merge gate is an explicit
allow-list that excludes real-git tests, so a real two-repo fixture e2e cannot run there; it runs
in the non-blocking engine-default suite instead. We drive the REAL `landWorkspaceTask` against a
REAL two-repo git fixture under a NON-git workspace root (createWorkspaceFixture) and invoke the
U1 partial-land reconciler (`reconcileWorkspacePartialLands`) directly under FAKE TIMERS — no
mock-the-world ProjectEngine shell, no real AI (the merge/review agents are injected deps and the
squash is a plain `git merge --squash`), no unbounded temp walk, never touches port 4040 (FN-5048).

LOCAL-ONLY INVARIANT (the FN-122 regression contract):
The workspace root is non-Git and each acquired repository has NO remote. The production landing
planner must select local-only before any fence/intent/push operation, while local `refs/heads/main`
advance through the existing CAS path. This test deliberately does not create `origin`: a leaked
`git ls-remote origin` or `git push origin` fails the land rather than being hidden by a fixture.

Surfaces (FN-5893):
- e2e happy + local-only: two acquired repos both land → BOTH local integration refs advance,
  per-repo `landedSha` is set, and the task is finalized done EXACTLY once without a remote.
- e2e partial-land recovery: force repo B to conflict → repo A lands (landedSha + ref advance), task
  NOT done; resolve B and run the U1 reconciler (re-enqueue → idempotent landWorkspaceTask) → B
  lands, task done, and repo A's ref did NOT advance a second time (isRepoLanded skip — no double-land).
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import * as mergerAi from "../merge/merger-ai.js";
import { landWorkspaceTask } from "../merge/merger-ai.js";
import { ProjectEngine } from "../project-engine.js";
import { TaskExecutor } from "../executor.js";
import { WorkflowReviewService } from "../workflows/workflow-review-service.js";
import { FOREACH_ACTIVE_CONTEXT_KEY } from "../workflows/workflow-node-handlers.js";
import { SelfHealingManager } from "../self-healing.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { captureWorkspaceReviewEvidence } from "../worktree/workspace-review-evidence.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;

const TASK_ID = "FN-8001";
const BRANCH = "fusion/fn-8001";

function configureIdentity(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
}

/**
 * Combined recording store. Satisfies BOTH the `landWorkspaceTask` surface (getSettings/updateTask/
 * logEntry/appendAgentLog/getTask/moveTask/upsertTaskCommitAssociation/accumulateTokenUsage/emit)
 * AND the SelfHealingManager surface (listTasks/peekMergeQueue/recordRunAuditEvent/getRootDir),
 * over a single in-memory task map so a reconciler-routed land sees the SAME freshly-persisted
 * landedShas the first pass wrote.
 */
interface RecordingStore extends EventEmitter {
  tasks: Map<string, Task>;
  emitted: Array<{ event: string; payload: unknown }>;
  moveTaskCalls: Array<{ id: string; column: string }>;
}

function createStore(rows: Task[], settings: Partial<Settings> = {}): TaskStore & RecordingStore {
  const emitter = new EventEmitter();
  const tasks = new Map<string, Task>(rows.map((t) => [t.id, t]));
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const moveTaskCalls: Array<{ id: string; column: string }> = [];
  const realEmit = emitter.emit.bind(emitter);
  const store = Object.assign(emitter, {
    tasks,
    emitted,
    moveTaskCalls,
    getSettings: vi
      .fn()
      .mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false, taskStuckTimeoutMs: 60_000, ...settings } as unknown as Settings),
    listTasks: vi.fn(async (opts?: { column?: string }) => {
      const all = [...tasks.values()];
      return opts?.column ? all.filter((t) => t.column === opts.column) : all;
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id) ?? null),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const cur = tasks.get(id);
      if (cur) tasks.set(id, { ...cur, ...patch } as Task);
      return tasks.get(id) as Task;
    }),
    // FNXC:AiMergeReconciliation 2026-08-20-23:40: merge review persists durable
    // reconciliation through the atomic seam; this fixture must mutate the same row getTask reads.
    updateTaskAtomic: vi.fn(async (id: string, mutate: (task: Task) => Partial<Task> | undefined) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Missing task ${id}`);
      const patch = mutate(current);
      if (patch) tasks.set(id, { ...current, ...patch } as Task);
      return tasks.get(id) as Task;
    }),
    publishWorkspaceCodeReviewEvidence: vi.fn(async (id: string, input: {
      expectedScopeRevision: number;
      reviewEvidence: NonNullable<NonNullable<Task["repositoryScope"]>["reviewEvidence"]>;
      clearReviewRemediation: boolean;
      modifiedFiles?: string[];
    }) => {
      const current = tasks.get(id);
      if (!current) throw new Error(`Missing task ${id}`);
      const scope = current.repositoryScope;
      if (!scope) return { task: current, published: false as const, reason: "scope-absent" as const };
      if (scope.revision !== input.expectedScopeRevision) {
        return { task: current, published: false as const, reason: "scope-superseded" as const };
      }
      const next = {
        ...current,
        repositoryScope: {
          ...scope,
          reviewEvidence: input.reviewEvidence,
          ...(input.clearReviewRemediation && scope.reviewRemediation?.scopeRevision === input.expectedScopeRevision
            ? { reviewRemediation: undefined }
            : {}),
        },
        ...(input.modifiedFiles !== undefined ? { modifiedFiles: input.modifiedFiles } : {}),
      } as Task;
      tasks.set(id, next);
      return { task: next, published: true as const };
    }),
    moveTask: vi.fn(async (id: string, column: string) => {
      moveTaskCalls.push({ id, column });
      const cur = tasks.get(id);
      const next = { ...(cur ?? { id }), column } as Task;
      tasks.set(id, next);
      return next;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    upsertTaskCommitAssociation: vi.fn().mockResolvedValue(undefined),
    accumulateTokenUsage: vi.fn().mockResolvedValue(undefined),
    peekMergeQueue: vi.fn().mockReturnValue([]),
    getRootDir: vi.fn().mockReturnValue("/tmp/test"),
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
      return realEmit(event, payload);
    },
  }) as unknown as TaskStore & RecordingStore;
  return store;
}

function makeTask(workspaceWorktrees: Task["workspaceWorktrees"], extra: Partial<Task> = {}): Task {
  const scopedRepositories = extra.repositoryScope?.repositories ?? Object.keys(workspaceWorktrees ?? {});
  const reviewEvidence = Object.fromEntries(Object.entries(workspaceWorktrees ?? {})
    .filter(([repo]) => scopedRepositories.includes(repo))
    .map(([repo, entry]) => {
      const mergeBase = execSync(`git merge-base HEAD ${entry.branch}`, { cwd: entry.worktreePath, encoding: "utf8" }).trim();
      const diff = execSync(`git diff --binary ${entry.baseCommitSha ?? mergeBase}..${entry.branch}`, { cwd: entry.worktreePath, encoding: "utf8" });
      return [repo, { fingerprint: createHash("sha256").update(diff).digest("hex"), approvedAt: new Date().toISOString() }];
    }));
  const task = {
    id: TASK_ID,
    title: "Workspace merge task",
    description: "",
    column: "in-review",
    branch: BRANCH,
    branchWriteOrigin: "engine",
    worktree: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    paused: false,
    workspaceWorktrees,
    // Direct landing fixtures model an explicit Review Level 0 opt-out; graph
    // fixtures that exercise review gates provide their own enabled step state.
    enabledWorkflowSteps: [],
    // FNXC:RepositoryScope 2026-08-21-01:36: workspace e2e fixtures model the
    // exact fingerprint that the production Code Review episode must approve before land.
    repositoryScope: { repositories: Object.keys(workspaceWorktrees ?? {}).sort(), state: "confirmed" as const, revision: 1, reviewEvidence },
    modifiedFiles: Object.keys(workspaceWorktrees ?? {}).sort().map((repo) => `${repo}/feature.txt`),
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    ...extra,
  } as unknown as Task;
  if (task.repositoryScope) task.repositoryScope.reviewEvidence ??= reviewEvidence;
  return task;
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
    const unmerged = execSync("git ls-files -u", { cwd, encoding: "utf-8" }).trim();
    if (unmerged.length > 0) throw new Error("merge conflict: unresolved paths in clean room");
    const staged = execSync("git diff --cached --name-only", { cwd, encoding: "utf-8" }).trim();
    if (staged.length === 0) return;
    execSync(`git commit -m "${branch}: squashed"`, { cwd, stdio: "pipe" });
  };
}

const approveReviewAgent = async (): Promise<string> => "REVIEW_VERDICT: approve";

/**
 * FNXC:WorkspaceReviewEvidence 2026-08-21-20:11:
 * The decisive landing regression crosses the production step-review seam, including its scoped
 * callback fence and approval writer. Only the model-facing review service is faked.
 */
async function approveWorkspaceReview(store: TaskStore, task: Task, workspaceRootDir: string): Promise<void> {
  /*
  FNXC:WorkspaceReviewEvidence 2026-08-23-22:05:
  The per-repo review loop opens EXACTLY one reviewer episode per scoped repository that carries diff
  evidence, so derive the expected episode count from the same production capture the loop uses
  instead of hard-coding one. A fixture with two scoped modified repositories legitimately reviews
  twice; asserting a constant hid that and only agreed while a fingerprint bug suppressed a repo.
  */
  const evidence = await captureWorkspaceReviewEvidence({ task, workspaceRootDir, settings: {} });
  const scopedRepositories = new Set(task.repositoryScope?.repositories ?? []);
  const expectedEpisodes = evidence.repositories
    .filter((repository) => scopedRepositories.has(repository.repository) && repository.files.length > 0).length;
  const executor = new TaskExecutor(store, workspaceRootDir);
  (executor as any).workspaceConfig = { repos: Object.keys(task.workspaceWorktrees ?? {}) };
  const reviewStep = vi.spyOn(WorkflowReviewService.prototype, "reviewStep")
    .mockResolvedValue({ verdict: "APPROVE", review: "approved", summary: "approved" });
  try {
    const seams = executor.createAuthoritativeWorkflowSeams({ autoMerge: false } as any);
    const result = await seams.stepReview!(task as any, {
      [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 0, worktreePath: Object.values(task.workspaceWorktrees ?? {})[0]?.worktreePath },
    }, { type: "code", advisory: true } as any);
    expect(result.verdict).toBe("APPROVE");
    expect(reviewStep).toHaveBeenCalledTimes(expectedEpisodes);
  } finally {
    reviewStep.mockRestore();
  }
}

/** Add a real `fusion/<id>` branch in a sub-repo with one non-conflicting own commit. */
function addRepoBranchWithEdit(fx: WorkspaceFixture, repoRel: string, content: string): void {
  const repoDir = fx.repoPath(repoRel);
  const wt = path.join(repoDir, ".wt-branch");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${wt} HEAD`);
  configureIdentity(wt);
  writeFileSync(path.join(wt, "feature.txt"), content, "utf-8");
  execSync("git add feature.txt", { cwd: wt, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): add feature in ${repoRel}"`, { cwd: wt, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${wt}`);
}

function addLinkedTaskWorktreeWithEdit(
  fx: WorkspaceFixture,
  repoRel: string,
  content: string,
): { worktreePath: string; branch: string; baseCommitSha: string } {
  const linked = fx.createLinkedTaskWorktree(repoRel, BRANCH);
  configureIdentity(linked.worktreePath);
  writeFileSync(path.join(linked.worktreePath, "feature.txt"), content, "utf-8");
  execSync("git add feature.txt", { cwd: linked.worktreePath, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): linked task worktree feature in ${repoRel}"`, { cwd: linked.worktreePath, stdio: "pipe" });
  return { ...linked, branch: BRANCH };
}

/** Make a sub-repo's integration tip and the task branch BOTH edit README so the squash conflicts. */
function makeConflictingRepo(fx: WorkspaceFixture, repoRel: string): void {
  const repoDir = fx.repoPath(repoRel);
  const wt = path.join(repoDir, ".wt-conflict");
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${wt} HEAD`);
  configureIdentity(wt);
  writeFileSync(path.join(wt, "README.md"), "# branch-side change\n", "utf-8");
  execSync("git add README.md", { cwd: wt, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): branch README"`, { cwd: wt, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${wt}`);
  writeFileSync(path.join(repoDir, "README.md"), "# main-side change\n", "utf-8");
  fx.git(repoRel, "git add README.md");
  fx.git(repoRel, 'git commit -m "main diverge README"');
}

/**
 * Resolve repo B's conflict so a retry can land it: hard-align the task branch's README onto the
 * integration tip's content, then add B's non-conflicting feature on top of the (now conflict-free)
 * branch. After this the squash applies cleanly.
 */
function resolveConflictingRepo(fx: WorkspaceFixture, repoRel: string): void {
  const repoDir = fx.repoPath(repoRel);
  const wt = path.join(repoDir, ".wt-resolve");
  fx.git(repoRel, `git worktree add ${wt} ${BRANCH}`);
  configureIdentity(wt);
  // Take main's README content so the README no longer diverges, then add a unique file.
  const mainReadme = fx.git(repoRel, "git show refs/heads/main:README.md");
  writeFileSync(path.join(wt, "README.md"), `${mainReadme}\n`, "utf-8");
  writeFileSync(path.join(wt, "feature.txt"), "b feature\n", "utf-8");
  execSync("git add README.md feature.txt", { cwd: wt, stdio: "pipe" });
  execSync(`git commit -m "feat(${TASK_ID}): resolve + feature in ${repoRel}"`, { cwd: wt, stdio: "pipe" });
  fx.git(repoRel, `git worktree remove --force ${wt}`);
}

describeIfGit("workspace e2e — local-only merge + partial-land recovery", () => {
  let fx: WorkspaceFixture;
  beforeEach(() => activeSessionRegistry.clear());
  afterEach(() => {
    activeSessionRegistry.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
    fx?.cleanup();
  });

  it("e2e happy: two remote-free repos land locally and finalize once", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const repoA = addLinkedTaskWorktreeWithEdit(fx, "repo-a", "a feature\n");
    const repoB = addLinkedTaskWorktreeWithEdit(fx, "repo-b", "b feature\n");

    const tipABefore = fx.git("repo-a", "git rev-parse refs/heads/main");
    const tipBBefore = fx.git("repo-b", "git rev-parse refs/heads/main");
    expect(fx.git("repo-a", "git remote")).toBe("");
    expect(fx.git("repo-b", "git remote")).toBe("");

    const store = createStore([
      makeTask({
        "repo-a": repoA,
        "repo-b": repoB,
      }),
    ]);
    const task = store.tasks.get(TASK_ID)!;

    const result = await landWorkspaceTask(store, task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });

    // Both landed.
    expect(result.allLanded).toBe(true);
    expect(result.finalized).toBe(true);
    for (const r of result.repos) expect(r.status).toBe("landed");

    // Each repo's LOCAL integration ref advanced.
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).not.toBe(tipABefore);
    expect(fx.git("repo-b", "git rev-parse refs/heads/main")).not.toBe(tipBBefore);

    // Per-repo landedSha persisted on the task row.
    const persisted = store.tasks.get(TASK_ID)!.workspaceWorktrees!;
    expect(persisted["repo-a"].landedSha).toBeTruthy();
    expect(persisted["repo-b"].landedSha).toBeTruthy();
    expect(persisted["repo-a"].landedSha).toBe(fx.git("repo-a", "git rev-parse refs/heads/main"));
    expect(persisted["repo-b"].landedSha).toBe(fx.git("repo-b", "git rev-parse refs/heads/main"));
    const finalizedTask = store.tasks.get(TASK_ID)!;
    expect(finalizedTask.mergeDetails?.workspaceLandedShas).toEqual({
      "repo-a": persisted["repo-a"].landedSha,
      "repo-b": persisted["repo-b"].landedSha,
    });
    expect(finalizedTask.mergeDetails?.mergeConfirmed).toBe(true);

    // Finalize EXACTLY once.
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "done" }]);
    expect(store.emitted.filter((e) => e.event === "task:merged")).toHaveLength(1);

    // No remote was created: this proves the successful path cannot have required `origin`.
    expect(fx.git("repo-a", "git remote")).toBe("");
    expect(fx.git("repo-b", "git remote")).toBe("");
  });

  /*
  FNXC:RepositoryScope 2026-08-20-23:40:
  MRG-041's landing half: acquisition retained both repositories, but only the scoped repository
  with qualified diff evidence may create a review/merge obligation or advance its integration ref.
  */
  it("MRG-041: one scoped modified repository lands while its clean acquired peer is untouched", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    /*
    FNXC:RepositoryScope 2026-08-21-02:35:
    Acquisition creates a task branch in every checkout before planning, including a clean peer.
    Keep that branch in the MRG-041 fixture so merge-boundary evidence validates the production
    acquisition shape instead of treating an impossible missing branch as a clean repository.
    */
    fx.git("repo-b", `git branch ${BRANCH}`);
    const tipABefore = fx.git("repo-a", "git rev-parse refs/heads/main");
    const tipBBefore = fx.git("repo-b", "git rev-parse refs/heads/main");
    const reviewAgent = vi.fn(approveReviewAgent);
    const store = createStore([
      makeTask({
        "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
        "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
      }, {
        repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 2 },
        modifiedFiles: ["repo-a/feature.txt"],
      }),
    ]);

    // Produce the approval through the same per-repository capture landing consumes. repo-b
    // remains a NOT_REVIEWED observation and receives no approval obligation.
    await approveWorkspaceReview(store, store.tasks.get(TASK_ID)!, fx.rootDir);

    const result = await landWorkspaceTask(store, store.tasks.get(TASK_ID)!, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent,
    });

    expect(result.allLanded).toBe(true);
    expect(result.finalized).toBe(true);
    expect(result.repos).toEqual([expect.objectContaining({ repo: "repo-a", status: "landed" })]);
    // FNXC:RepositoryScope 2026-08-20-23:40: existing merge reconciliation requires two clean
    // confirmations for the one land target; the clean peer creates no independent review episode.
    expect(reviewAgent).toHaveBeenCalledTimes(2);
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).not.toBe(tipABefore);
    expect(fx.git("repo-b", "git rev-parse refs/heads/main")).toBe(tipBBefore);
    expect(store.tasks.get(TASK_ID)!.workspaceWorktrees?.["repo-a"].landedSha).toBeTruthy();
    expect(store.tasks.get(TASK_ID)!.workspaceWorktrees?.["repo-b"].landedSha).toBeUndefined();
  });

  it("e2e partial-land recovery: A lands, task not done → U1 reconciler lands B, no double-land of A", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    makeConflictingRepo(fx, "repo-b");

    const tipABefore = fx.git("repo-a", "git rev-parse refs/heads/main");

    const partialTask = makeTask({
      "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
      "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
    });
    // FNXC:RepositoryScope 2026-08-21-00:58: the fixture's reviewed snapshot must
    // describe the conflict branch's README change before the merge boundary admits it.
    partialTask.modifiedFiles = ["repo-a/feature.txt", "repo-b/README.md"];
    const store = createStore([partialTask]);

    // First pass: repo B conflicts → repo A lands, task NOT finalized.
    const first = await landWorkspaceTask(store, store.tasks.get(TASK_ID)!, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });
    expect(first.allLanded).toBe(false);
    const byRepo = Object.fromEntries(first.repos.map((r) => [r.repo, r]));
    expect(byRepo["repo-a"].status).toBe("landed");
    expect(byRepo["repo-b"].status).toBe("failed");

    const tipAAfterFirst = fx.git("repo-a", "git rev-parse refs/heads/main");
    expect(tipAAfterFirst).not.toBe(tipABefore); // A advanced once.
    expect(store.tasks.get(TASK_ID)!.workspaceWorktrees!["repo-a"].landedSha).toBe(tipAAfterFirst);
    expect(store.moveTaskCalls).toHaveLength(0); // task NOT done.
    expect(store.tasks.get(TASK_ID)!.column).toBe("in-review");

    // Resolve repo B's conflict so a retry can land it.
    resolveConflictingRepo(fx, "repo-b");
    // FNXC:RepositoryScope 2026-08-21-00:58: resolution adds feature.txt, so model
    // the intervening Code Review that records the new merge boundary before recovery.
    const recoveringTask = store.tasks.get(TASK_ID)!;
    recoveringTask.modifiedFiles = ["repo-a/feature.txt", "repo-b/README.md", "repo-b/feature.txt"];
    // Re-run the production review helper after resolving the conflict so its
    // fingerprint matches the current branch rather than a hand-built stale diff.
    await approveWorkspaceReview(store, recoveringTask, fx.rootDir);

    // Wire enqueueMerge to the REAL in-process route: re-run landWorkspaceTask (idempotent — A is
    // skipped via isRepoLanded). Capture the routed promise so the test can await completion.
    const routedLands: Promise<unknown>[] = [];
    const enqueueMerge = (taskId: string): boolean => {
      routedLands.push(
        landWorkspaceTask(store, store.tasks.get(taskId)!, fx.rootDir, {}, {
          mergeAgent: squashMergeAgent(BRANCH),
          reviewAgent: approveReviewAgent,
        }),
      );
      return true;
    };
    const manager = new SelfHealingManager(store, {
      rootDir: fx.rootDir,
      enqueueMerge,
      clearMergeActive: vi.fn(),
    } as never);

    // FAKE TIMERS for the reconciler sweep timing (no real polling/waits).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T00:00:00.000Z"));
    const recovered = await manager.reconcileWorkspacePartialLands();
    expect(recovered).toBe(1);
    expect(routedLands).toHaveLength(1);

    const recovery = (await routedLands[0]) as { allLanded: boolean; finalized: boolean };

    // Recovery completes: B lands, task finalized done.
    expect(recovery.allLanded).toBe(true);
    expect(recovery.finalized).toBe(true);
    expect(store.tasks.get(TASK_ID)!.workspaceWorktrees!["repo-b"].landedSha).toBeTruthy();
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "done" }]);
    expect(store.emitted.filter((e) => e.event === "task:merged")).toHaveLength(1);

    // NO DOUBLE-LAND: repo A's ref did NOT advance a second time (isRepoLanded skip).
    expect(fx.git("repo-a", "git rev-parse refs/heads/main")).toBe(tipAAfterFirst);
  });
});

/*
FNXC:WorkspaceIntegration 2026-08-21-22:20:
The local-only regression must cross the real PostgreSQL coordination APIs rather than the
structural RecordingStore above. This fixture retains the non-Git workspace root, two acquired
repositories, and one scoped modification, proving durable repository leasing persists landing
proof without creating a remote fence or intent.
*/
const pgDescribeIfGit = hasGit ? pgDescribe : describe.skip;
pgDescribeIfGit("workspace local-only PostgreSQL landing", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workspace_local_only_e2e",
    projectId: "fn-259-workspace-e2e",
  });
  let fx: WorkspaceFixture;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
  });
  afterEach(async () => {
    fx?.cleanup();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("lands one reviewed local repository through durable coordination without a remote operation", async () => {
    const taskId = "FN-122-PG-LOCAL";
    const repoA = addLinkedTaskWorktreeWithEdit(fx, "repo-a", "postgres local feature\n");
    /* FNXC:WorkspaceReviewEvidence 2026-08-23-22:25: `createLinkedTaskWorktree` returns only path+base, but every workspace entry must name its task branch — `captureWorkspaceReviewEvidence` fails closed on an entry with no branch, and production acquisition always records one. */
    const repoB = { ...fx.createLinkedTaskWorktree("repo-b", BRANCH), branch: BRANCH };
    const source = makeTask({ "repo-a": repoA, "repo-b": repoB }, {
      id: taskId,
      repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 },
      modifiedFiles: ["repo-a/feature.txt"],
    });
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: "local-only PostgreSQL workspace landing", column: "in-review" },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(taskId, {
      branch: BRANCH,
      // FNXC:WorkspaceIntegration 2026-08-23-21:30: writing `branch` is a provenance boundary; these fixtures bind the task to the branch the ENGINE created for it.
      branchWriteOrigin: "engine",
      /*
      FNXC:WorkspaceIntegration 2026-08-23-21:34:
      Reserved-ID creation seeds the default implementation steps (`applyDefaultWorkflowSteps:false`
      governs the review-gate list, not the card's steps), and the merge door refuses a card with a
      non-terminal step. These fixtures exercise LANDING, which a real card reaches only after its
      implementation steps completed, so complete them here rather than fighting the seeding.
      */
      steps: ((await store.getTask(taskId))?.steps ?? []).map((step) => ({ ...step, status: "done" as const })),
      workspaceWorktrees: source.workspaceWorktrees,
      modifiedFiles: source.modifiedFiles,
    } as Partial<Task>);
    vi.spyOn(store, "getRootDir").mockReturnValue(fx.rootDir);
    await store.updateTaskRepositoryScope(taskId, source.repositoryScope);
    const recordFence = vi.spyOn(store, "recordWorkspaceLeaseFenceRef");
    const recordIntent = vi.spyOn(store, "recordWorkspaceLandIntent");
    const acquired = vi.spyOn(store, "acquireWorkspaceLease");

    const result = await landWorkspaceTask(store, (await store.getTask(taskId))!, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent(BRANCH),
      reviewAgent: approveReviewAgent,
    });

    const persisted = (await store.getTask(taskId))!;
    expect(result).toMatchObject({ allLanded: true, finalized: true });
    expect(persisted.column).toBe("done");
    expect(persisted.workspaceWorktrees?.["repo-a"]?.landedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(persisted.workspaceWorktrees?.["repo-b"]?.landedSha).toBeUndefined();
    expect(acquired).toHaveBeenCalledWith(expect.objectContaining({ leaseKey: "repo:repo-a" }));
    expect(recordFence).not.toHaveBeenCalled();
    expect(recordIntent).not.toHaveBeenCalled();
    expect(fx.git("repo-a", "git remote")).toBe("");
    expect(fx.git("repo-b", "git remote")).toBe("");
  });

  it("drives the local-only durable land through ProjectEngine's merge route", async () => {
    const taskId = "FN-122-PG-ENGINE";
    const repoA = addLinkedTaskWorktreeWithEdit(fx, "repo-a", "project engine local feature\n");
    /* FNXC:WorkspaceReviewEvidence 2026-08-23-22:25: `createLinkedTaskWorktree` returns only path+base, but every workspace entry must name its task branch — `captureWorkspaceReviewEvidence` fails closed on an entry with no branch, and production acquisition always records one. */
    const repoB = { ...fx.createLinkedTaskWorktree("repo-b", BRANCH), branch: BRANCH };
    const source = makeTask({ "repo-a": repoA, "repo-b": repoB }, {
      id: taskId,
      repositoryScope: { repositories: ["repo-a"], state: "confirmed", revision: 1 },
      modifiedFiles: ["repo-a/feature.txt"],
    });
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: "ProjectEngine local-only workspace landing", column: "in-review" },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(taskId, {
      branch: BRANCH,
      // FNXC:WorkspaceIntegration 2026-08-23-21:30: writing `branch` is a provenance boundary; these fixtures bind the task to the branch the ENGINE created for it.
      branchWriteOrigin: "engine",
      /*
      FNXC:WorkspaceIntegration 2026-08-23-21:34:
      Reserved-ID creation seeds the default implementation steps (`applyDefaultWorkflowSteps:false`
      governs the review-gate list, not the card's steps), and the merge door refuses a card with a
      non-terminal step. These fixtures exercise LANDING, which a real card reaches only after its
      implementation steps completed, so complete them here rather than fighting the seeding.
      */
      steps: ((await store.getTask(taskId))?.steps ?? []).map((step) => ({ ...step, status: "done" as const })),
      workspaceWorktrees: source.workspaceWorktrees,
      modifiedFiles: source.modifiedFiles,
    } as Partial<Task>);
    vi.spyOn(store, "getRootDir").mockReturnValue(fx.rootDir);
    await store.updateTaskRepositoryScope(taskId, source.repositoryScope);
    // FNXC:WorkspaceIntegration 2026-08-22-00:26:
    // The local-only symptom must pass through the production Code Review evidence writer before
    // ProjectEngine dispatches landing, so an in-memory pre-approved fixture cannot hide a review-to-land race.
    await approveWorkspaceReview(store, (await store.getTask(taskId))!, fx.rootDir);
    const recordFence = vi.spyOn(store, "recordWorkspaceLeaseFenceRef");
    const recordIntent = vi.spyOn(store, "recordWorkspaceLandIntent");
    const acquired = vi.spyOn(store, "acquireWorkspaceLease");
    const moveTask = vi.spyOn(store, "moveTask");
    const realLand = mergerAi.landWorkspaceTask;
    const land = vi.spyOn(mergerAi, "landWorkspaceTask").mockImplementation(async (landStore, task, rootDir, options) =>
      realLand(landStore, task, rootDir, options, {
        mergeAgent: squashMergeAgent(BRANCH),
        reviewAgent: approveReviewAgent,
      }),
    );
    /*
    FNXC:WorkspaceIntegration 2026-08-23-22:40:
    `drainMergeQueue` roots every merge git operation at the STORE's project root (the engine config
    is only a fallback — see its 2026-07-10 note), because in production the store IS project-rooted
    at the workspace root. The shared PG harness owns its own temp rootDir, so point the store at the
    workspace fixture root to restore the production invariant `storeRoot === workspaceRoot`; without
    it the land planner resolves `<harnessRoot>/repo-a` and dies with `spawn git ENOENT`.
    */
    vi.spyOn(store, "getRootDir").mockReturnValue(fx.rootDir);
    const engine = new ProjectEngine({
      projectId: "fn-122-pg-local",
      workingDirectory: fx.rootDir,
      isolationMode: "in-process",
      maxConcurrent: 1,
      maxWorktrees: 1,
    } as never, {} as never, { skipNotifier: true });
    (engine as any).runtime = { getTaskStore: () => store, getPluginRunner: () => undefined };
    /*
    FNXC:WorkspaceIntegration 2026-08-23-22:35:
    `internalEnqueueMerge` no-ops before `start()` (the post-boot gate), so an unstarted engine
    rejects every `onMerge` with "Merge enqueue rejected". This fixture exercises the MERGE ROUTE,
    not the boot sequence — booting a real engine here would also start triage/self-healing polling
    against the shared PG harness — so mark it started the same way the merge-pump unit tests do.
    */
    (engine as unknown as { started: boolean }).started = true;

    try {
      const result = await engine.onMerge(taskId);
      const persisted = (await store.getTask(taskId))!;
      expect(result.merged).toBe(true);
      expect(land).toHaveBeenCalledOnce();
      expect(persisted.column).toBe("done");
      expect(persisted.workspaceWorktrees?.["repo-a"]?.landedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(persisted.workspaceWorktrees?.["repo-b"]?.landedSha).toBeUndefined();
      expect(acquired).toHaveBeenCalledWith(expect.objectContaining({ leaseKey: `merge-dispatch:${taskId}` }));
      expect(acquired).toHaveBeenCalledWith(expect.objectContaining({ leaseKey: "repo:repo-a" }));
      expect(recordFence).not.toHaveBeenCalled();
      expect(recordIntent).not.toHaveBeenCalled();
      expect(moveTask).toHaveBeenCalledTimes(1);
      expect(fx.git("repo-a", "git remote")).toBe("");
    } finally {
      land.mockRestore();
    }
  });
});
