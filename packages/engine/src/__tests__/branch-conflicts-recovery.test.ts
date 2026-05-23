// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  autoRecoverCrossContamination,
  reanchorBranchToBase,
  classifyBootstrapMisbinding,
  classifyForeignCommits,
  type BranchCrossContaminationCommit,
} from "../branch-conflicts.js";

const execAsync = promisify(exec);

async function run(command: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(command, { cwd, encoding: "utf-8" });
  return stdout.trim();
}

describe("branch contamination recovery classification", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setupRepo() {
    const repoDir = await mkdtemp(path.join(tmpdir(), "fn-4428-"));
    dirs.push(repoDir);

    await run("git init -b main", repoDir);
    await run("git config user.email test@example.com", repoDir);
    await run("git config user.name 'Test User'", repoDir);

    await writeFile(path.join(repoDir, "note.txt"), "base\n", "utf-8");
    await run("git add note.txt && git commit -m 'chore: base'", repoDir);
    const baseSha = await run("git rev-parse HEAD", repoDir);

    await run("git checkout -b feature", repoDir);

    return { repoDir, baseSha };
  }

  async function makeCommit(repoDir: string, body: string, subject: string, foreignTaskId: string, file = "note.txt"): Promise<BranchCrossContaminationCommit> {
    await appendFile(path.join(repoDir, file), `${body}\n`, "utf-8");
    await run(`git add ${file}`, repoDir);
    await run(`git commit -m ${JSON.stringify(subject)} -m ${JSON.stringify(`Fusion-Task-Id: ${foreignTaskId}`)}`, repoDir);
    const sha = await run("git rev-parse HEAD", repoDir);
    return { sha, subject, foreignTaskId };
  }

  it("classifies all foreign commits as already-upstream when patches exist on main", async () => {
    const { repoDir, baseSha } = await setupRepo();

    const commit = await makeCommit(repoDir, "foreign-a", "feat(FN-4412): foreign change", "FN-4412");
    await run("git checkout main", repoDir);
    await run(`git cherry-pick ${commit.sha}`, repoDir);
    await run("git checkout feature", repoDir);

    const result = await classifyForeignCommits({
      repoDir,
      branchName: "feature",
      baseSha,
      foreignCommits: [commit],
      mainRef: "main",
    });

    expect(result.alreadyUpstream.map((entry) => entry.sha)).toEqual([commit.sha]);
    expect(result.unique).toEqual([]);
  }, 20_000);

  it("classifies all foreign commits as unique when patches are absent on main", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const commit = await makeCommit(repoDir, "foreign-b", "feat(FN-4412): unique", "FN-4412");

    const result = await classifyForeignCommits({
      repoDir,
      branchName: "feature",
      baseSha,
      foreignCommits: [commit],
      mainRef: "main",
    });

    expect(result.alreadyUpstream).toEqual([]);
    expect(result.unique.map((entry) => entry.sha)).toEqual([commit.sha]);
  }, 20_000);

  it("classifies mixed foreign commits into already-upstream and unique buckets", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const upstreamCommit = await makeCommit(repoDir, "foreign-c", "feat(FN-4412): upstream", "FN-4412");
    const uniqueCommit = await makeCommit(repoDir, "foreign-d", "fix(FN-4410): still unique", "FN-4410");

    await run("git checkout main", repoDir);
    await run(`git cherry-pick ${upstreamCommit.sha}`, repoDir);
    await run("git checkout feature", repoDir);

    const result = await classifyForeignCommits({
      repoDir,
      branchName: "feature",
      baseSha,
      foreignCommits: [upstreamCommit, uniqueCommit],
      mainRef: "main",
    });

    expect(result.alreadyUpstream.map((entry) => entry.sha)).toEqual([upstreamCommit.sha]);
    expect(result.unique.map((entry) => entry.sha)).toEqual([uniqueCommit.sha]);
  }, 20_000);

  it("classifies bootstrap misbinding when range has only foreign-attributed commits", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const foreign = await makeCommit(repoDir, "foreign-bootstrap", "feat(FN-4367): dependency change", "FN-4367");

    const result = await classifyBootstrapMisbinding({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4488",
      foreignCommits: [foreign],
    });

    expect(result).toEqual({
      isBootstrapMisbinding: true,
      ownCommitCount: 0,
      foreignCommitCount: 1,
      nonAttributedCount: 0,
    });
  }, 20_000);

  // Regression: the auto-recovery fallback in branch-worktree.ts has no
  // BranchCrossContaminationError in hand (it walks via inspectBranchConflict),
  // so it cannot supply a foreignCommits array. Before the fix that path
  // passed `[]` and the predicate became dead code.
  it("classifies bootstrap misbinding when foreignCommits is omitted by the caller", async () => {
    const { repoDir, baseSha } = await setupRepo();
    await makeCommit(repoDir, "foreign-bootstrap-no-list", "feat(FN-4367): dependency change", "FN-4367");

    const result = await classifyBootstrapMisbinding({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4488",
    });

    expect(result.isBootstrapMisbinding).toBe(true);
    expect(result.foreignCommitCount).toBe(1);
    expect(result.ownCommitCount).toBe(0);
    expect(result.nonAttributedCount).toBe(0);
  }, 20_000);

  it("does not classify bootstrap misbinding when an own-task commit exists", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const foreign = await makeCommit(repoDir, "foreign-mixed", "feat(FN-4367): dependency change", "FN-4367");
    await appendFile(path.join(repoDir, "note.txt"), "own\n", "utf-8");
    await run("git add note.txt", repoDir);
    await run("git commit -m 'feat(FN-4488): own work' -m 'Fusion-Task-Id: FN-4488'", repoDir);

    const result = await classifyBootstrapMisbinding({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4488",
      foreignCommits: [foreign],
    });

    expect(result.isBootstrapMisbinding).toBe(false);
    expect(result.ownCommitCount).toBe(1);
  });

  it("does not classify bootstrap misbinding when non-attributed commits are present", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const foreign = await makeCommit(repoDir, "foreign-mixed-2", "feat(FN-4367): dependency change", "FN-4367");
    await appendFile(path.join(repoDir, "note.txt"), "refactor\n", "utf-8");
    await run("git add note.txt", repoDir);
    await run("git commit -m 'refactor: unattributed cleanup'", repoDir);

    const result = await classifyBootstrapMisbinding({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4488",
      foreignCommits: [foreign],
    });

    expect(result.isBootstrapMisbinding).toBe(false);
    expect(result.ownCommitCount).toBe(0);
    expect(result.nonAttributedCount).toBe(1);
  });

  it("returns false for empty range with zero own and zero non-attributed commits", async () => {
    const { repoDir, baseSha } = await setupRepo();

    const result = await classifyBootstrapMisbinding({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4488",
      foreignCommits: [],
    });

    expect(result).toEqual({
      isBootstrapMisbinding: false,
      ownCommitCount: 0,
      foreignCommitCount: 0,
      nonAttributedCount: 0,
    });
  });

  it("reanchors branch to base and clears bootstrap foreign history", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const foreign = await makeCommit(repoDir, "foreign-reanchor", "feat(FN-4367): dependency change", "FN-4367");
    const before = await run("git rev-parse feature", repoDir);

    const result = await reanchorBranchToBase({
      repoDir,
      worktreePath: repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4488",
    });

    const after = await run("git rev-parse feature", repoDir);
    const range = await run(`git rev-list --count ${baseSha}..feature`, repoDir);
    expect(result.previousTipSha).toBe(before);
    expect(result.newTipSha).toBe(after);
    expect(result.previousTipSha).toBe(foreign.sha);
    expect(range).toBe("0");
  });

  it("reanchors without checkout -B when detached worktree is already at base on bound branch", async () => {
    const { repoDir, baseSha } = await setupRepo();
    const secondaryWorktree = path.join(repoDir, "../feature-secondary");
    await run(`git worktree add --detach ${JSON.stringify(secondaryWorktree)} ${baseSha}`, repoDir);
    dirs.push(secondaryWorktree);

    await expect(
      run(`git checkout -B feature ${baseSha}`, secondaryWorktree),
    ).rejects.toThrow(/already used by worktree/i);

    const result = await reanchorBranchToBase({
      repoDir,
      worktreePath: secondaryWorktree,
      branchName: "feature",
      baseSha,
      taskId: "FN-4884",
    });

    const headSha = await run("git rev-parse HEAD", secondaryWorktree);
    expect(result.previousTipSha).toBe(baseSha);
    expect(result.newTipSha).toBe(baseSha);
    expect(headSha).toBe(baseSha);
  });

  it("treats already-bound branch-at-base as a no-op fast-path", async () => {
    const { repoDir, baseSha } = await setupRepo();

    const result = await reanchorBranchToBase({
      repoDir,
      worktreePath: repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4884",
    });

    const currentBranch = await run("git symbolic-ref --quiet --short HEAD", repoDir);
    expect(result.previousTipSha).toBe(baseSha);
    expect(result.newTipSha).toBe(baseSha);
    expect(currentBranch).toBe("feature");
  });

  it("auto-recovers by dropping already-upstream foreign commits and preserving remaining branch work", async () => {
    const { repoDir, baseSha } = await setupRepo();
    await writeFile(path.join(repoDir, "foreign.txt"), "", "utf-8");
    await writeFile(path.join(repoDir, "own.txt"), "", "utf-8");
    const foreign = await makeCommit(repoDir, "foreign-e", "feat(FN-4412): upstream duplicate", "FN-4412", "foreign.txt");
    await appendFile(path.join(repoDir, "own.txt"), "own-work\n", "utf-8");
    await run("git add own.txt", repoDir);
    await run("git commit -m 'feat(FN-4428): own work' -m 'Fusion-Task-Id: FN-4428'", repoDir);

    await run("git checkout main", repoDir);
    await run(`git cherry-pick ${foreign.sha}`, repoDir);
    await run("git checkout feature", repoDir);

    const originalTip = await run("git rev-parse HEAD", repoDir);
    const result = await autoRecoverCrossContamination({
      repoDir,
      branchName: "feature",
      baseSha,
      taskId: "FN-4428",
      shasToDrop: [foreign.sha],
    });

    const history = await run(`git log --format=%s ${baseSha}..feature`, repoDir);
    expect(history).toContain("feat(FN-4428): own work");
    expect(history).not.toContain("feat(FN-4412): upstream duplicate");
    expect(result.droppedShas).toEqual([foreign.sha]);
    expect(result.newTipSha).not.toEqual(originalTip);
  });
});

