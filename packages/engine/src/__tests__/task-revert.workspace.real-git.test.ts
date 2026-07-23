import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWorkspaceTaskRevertCommits,
  revertWorkspaceTask,
} from "../execution/task-revert.js";
import type { Task } from "@fusion/core";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-A",
    lineageId: "FN-A",
    description: "",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    ...overrides,
  } as Task;
}

/*
FNXC:TaskRevert 2026-07-04-00:00 (FN-7547):
Real multi-repo git fixture coverage for the workspace revert path — this is
the Symptom Verification regression suite. Mirrors the scratch-repo fixture
pattern from workspace-merger-idempotency.test.ts and the single-repo
task-revert.real-git.test.ts, but with TWO sub-repos under a shared workspace
root so the all-or-nothing multi-repo classification/rollback contract can be
exercised for real.
*/
describeIfGit("task-revert workspace real-git scenarios", { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function subRepoFixture(workspaceRoot: string, repoRel: string, initialFile: string, initialContent: string): string {
    const repoRootDir = join(workspaceRoot, repoRel);
    git(workspaceRoot, `mkdir -p ${repoRel}`);
    git(repoRootDir, "git init -b main");
    git(repoRootDir, 'git config user.email "test@example.com"');
    git(repoRootDir, 'git config user.name "Test User"');
    git(repoRootDir, "git config commit.gpgsign false");
    writeFileSync(join(repoRootDir, initialFile), initialContent);
    git(repoRootDir, `git add ${initialFile} && git commit -m 'init'`);
    return repoRootDir;
  }

  function workspaceFixture() {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "fn-7547-wsrevert-"));
    dirs.push(workspaceRoot);
    const repoA = subRepoFixture(workspaceRoot, "repo-a", "a.ts", "line1\n");
    const repoB = subRepoFixture(workspaceRoot, "repo-b", "b.ts", "line1\n");
    return { workspaceRoot, repoA, repoB };
  }

  function landTaskCommit(repoRootDir: string, file: string, content: string, commitSubject: string): string {
    writeFileSync(join(repoRootDir, file), content);
    git(repoRootDir, `git commit -am ${JSON.stringify(commitSubject)}`);
    return git(repoRootDir, "git rev-parse HEAD");
  }

  function makeWorkspaceTask(shaA: string, shaB: string, overrides: Partial<Task> = {}): Task {
    return makeTask({
      column: "done",
      workspaceWorktrees: {
        "repo-a": { worktreePath: "repo-a", branch: "fusion/FN-A", landedSha: shaA },
        "repo-b": { worktreePath: "repo-b", branch: "fusion/FN-A", landedSha: shaB },
      },
      mergeDetails: { commitSha: shaA, workspaceLandedShas: { "repo-a": shaA, "repo-b": shaB } },
      ...overrides,
    });
  }

  it("attribution: resolves the correct per-repo squash commit for each sub-repo", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    const task = makeWorkspaceTask(shaA, shaB);
    const attribution = await resolveWorkspaceTaskRevertCommits(task, { workspaceRootDir: workspaceRoot });

    expect(Object.keys(attribution).sort()).toEqual(["repo-a", "repo-b"]);
    expect(attribution["repo-a"]).toEqual({ commits: [shaA], source: "squash" });
    expect(attribution["repo-b"]).toEqual({ commits: [shaB], source: "squash" });
  });

  it("attribution: falls back to lineage association when a repo's landed sha is absent", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaBUnrecorded = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    const task = makeTask({
      column: "done",
      workspaceWorktrees: {
        "repo-a": { worktreePath: "repo-a", branch: "fusion/FN-A", landedSha: shaA },
        "repo-b": { worktreePath: "repo-b", branch: "fusion/FN-A" },
      },
      mergeDetails: { commitSha: shaA, workspaceLandedShas: { "repo-a": shaA } },
    });

    const attribution = await resolveWorkspaceTaskRevertCommits(task, {
      workspaceRootDir: workspaceRoot,
      commitAssociationSource: {
        getTaskCommitAssociationsByLineageId: async () => [
          {
            id: "assoc-1",
            taskLineageId: "FN-A",
            taskIdSnapshot: "FN-A",
            commitSha: shaBUnrecorded,
            commitSubject: "feat(FN-A): add feature in repo-b",
            authoredAt: new Date().toISOString(),
            matchedBy: "canonical-lineage-trailer",
            confidence: "canonical",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });

    expect(attribution["repo-a"]).toEqual({ commits: [shaA], source: "squash" });
    expect(attribution["repo-b"]).toEqual({ commits: [shaBUnrecorded], source: "lineage" });
  });

  it("clean all-or-nothing: reverts both sub-repos with a Fusion-Task-Id-trailered commit on each (Symptom Verification)", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    const task = makeWorkspaceTask(shaA, shaB);
    const result = await revertWorkspaceTask({ task, workspaceRootDir: workspaceRoot, settings: {} });

    expect(result.mode).toBe("git");
    expect(result.clean).toBe(true);
    if (result.mode === "git" && result.clean) {
      expect(result.workspace.repos).toHaveLength(2);
      const byRepo = Object.fromEntries(result.workspace.repos.map((r) => [r.repo, r]));
      expect(byRepo["repo-a"].classification).toBe("clean");
      expect(byRepo["repo-a"].revertCommitSha).toBeTruthy();
      expect(byRepo["repo-b"].classification).toBe("clean");
      expect(byRepo["repo-b"].revertCommitSha).toBeTruthy();
    }

    for (const repoRootDir of [repoA, repoB]) {
      const subject = git(repoRootDir, "git log -1 --format=%s");
      expect(subject).toMatch(/^revert\(FN-A\):/);
      const body = git(repoRootDir, "git log -1 --format=%B");
      expect(body).toContain("Fusion-Task-Id: FN-A");
      expect(git(repoRootDir, "git status --porcelain")).toBe("");
    }
    expect(git(repoA, "git show HEAD:a.ts")).toBe("line1");
    expect(git(repoB, "git show HEAD:b.ts")).toBe("line1");
  });

  it("partial-conflict rollback: a later task touching repo-b only leaves BOTH repos byte-identical to pre-call (Symptom Verification)", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    // Task B later modifies the exact same region touched by task A in repo-b only.
    landTaskCommit(repoB, "b.ts", "line1\nfeature-a-modified-by-b\n", "feat(FN-B): modify same region in repo-b");

    const preCallHeadA = git(repoA, "git rev-parse HEAD");
    const preCallStatusA = git(repoA, "git status --porcelain");
    const preCallHeadB = git(repoB, "git rev-parse HEAD");
    const preCallStatusB = git(repoB, "git status --porcelain");

    const task = makeWorkspaceTask(shaA, shaB);
    const result = await revertWorkspaceTask({ task, workspaceRootDir: workspaceRoot, settings: {} });

    expect(result.mode).toBe("git");
    expect(result.clean).toBe(false);
    if (result.mode === "git" && !result.clean && "conflicts" in result) {
      expect(result.conflicts.some((c) => c.repo === "repo-b")).toBe(true);
    }

    // NO commit created in EITHER repo — all-or-nothing rollback held.
    expect(git(repoA, "git rev-parse HEAD")).toBe(preCallHeadA);
    expect(git(repoA, "git status --porcelain")).toBe(preCallStatusA);
    expect(git(repoB, "git rev-parse HEAD")).toBe(preCallHeadB);
    expect(git(repoB, "git status --porcelain")).toBe(preCallStatusB);
    // repo-a is NOT left reverted.
    expect(git(repoA, "git show HEAD:a.ts")).toBe("line1\nfeature-a");
  });

  it("already-reverted: reverting a clean task twice reports alreadyReverted for both repos with no second commit", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    const task = makeWorkspaceTask(shaA, shaB);
    const first = await revertWorkspaceTask({ task, workspaceRootDir: workspaceRoot, settings: {} });
    expect(first.clean).toBe(true);

    const headAAfterFirst = git(repoA, "git rev-parse HEAD");
    const headBAfterFirst = git(repoB, "git rev-parse HEAD");

    const second = await revertWorkspaceTask({ task, workspaceRootDir: workspaceRoot, settings: {} });
    expect(second.mode).toBe("git");
    expect(second.clean).toBe(true);
    if (second.mode === "git" && second.clean) {
      for (const repo of second.workspace.repos) {
        expect(repo.alreadyReverted).toBe(true);
      }
    }

    expect(git(repoA, "git rev-parse HEAD")).toBe(headAAfterFirst);
    expect(git(repoB, "git rev-parse HEAD")).toBe(headBAfterFirst);
  });

  it("dirty-tree refusal: refuses without mutating either repo when one sub-repo has a stray uncommitted change", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    writeFileSync(join(repoB, "b.ts"), "line1\nfeature-a\nSTRAY UNCOMMITTED CHANGE\n");

    const preCallHeadA = git(repoA, "git rev-parse HEAD");
    const preCallHeadB = git(repoB, "git rev-parse HEAD");

    const task = makeWorkspaceTask(shaA, shaB);
    await expect(revertWorkspaceTask({ task, workspaceRootDir: workspaceRoot, settings: {} })).rejects.toMatchObject({
      code: "dirty-working-tree",
    });

    expect(git(repoA, "git rev-parse HEAD")).toBe(preCallHeadA);
    expect(git(repoA, "git status --porcelain")).toBe("");
    expect(git(repoB, "git rev-parse HEAD")).toBe(preCallHeadB);
    expect(git(repoB, "git show HEAD:b.ts")).toBe("line1\nfeature-a");
  });

  it("guard rails: refuses a non-done/archived workspace task and never mutates the source task lifecycle", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    const task = makeWorkspaceTask(shaA, shaB, { column: "in-progress" });
    const result = await revertWorkspaceTask({ task, workspaceRootDir: workspaceRoot, settings: {} });

    expect(result).toMatchObject({ mode: "git", needsHuman: true });
    expect(task.column).toBe("in-progress");
  });

  it("guard rails: autoMerge:false refuses with needsHuman instead of force-writing", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    const task = makeWorkspaceTask(shaA, shaB);
    const result = await revertWorkspaceTask({
      task,
      workspaceRootDir: workspaceRoot,
      settings: {},
      effectiveAutoMerge: false,
    });

    expect(result).toMatchObject({ mode: "git", needsHuman: true });
    expect(git(repoA, "git status --porcelain")).toBe("");
    expect(git(repoB, "git status --porcelain")).toBe("");
  });
});
