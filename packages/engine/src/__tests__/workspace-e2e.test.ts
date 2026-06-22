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

NO-PUSH INVARIANT (the whole D2/D5 premise — a HARD assertion):
Each sub-repo gets a REAL bare `origin` remote that we push initial state to. We snapshot
`git for-each-ref` over BOTH the bare origin AND the working repo's `refs/remotes/*` BEFORE and
AFTER `landWorkspaceTask`. landWorkspaceTask lands each sub-repo onto its own LOCAL integration ref
via CAS with NO remote push, so the origin's refs and every `refs/remotes/*` tracking ref must be
BYTE-FOR-BYTE UNCHANGED while the LOCAL `refs/heads/main` advances. A leaked `git push` would move
an origin ref and fail the snapshot equality — this is the strongest available proof of no-push.

Surfaces (FN-5893):
- e2e happy + no-push: two acquired repos both land → BOTH local integration refs advance,
  per-repo `landedSha` is set, the task is finalized done EXACTLY once, AND origin/remote refs are
  unchanged (no push).
- e2e partial-land recovery: force repo B to conflict → repo A lands (landedSha + ref advance), task
  NOT done; resolve B and run the U1 reconciler (re-enqueue → idempotent landWorkspaceTask) → B
  lands, task done, and repo A's ref did NOT advance a second time (isRepoLanded skip — no double-land).
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { landWorkspaceTask } from "../merger-ai.js";
import { SelfHealingManager } from "../self-healing.js";
import { activeSessionRegistry } from "../active-session-registry.js";
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
  return {
    id: TASK_ID,
    title: "Workspace merge task",
    description: "",
    column: "in-review",
    branch: BRANCH,
    worktree: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    paused: false,
    workspaceWorktrees,
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    ...extra,
  } as unknown as Task;
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
 * Give a sub-repo a REAL bare `origin` remote and push its initial state. Returns the bare repo
 * path so the test can snapshot its refs. Used to prove the NO-PUSH invariant: the origin must not
 * move across a land.
 */
function addOriginRemote(fx: WorkspaceFixture, repoRel: string): string {
  const repoDir = fx.repoPath(repoRel);
  const originDir = path.join(repoDir, "..", `${repoRel}-origin.git`);
  execSync(`git init --bare ${originDir}`, { cwd: repoDir, stdio: "pipe" });
  fx.git(repoRel, `git remote add origin ${originDir}`);
  fx.git(repoRel, "git push origin --all");
  return originDir;
}

/** Snapshot ALL refs of a git dir (sha + name), normalized, for byte-for-byte comparison. */
function snapshotRefs(gitDir: string): string {
  return execSync("git for-each-ref --format='%(objectname) %(refname)'", {
    cwd: gitDir,
    encoding: "utf-8",
  }).trim();
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

describeIfGit("workspace e2e — merge (no-push) + partial-land recovery (Phase D U2)", () => {
  let fx: WorkspaceFixture;
  beforeEach(() => activeSessionRegistry.clear());
  afterEach(() => {
    activeSessionRegistry.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
    fx?.cleanup();
  });

  it("e2e happy: both repos land on LOCAL refs, landedSha per repo, finalize ONCE, NO push", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const originA = addOriginRemote(fx, "repo-a");
    const originB = addOriginRemote(fx, "repo-b");
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    addRepoBranchWithEdit(fx, "repo-b", "b feature\n");

    const tipABefore = fx.git("repo-a", "git rev-parse refs/heads/main");
    const tipBBefore = fx.git("repo-b", "git rev-parse refs/heads/main");

    // NO-PUSH snapshot: bare origin refs + the working repo's refs/remotes tracking refs.
    const originABefore = snapshotRefs(originA);
    const originBBefore = snapshotRefs(originB);
    const remotesABefore = fx.git("repo-a", "git for-each-ref refs/remotes");
    const remotesBBefore = fx.git("repo-b", "git for-each-ref refs/remotes");

    const store = createStore([
      makeTask({
        "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
        "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
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

    // Finalize EXACTLY once.
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "done" }]);
    expect(store.emitted.filter((e) => e.event === "task:merged")).toHaveLength(1);

    // NO-PUSH invariant (HARD): origin refs and remote-tracking refs are BYTE-FOR-BYTE unchanged.
    expect(snapshotRefs(originA)).toBe(originABefore);
    expect(snapshotRefs(originB)).toBe(originBBefore);
    expect(fx.git("repo-a", "git for-each-ref refs/remotes")).toBe(remotesABefore);
    expect(fx.git("repo-b", "git for-each-ref refs/remotes")).toBe(remotesBBefore);
  });

  it("e2e partial-land recovery: A lands, task not done → U1 reconciler lands B, no double-land of A", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    addRepoBranchWithEdit(fx, "repo-a", "a feature\n");
    makeConflictingRepo(fx, "repo-b");

    const tipABefore = fx.git("repo-a", "git rev-parse refs/heads/main");

    const store = createStore([
      makeTask({
        "repo-a": { worktreePath: fx.repoPath("repo-a"), branch: BRANCH },
        "repo-b": { worktreePath: fx.repoPath("repo-b"), branch: BRANCH },
      }),
    ]);

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
