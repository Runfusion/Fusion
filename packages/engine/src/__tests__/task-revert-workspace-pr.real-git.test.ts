import { exec, execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkspaceRevertPrBranches } from "../execution/task-revert.js";
import type { Task } from "@fusion/core";

const realExecAsync = promisify(exec);

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
FNXC:TaskRevert 2026-07-05-00:00 (FN-7577):
Real multi-sub-repo git fixture coverage for `prepareWorkspaceRevertPrBranches`
— the Symptom Verification regression suite for the workspace `mode:"pr"`
branch-prep primitive. Mirrors the two-sub-repo fixture pattern from
`task-revert.workspace.real-git.test.ts` (FN-7547) combined with the
single-repo branch-prep assertions from `task-revert-pr.real-git.test.ts`
(FN-7554): clean → per-sub-repo `fusion/revert-<id>` branches with
integration branches left byte-identical; one conflicting sub-repo aborts the
WHOLE preparation with no branch created anywhere; already-reverted →
eligible with empty repos; mixed clean/already-reverted → only the
still-clean sub-repo gets a branch; non-workspace task → unsupported;
idempotent local branch reset; dirty-tree/branch-mismatch refusal; and a
late-conflict multi-branch cleanup.
*/
describeIfGit("prepareWorkspaceRevertPrBranches real-git scenarios", { timeout: 30_000 }, () => {
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
    const workspaceRoot = mkdtempSync(join(tmpdir(), "kb-revert-ws-pr-"));
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

  it("all clean → eligible, per-sub-repo branches, integration branches unwritten", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    const mainHeadBeforeA = git(repoA, "git rev-parse main");
    const mainHeadBeforeB = git(repoB, "git rev-parse main");

    const task = makeWorkspaceTask(shaA, shaB);
    const result = await prepareWorkspaceRevertPrBranches({
      task,
      workspaceRootDir: workspaceRoot,
      settings: {},
      revertBranch: "fusion/revert-fn-a",
    });

    expect(result).toMatchObject({ eligible: true });
    if (result.eligible) {
      expect(result.repos).toHaveLength(2);
      const byRepo = Object.fromEntries(result.repos.map((r) => [r.repo, r]));
      expect(byRepo["repo-a"]).toMatchObject({ revertBranch: "fusion/revert-fn-a", integrationBranch: "main" });
      expect(byRepo["repo-b"]).toMatchObject({ revertBranch: "fusion/revert-fn-a", integrationBranch: "main" });
      expect(byRepo["repo-a"].revertCommitShas).toHaveLength(1);
      expect(byRepo["repo-b"].revertCommitShas).toHaveLength(1);
    }

    for (const repoRootDir of [repoA, repoB]) {
      const branchTipSubject = git(repoRootDir, "git log -1 --format=%s fusion/revert-fn-a");
      expect(branchTipSubject).toMatch(/^revert\(FN-A\):/);
      const branchTipBody = git(repoRootDir, "git log -1 --format=%B fusion/revert-fn-a");
      expect(branchTipBody).toContain("Fusion-Task-Id: FN-A");
      // checkout restored to main, clean.
      expect(git(repoRootDir, "git rev-parse --abbrev-ref HEAD")).toBe("main");
      expect(git(repoRootDir, "git status --porcelain")).toBe("");
    }

    // (b) each sub-repo's main HEAD is byte-identical to before — integration
    // branch never written.
    expect(git(repoA, "git rev-parse main")).toBe(mainHeadBeforeA);
    expect(git(repoB, "git rev-parse main")).toBe(mainHeadBeforeB);
    expect(git(repoA, "git show fusion/revert-fn-a:a.ts")).toBe("line1");
    expect(git(repoB, "git show fusion/revert-fn-a:b.ts")).toBe("line1");
  });

  it("one sub-repo conflicting → whole-task aborted, NO branches anywhere (Symptom Verification)", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    // Task B later modifies the exact same region touched by task A in repo-b only.
    landTaskCommit(repoB, "b.ts", "line1\nfeature-a-modified-by-b\n", "feat(FN-B): modify same region in repo-b");

    const mainHeadBeforeA = git(repoA, "git rev-parse main");
    const mainHeadBeforeB = git(repoB, "git rev-parse main");

    const task = makeWorkspaceTask(shaA, shaB);
    const result = await prepareWorkspaceRevertPrBranches({
      task,
      workspaceRootDir: workspaceRoot,
      settings: {},
      revertBranch: "fusion/revert-fn-a",
    });

    expect(result).toMatchObject({ eligible: false, classification: "conflicting" });
    if (!result.eligible && result.classification === "conflicting") {
      expect(result.conflicts.some((c) => c.repo === "repo-b")).toBe(true);
    }

    for (const repoRootDir of [repoA, repoB]) {
      expect(git(repoRootDir, "git branch --list fusion/revert-fn-a")).toBe("");
    }
    expect(git(repoA, "git rev-parse main")).toBe(mainHeadBeforeA);
    expect(git(repoB, "git rev-parse main")).toBe(mainHeadBeforeB);
    expect(git(repoA, "git rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(git(repoB, "git rev-parse --abbrev-ref HEAD")).toBe("main");
  });

  it("all already-reverted → eligible with empty repos, no branches, integration branches unchanged", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    // Manually revert both sub-repos on main before calling the branch-prep primitive.
    git(repoA, `git revert --no-edit ${shaA}`);
    git(repoB, `git revert --no-edit ${shaB}`);
    const mainHeadBeforeA = git(repoA, "git rev-parse main");
    const mainHeadBeforeB = git(repoB, "git rev-parse main");

    const task = makeWorkspaceTask(shaA, shaB);
    const result = await prepareWorkspaceRevertPrBranches({
      task,
      workspaceRootDir: workspaceRoot,
      settings: {},
      revertBranch: "fusion/revert-fn-a",
    });

    expect(result).toMatchObject({ eligible: true, repos: [] });
    for (const repoRootDir of [repoA, repoB]) {
      expect(git(repoRootDir, "git branch --list fusion/revert-fn-a")).toBe("");
    }
    expect(git(repoA, "git rev-parse main")).toBe(mainHeadBeforeA);
    expect(git(repoB, "git rev-parse main")).toBe(mainHeadBeforeB);
  });

  it("mixed clean + already-reverted → only the still-clean sub-repo gets a branch", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    // Manually revert repo-b only.
    git(repoB, `git revert --no-edit ${shaB}`);
    const mainHeadBeforeA = git(repoA, "git rev-parse main");
    const mainHeadBeforeB = git(repoB, "git rev-parse main");

    const task = makeWorkspaceTask(shaA, shaB);
    const result = await prepareWorkspaceRevertPrBranches({
      task,
      workspaceRootDir: workspaceRoot,
      settings: {},
      revertBranch: "fusion/revert-fn-a",
    });

    expect(result).toMatchObject({ eligible: true });
    if (result.eligible) {
      expect(result.repos).toHaveLength(1);
      expect(result.repos[0].repo).toBe("repo-a");
    }

    const branchTipSubject = git(repoA, "git log -1 --format=%s fusion/revert-fn-a");
    expect(branchTipSubject).toMatch(/^revert\(FN-A\):/);
    expect(git(repoB, "git branch --list fusion/revert-fn-a")).toBe("");
    expect(git(repoA, "git rev-parse main")).toBe(mainHeadBeforeA);
    expect(git(repoB, "git rev-parse main")).toBe(mainHeadBeforeB);
  });

  it("non-workspace task → unsupported", async () => {
    const { workspaceRoot } = workspaceFixture();
    const task = makeTask({ column: "done" });

    const result = await prepareWorkspaceRevertPrBranches({
      task,
      workspaceRootDir: workspaceRoot,
      settings: {},
      revertBranch: "fusion/revert-fn-a",
    });

    expect(result).toMatchObject({ eligible: false, unsupported: true, reason: "not-a-workspace-task" });
  });

  it("idempotent local branch reset: a stale local branch in one sub-repo is reset off integration with the fresh revert commit", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    // Pre-create a stale local revert branch in repo-a pointing at an unrelated commit.
    git(repoA, "git branch fusion/revert-fn-a main~1");
    const staleTip = git(repoA, "git rev-parse fusion/revert-fn-a");
    expect(staleTip).not.toBe(git(repoA, "git rev-parse main"));

    const task = makeWorkspaceTask(shaA, shaB);
    const result = await prepareWorkspaceRevertPrBranches({
      task,
      workspaceRootDir: workspaceRoot,
      settings: {},
      revertBranch: "fusion/revert-fn-a",
    });

    expect(result).toMatchObject({ eligible: true });
    const branchTipSubject = git(repoA, "git log -1 --format=%s fusion/revert-fn-a");
    expect(branchTipSubject).toMatch(/^revert\(FN-A\):/);
    expect(git(repoA, "git rev-parse --abbrev-ref HEAD")).toBe("main");
  });

  it("dirty-tree refusal: refuses without mutating any sub-repo when one has a stray uncommitted change", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    writeFileSync(join(repoB, "b.ts"), "line1\nfeature-a\nSTRAY UNCOMMITTED CHANGE\n");

    const mainHeadBeforeA = git(repoA, "git rev-parse main");
    const mainHeadBeforeB = git(repoB, "git rev-parse main");

    const task = makeWorkspaceTask(shaA, shaB);
    await expect(
      prepareWorkspaceRevertPrBranches({
        task,
        workspaceRootDir: workspaceRoot,
        settings: {},
        revertBranch: "fusion/revert-fn-a",
      }),
    ).rejects.toMatchObject({ code: "dirty-working-tree" });

    for (const repoRootDir of [repoA, repoB]) {
      expect(git(repoRootDir, "git branch --list fusion/revert-fn-a")).toBe("");
    }
    expect(git(repoA, "git rev-parse main")).toBe(mainHeadBeforeA);
    expect(git(repoB, "git rev-parse main")).toBe(mainHeadBeforeB);
  });

  it("branch-mismatch refusal: refuses without mutating any sub-repo when one is checked out on a different branch", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    git(repoB, "git checkout -b some-other-branch");

    const mainHeadBeforeA = git(repoA, "git rev-parse main");
    const mainHeadBeforeB = git(repoB, "git rev-parse main");

    const task = makeWorkspaceTask(shaA, shaB);
    await expect(
      prepareWorkspaceRevertPrBranches({
        task,
        workspaceRootDir: workspaceRoot,
        settings: {},
        revertBranch: "fusion/revert-fn-a",
      }),
    ).rejects.toMatchObject({ code: "branch-mismatch" });

    for (const repoRootDir of [repoA, repoB]) {
      expect(git(repoRootDir, "git branch --list fusion/revert-fn-a")).toBe("");
    }
    expect(git(repoA, "git rev-parse main")).toBe(mainHeadBeforeA);
    expect(git(repoB, "git rev-parse main")).toBe(mainHeadBeforeB);
  });

  it("late-conflict multi-branch cleanup: repo-a's prepped branch is deleted when repo-b conflicts during apply (branch moved between classify and apply)", async () => {
    const { workspaceRoot, repoA, repoB } = workspaceFixture();
    const shaA = landTaskCommit(repoA, "a.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-a");
    const shaB = landTaskCommit(repoB, "b.ts", "line1\nfeature-a\n", "feat(FN-A): add feature in repo-b");

    const mainHeadBeforeA = git(repoA, "git rev-parse main");
    const mainHeadBeforeB = git(repoB, "git rev-parse main");

    const task = makeWorkspaceTask(shaA, shaB);

    /*
    FNXC:TaskRevert 2026-07-05-00:00 (FN-7577 test): both sub-repos classify
    CLEAN in Phase 1 (repo-b's main is still untouched at that point). Once
    Phase 2 starts checking out repo-a's branch (repo-a sorts first), inject a
    conflicting commit directly onto repo-b's `main` — simulating repo-b's
    branch moving between classify and apply. When Phase 2 reaches repo-b,
    `checkout -B fusion/revert-fn-a main` branches off the NEW (conflicting)
    tip, so applying repo-b's revert commit now conflicts — a genuine late
    conflict. Assert repo-a's already-prepped branch is rolled back too.
    */
    let injected = false;
    const execAsyncImpl: typeof realExecAsync = (async (command: string, options: Record<string, unknown>) => {
      if (!injected && options?.cwd === repoA && /git checkout -B/.test(command)) {
        injected = true;
        writeFileSync(join(repoB, "b.ts"), "line1\nfeature-a-modified-by-b\n");
        execSync("git commit -am 'feat(FN-B): modify same region in repo-b'", { cwd: repoB, stdio: "pipe" });
      }
      return realExecAsync(command, options as never);
    }) as typeof realExecAsync;

    const result = await prepareWorkspaceRevertPrBranches({
      task,
      workspaceRootDir: workspaceRoot,
      settings: {},
      revertBranch: "fusion/revert-fn-a",
      execAsyncImpl,
    });

    expect(result).toMatchObject({ eligible: false, classification: "conflicting" });
    if (!result.eligible && result.classification === "conflicting") {
      expect(result.conflicts.some((c) => c.repo === "repo-b")).toBe(true);
    }
    // repo-a's already-prepped branch from this pass is rolled back too — all-or-nothing.
    expect(git(repoA, "git branch --list fusion/revert-fn-a")).toBe("");
    expect(git(repoB, "git branch --list fusion/revert-fn-a")).toBe("");
    expect(git(repoA, "git rev-parse main")).toBe(mainHeadBeforeA);
    // repo-b's main legitimately advanced due to the injected commit (this test
    // simulates an external actor landing work mid-preparation) — the
    // invariant is that NO revert branch/commit was created anywhere, not that
    // repo-b's HEAD is frozen (that HEAD moved before this function ever ran
    // Phase 2 for repo-b).
    expect(git(repoB, "git rev-parse main")).not.toBe(mainHeadBeforeB);
  });
});
