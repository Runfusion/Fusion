// Real-git characterization of findAlreadyMergedTaskCommit's ownership
// anchoring. These tests pin the 2026-05-23 lost-work incident's bug #2:
// the detector must NOT attribute a task to a commit that merely *mentions*
// the task ID in prose (the historical `git log --grep` first-hit bug).
import { afterEach, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findAlreadyMergedTaskCommit } from "../already-merged-detector.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

describeIfGit("findAlreadyMergedTaskCommit ownership anchoring (real git)", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  function setupRepo(): string {
    const repo = mkdtempSync(path.join(os.tmpdir(), "fn-amd-"));
    repos.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test"');
    git(repo, "git commit --allow-empty -m 'init'");
    return repo;
  }

  it("attributes via trailer when the owned commit carries Fusion-Task-Id", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "owned.txt"), "owned\n", "utf-8");
    git(repo, "git add src/owned.txt && git commit -m 'feat: landed work' -m 'Fusion-Task-Id: FN-AMD-1'");
    const landedSha = git(repo, "git rev-parse HEAD");

    const result = await findAlreadyMergedTaskCommit({
      taskId: "FN-AMD-1",
      repoDir: repo,
      baseBranch: "main",
    });

    expect(result).not.toBeNull();
    expect(result!.sha).toBe(landedSha);
    expect(result!.strategy).toBe("trailer");
    expect(result!.ownershipProof).toBe("task-trailer");
  });

  it("attributes legacy task-id trailer even when the commit also carries lineage but task has none", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "legacy-lineage.txt"), "owned legacy lineage\n", "utf-8");
    git(
      repo,
      "git add src/legacy-lineage.txt && git commit -m 'feat: legacy lineage landed' -m 'Fusion-Task-Id: FN-AMD-LEGACY' -m 'Fusion-Task-Lineage: LINEAGE-OPTIONAL'",
    );
    const landedSha = git(repo, "git rev-parse HEAD");

    const result = await findAlreadyMergedTaskCommit({
      taskId: "FN-AMD-LEGACY",
      repoDir: repo,
      baseBranch: "main",
    });

    expect(result).not.toBeNull();
    expect(result!.sha).toBe(landedSha);
    expect(result!.strategy).toBe("trailer");
    expect(result!.ownershipProof).toBe("task-trailer");
  });

  it("attributes via lineage trailer when present", async () => {
    const repo = setupRepo();
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "lineage.txt"), "lineage\n", "utf-8");
    git(repo, "git add src/lineage.txt && git commit -m 'feat: lineage work' -m 'Fusion-Task-Lineage: LINEAGE-XYZ'");
    const landedSha = git(repo, "git rev-parse HEAD");

    const result = await findAlreadyMergedTaskCommit({
      taskId: "FN-AMD-LIN",
      lineageId: "LINEAGE-XYZ",
      repoDir: repo,
      baseBranch: "main",
    });

    expect(result).not.toBeNull();
    expect(result!.sha).toBe(landedSha);
    expect(result!.strategy).toBe("trailer");
    expect(result!.ownershipProof).toBe("lineage-trailer");
  });

  // Incident bug #2 regression: a commit that merely *mentions* the task ID in
  // its prose body (no anchored trailer) must NOT be attributed to the task,
  // even when the task's own branch tip is already an ancestor of base. The
  // ancestry `git log --grep=<taskId>` strategy historically accepted the first
  // such prose-mention hit and stranded/mis-attributed work.
  it("does NOT attribute to a commit that only mentions the task ID in prose (ancestry path)", async () => {
    const repo = setupRepo();

    // An unrelated commit whose BODY mentions FN-AMD-2 in prose only.
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "unrelated.txt"), "unrelated\n", "utf-8");
    git(
      repo,
      "git add src/unrelated.txt && git commit -m 'feat: unrelated change' -m 'This also touches things related to FN-AMD-2 in passing.'",
    );
    const proseSha = git(repo, "git rev-parse HEAD");

    // The task's own branch landed by being merged into main, but its commits
    // carry NO trailer and NO conventional-subject anchor — only a generic
    // message — so the only `--grep=FN-AMD-2` hit is the prose-mention above.
    git(repo, "git checkout -b fusion/fn-amd-2");
    writeFileSync(path.join(repo, "src", "task.txt"), "task work\n", "utf-8");
    git(repo, "git add src/task.txt && git commit -m 'wip: generic message with no anchor'");
    git(repo, "git checkout main");
    git(repo, "git merge --no-ff --no-edit fusion/fn-amd-2 -m 'merge generic branch'");

    const result = await findAlreadyMergedTaskCommit({
      taskId: "FN-AMD-2",
      repoDir: repo,
      baseBranch: "main",
      taskBranch: "fusion/fn-amd-2",
    });

    // Hard invariant: the prose-mention commit must NEVER be attributed,
    // independent of which strategy (if any) the detector returns. Asserting
    // this directly prevents the test passing vacuously when result is null or
    // the regression surfaces via a non-ancestry strategy.
    const returnedSha = result ? result.sha : null;
    expect(returnedSha).not.toBe(proseSha);

    // It may legitimately attribute via patch-id/tree-equal to the REAL owned
    // content, but it must NEVER return the unrelated prose-mention commit.
    if (result && result.strategy === "ancestry") {
      const subject = git(repo, `git show -s --format=%s ${result.sha}`);
      const body = git(repo, `git show -s --format=%b ${result.sha}`);
      const ownedBySubject = /^(?:[A-Za-z]+\([^)]*FN-AMD-2[^)]*\):|FN-AMD-2:)/.test(subject);
      const ownedByTrailer = /(?:^|\n)Fusion-Task-Id: FN-AMD-2\s*(?:\n|$)/.test(body);
      expect(ownedBySubject || ownedByTrailer).toBe(true);
    }
  });

  it("rejects a patch-id match when the landed candidate carries a foreign task trailer", async () => {
    const repo = setupRepo();
    git(repo, "git checkout -b fusion/fn-amd-foreign");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "foreign-patch.txt"), "same-content\n", "utf-8");
    git(repo, "git add src/foreign-patch.txt && git commit -m 'work without owner'");
    const branchBase = git(repo, "git merge-base main fusion/fn-amd-foreign");
    git(repo, "git checkout main");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "foreign-patch.txt"), "same-content\n", "utf-8");
    git(repo, "git add src/foreign-patch.txt && git commit -m 'feat: foreign landed' -m 'Fusion-Task-Id: FN-AMD-OTHER'");

    const result = await findAlreadyMergedTaskCommit({
      taskId: "FN-AMD-FOREIGN",
      repoDir: repo,
      baseBranch: "main",
      taskBranch: "fusion/fn-amd-foreign",
      baseCommitSha: branchBase,
    });

    expect(result).toBeNull();
  });

  it("rejects branch-fallback attribution when task metadata points at another task branch", async () => {
    const repo = setupRepo();
    git(repo, "git checkout -b fusion/fn-amd-other-tip");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "other-tip.txt"), "other\n", "utf-8");
    git(repo, "git add src/other-tip.txt && git commit -m 'feat: other tip' -m 'Fusion-Task-Id: FN-AMD-OTHER-TIP'");
    git(repo, "git checkout main");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "other-tip.txt"), "other\n", "utf-8");
    git(repo, "git add src/other-tip.txt && git commit -m 'land equivalent other tip'");

    const result = await findAlreadyMergedTaskCommit({
      taskId: "FN-AMD-RECOVERED",
      repoDir: repo,
      baseBranch: "main",
      taskBranch: "fusion/fn-amd-other-tip",
    });

    expect(result).toBeNull();
  });

  it("attributes via ancestry when the landed commit carries a conventional-subject anchor", async () => {
    const repo = setupRepo();

    // The merge into main carries a conventional subject anchored on the task
    // ID; ancestry attribution should accept it (it is genuinely owned).
    git(repo, "git checkout -b fusion/fn-amd-3");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "anchored.txt"), "anchored\n", "utf-8");
    git(repo, "git add src/anchored.txt && git commit -m 'feat(FN-AMD-3): real anchored work'");
    git(repo, "git checkout main");
    git(repo, "git merge --ff-only fusion/fn-amd-3");

    const result = await findAlreadyMergedTaskCommit({
      taskId: "FN-AMD-3",
      repoDir: repo,
      baseBranch: "main",
      taskBranch: "fusion/fn-amd-3",
    });

    expect(result).not.toBeNull();
    // Trailer path won't match (no trailer); ownership-anchored ancestry should.
    const subject = git(repo, `git show -s --format=%s ${result!.sha}`);
    expect(subject).toContain("FN-AMD-3");
    expect(result!.ownershipProof).toBe("subject-anchor");
  });
});
