/*
FNXC:Workspace 2026-08-30-13:36:
FN-268 symptom acceptance for the workspace lane, driven through PRODUCTION rather than the helper.

The first regression attempt called `cleanupLandedWorkspaceTaskWorktrees` directly. That proves the
helper works and nothing about the defect: the reported symptom is that `finalizeWorkspaceTask`
hardcoded `worktreeRemoved: false` and removed nothing, so a merged workspace task left an orphan
`<root>/.fusion/worktrees/<task-id>/` behind. Only an assertion that runs `landWorkspaceTask` end to
end can catch a regression in that wiring — stale task data, a fence refusal, swallowed cleanup
errors, or finalization ordering that moves the card done before cleanup.

Real git, real linked task worktrees, no AI: the merge and review agents are injected, so the squash
is a plain `git merge --squash`.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MergeResult, Task, TaskStore } from "@fusion/core";
import { landWorkspaceTask } from "../merge/merger-ai.js";
import { createWorkspaceFixture, hasGit, type WorkspaceFixture } from "./_workspace-fixture.js";

const describeIfGit = hasGit ? describe : describe.skip;
const TASK_ID = "FN-2680";
const BRANCH = "fusion/fn-2680";

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function configureIdentity(dir: string): void {
  sh(dir, 'git config user.email "test@example.com"');
  sh(dir, 'git config user.name "Test"');
}

/** The task directory production resolves for an unset `worktreesDir`. */
function taskWorktreeDir(fx: WorkspaceFixture): string {
  return path.join(fx.rootDir, ".fusion", "worktrees", TASK_ID.toLowerCase());
}

/**
 * A REAL linked task worktree at the production location, carrying one committed change so the
 * branch has something to land and the checkout is clean enough to be discardable afterwards.
 */
function addTaskWorktree(fx: WorkspaceFixture, repoRel: string, content: string): { worktreePath: string; branch: string } {
  const worktreePath = path.join(taskWorktreeDir(fx), repoRel);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  fx.git(repoRel, `git worktree add -b ${BRANCH} ${JSON.stringify(worktreePath)} HEAD`);
  configureIdentity(worktreePath);
  writeFileSync(path.join(worktreePath, "feature.txt"), content, "utf-8");
  sh(worktreePath, "git add feature.txt");
  sh(worktreePath, `git commit -m "feat(${TASK_ID}): add feature in ${repoRel}"`);
  return { worktreePath, branch: BRANCH };
}

/** Diverge a repo's integration tip and branch on the same file so the squash conflicts. */
function makeConflicting(fx: WorkspaceFixture, repoRel: string, worktreePath: string): void {
  writeFileSync(path.join(worktreePath, "README.md"), "# branch-side change\n", "utf-8");
  sh(worktreePath, "git add README.md");
  sh(worktreePath, `git commit -m "feat(${TASK_ID}): branch README"`);
  const repoDir = fx.repoPath(repoRel);
  writeFileSync(path.join(repoDir, "README.md"), "# main-side change\n", "utf-8");
  fx.git(repoRel, "git add README.md");
  fx.git(repoRel, 'git commit -m "main diverge README"');
}

interface RecordingStore extends EventEmitter {
  task: Task;
  moveTaskCalls: Array<{ id: string; column: string }>;
  merged: MergeResult[];
}

function createStore(task: Task): TaskStore & RecordingStore {
  const emitter = new EventEmitter();
  const moveTaskCalls: Array<{ id: string; column: string }> = [];
  const merged: MergeResult[] = [];
  const realEmit = emitter.emit.bind(emitter);
  return Object.assign(emitter, {
    task,
    moveTaskCalls,
    merged,
    getSettings: vi.fn().mockResolvedValue({ autoMerge: false }),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => { Object.assign(task, patch); return undefined; }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (live: Task) => Partial<Task>) => {
      Object.assign(task, updater(task));
      return task;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn(async () => task),
    moveTask: vi.fn((id: string, column: string) => {
      moveTaskCalls.push({ id, column });
      task.column = column as Task["column"];
      return Promise.resolve(task);
    }),
    upsertTaskCommitAssociation: vi.fn().mockResolvedValue(undefined),
    accumulateTokenUsage: vi.fn().mockResolvedValue(undefined),
    emit: (event: string, payload?: unknown) => {
      if (event === "task:merged") merged.push(payload as MergeResult);
      return realEmit(event, payload);
    },
  }) as unknown as TaskStore & RecordingStore;
}

function makeTask(workspaceWorktrees: Task["workspaceWorktrees"]): Task {
  return {
    /* Merge-mechanics fixture: an explicit empty list states that no review gate is under test. */
    enabledWorkflowSteps: [],
    id: TASK_ID,
    title: "Workspace cleanup task",
    description: "",
    column: "in-review",
    branch: BRANCH,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workspaceWorktrees,
    repositoryScope: { state: "confirmed", repositories: Object.keys(workspaceWorktrees ?? {}).sort() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

const squashMergeAgent = async (cwd: string): Promise<void> => {
  configureIdentity(cwd);
  try {
    execSync(`git merge --squash ${BRANCH}`, { cwd, stdio: "pipe" });
  } catch {
    // conflicts surface through the unmerged check below
  }
  if (execSync("git ls-files -u", { cwd, encoding: "utf-8" }).trim().length > 0) {
    throw new Error("merge conflict: unresolved paths in clean room");
  }
  if (execSync("git diff --cached --name-only", { cwd, encoding: "utf-8" }).trim().length === 0) return;
  execSync(`git commit -m "${BRANCH}: squashed"`, { cwd, stdio: "pipe" });
};
const approveReviewAgent = async (): Promise<string> => "REVIEW_VERDICT: approve";

describeIfGit("FN-268 workspace merge finalization removes its worktrees through landWorkspaceTask", () => {
  let fx: WorkspaceFixture;
  afterEach(() => fx?.cleanup());

  it("leaves no orphan: both checkouts and the task directory are gone once the card is done", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const repoA = addTaskWorktree(fx, "repo-a", "a feature\n");
    const repoB = addTaskWorktree(fx, "repo-b", "b feature\n");
    const store = createStore(makeTask({
      "repo-a": { worktreePath: repoA.worktreePath, branch: BRANCH },
      "repo-b": { worktreePath: repoB.worktreePath, branch: BRANCH },
    }));

    const result = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent,
      reviewAgent: approveReviewAgent,
    });

    expect(result.allLanded).toBe(true);
    expect(result.finalized).toBe(true);
    expect(store.moveTaskCalls).toEqual([{ id: TASK_ID, column: "done" }]);
    // The reported symptom, asserted on disk after the production path ran.
    expect(existsSync(repoA.worktreePath)).toBe(false);
    expect(existsSync(repoB.worktreePath)).toBe(false);
    expect(existsSync(taskWorktreeDir(fx))).toBe(false);
    // ...and the merge result tells the truth about it, rather than the old hardcoded false.
    expect(store.merged.at(-1)).toEqual(expect.objectContaining({ worktreeRemoved: true, mergeConfirmed: true }));
  });

  it("keeps every checkout when only one repository lands", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const repoA = addTaskWorktree(fx, "repo-a", "a feature\n");
    const repoB = addTaskWorktree(fx, "repo-b", "b feature\n");
    makeConflicting(fx, "repo-b", repoB.worktreePath);
    const store = createStore(makeTask({
      "repo-a": { worktreePath: repoA.worktreePath, branch: BRANCH },
      "repo-b": { worktreePath: repoB.worktreePath, branch: BRANCH },
    }));

    const result = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent,
      reviewAgent: approveReviewAgent,
    }).catch((error: unknown) => error);

    // A partial land never finalizes, so nothing may be torn down — the retry needs these checkouts.
    expect(store.moveTaskCalls).toHaveLength(0);
    expect(existsSync(repoA.worktreePath)).toBe(true);
    expect(existsSync(repoB.worktreePath)).toBe(true);
    expect(existsSync(taskWorktreeDir(fx))).toBe(true);
    expect(store.merged).toHaveLength(0);
    expect(result).toBeDefined();
  });

  it("preserves a checkout holding uncommitted work and keeps the task directory", async () => {
    fx = await createWorkspaceFixture(["repo-a", "repo-b"]);
    const repoA = addTaskWorktree(fx, "repo-a", "a feature\n");
    const repoB = addTaskWorktree(fx, "repo-b", "b feature\n");
    // Unsaved work in repo-b: deletion here would destroy it, so the checkout must survive.
    writeFileSync(path.join(repoB.worktreePath, "deliverable.txt"), "keep me\n", "utf-8");
    const store = createStore(makeTask({
      "repo-a": { worktreePath: repoA.worktreePath, branch: BRANCH },
      "repo-b": { worktreePath: repoB.worktreePath, branch: BRANCH },
    }));

    const result = await landWorkspaceTask(store, store.task, fx.rootDir, {}, {
      mergeAgent: squashMergeAgent,
      reviewAgent: approveReviewAgent,
    });

    expect(result.allLanded).toBe(true);
    expect(result.finalized).toBe(true);
    // The unsaved work survives, which is the whole point of the proof gate...
    expect(existsSync(repoB.worktreePath)).toBe(true);
    expect(existsSync(path.join(repoB.worktreePath, "deliverable.txt"))).toBe(true);
    // ...its clean sibling is still torn down...
    expect(existsSync(repoA.worktreePath)).toBe(false);
    // ...and a preserved member keeps the parent: emptied-parent removal is fail-closed.
    expect(existsSync(taskWorktreeDir(fx))).toBe(true);
    /*
    `worktreeRemoved` reports at-least-one teardown, not "everything is gone" — repo-a was removed.
    Pinning it here states that semantics deliberately, so a future change cannot quietly redefine
    the flag to mean "fully cleaned" while a preserved checkout is still on disk.
    */
    expect(store.merged.at(-1)).toEqual(expect.objectContaining({ worktreeRemoved: true }));
  });
});
