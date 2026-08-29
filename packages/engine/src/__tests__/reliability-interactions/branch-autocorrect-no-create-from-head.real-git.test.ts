import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { attemptBranchAutocorrect } from "../../execution/branch-autocorrect.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(cwd, file), content, "utf-8");
  git(cwd, `git add ${JSON.stringify(file)}`);
  git(cwd, `git commit -m ${JSON.stringify(message)}`);
  return git(cwd, "git rev-parse HEAD");
}

describeIfGit("FN-5456: attemptBranchAutocorrect must never create a branch from arbitrary HEAD", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function initRepo() {
    const repoDir = await mkdtemp(join(tmpdir(), "fn-5456-autocorrect-"));
    dirs.push(repoDir);
    git(repoDir, "git init -b main");
    git(repoDir, 'git config user.email "test@example.com"');
    git(repoDir, 'git config user.name "Test User"');
    await commitFile(repoDir, "README.md", "base\n", "chore: init");
    return repoDir;
  }

  // The rename path is intended for the case-mismatch use case (FN-4474):
  // observed is "fresh" (no upstream, sole ref at its sha) and is logically
  // the same branch as expected. Outside that shape — when observed shares
  // its tip with another ref, or carries an upstream — the autocorrect must
  // fall through to verify-then-checkout, which is what the FN-5456 fix
  // governs.

  it("does not create the expected branch when only a foreign-tipped HEAD is available", async () => {
    const repoDir = await initRepo();

    // Simulate the FN-5456 contamination shape: worktree HEAD is on a branch
    // whose tip is an orphaned/foreign commit. Make the branch non-fresh by
    // also pointing a second ref at the same tip — this forces the rename
    // path to short-circuit and exercises the verify-then-checkout fallback.
    git(repoDir, "git checkout -b fusion/fn-foreign");
    const foreignTip = await commitFile(repoDir, "foreign.ts", "foreign\n", "feat(FN-OTHER): unrelated work");
    git(repoDir, "git branch fusion/fn-foreign-mirror");

    const result = await attemptBranchAutocorrect({
      worktreePath: repoDir,
      observedBranch: "fusion/fn-foreign",
      expectedBranch: "fusion/fn-target",
      rootDir: repoDir,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("fusion/fn-target");

    // No new branch label was created — this is the core invariant.
    const branches = git(repoDir, "git for-each-ref --format='%(refname:short)' refs/heads/")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(branches).not.toContain("fusion/fn-target");

    const targetExists = spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/fusion/fn-target"], {
      cwd: repoDir,
    }).status;
    expect(targetExists).not.toBe(0);
    expect(foreignTip).toMatch(/^[0-9a-f]{40}$/);
  });

  it("switches to the expected branch when it already exists, without altering its tip", async () => {
    const repoDir = await initRepo();

    git(repoDir, "git checkout -b fusion/fn-target");
    const targetTip = await commitFile(repoDir, "target.ts", "target\n", "feat(FN-TARGET): own work");

    // Move HEAD to a different non-fresh branch (mirror the tip with a second
    // ref so isFreshBranch=false and the verify-then-checkout path runs).
    git(repoDir, "git checkout -b fusion/fn-foreign main");
    await commitFile(repoDir, "foreign.ts", "foreign\n", "feat(FN-OTHER): unrelated");
    git(repoDir, "git branch fusion/fn-foreign-mirror");

    const result = await attemptBranchAutocorrect({
      worktreePath: repoDir,
      observedBranch: "fusion/fn-foreign",
      expectedBranch: "fusion/fn-target",
      rootDir: repoDir,
    });

    expect(result.status).toBe("checked-out");
    expect(git(repoDir, "git rev-parse --abbrev-ref HEAD")).toBe("fusion/fn-target");
    expect(git(repoDir, "git rev-parse HEAD")).toBe(targetTip);
  });

  it("verify does not accept a same-named tag (must be refs/heads only)", async () => {
    const repoDir = await initRepo();

    // Place a tag — not a branch — with the conflicting name.
    git(repoDir, "git tag fusion/fn-target");

    git(repoDir, "git checkout -b fusion/fn-foreign");
    await commitFile(repoDir, "foreign.ts", "foreign\n", "feat(FN-OTHER): unrelated");
    git(repoDir, "git branch fusion/fn-foreign-mirror");

    const result = await attemptBranchAutocorrect({
      worktreePath: repoDir,
      observedBranch: "fusion/fn-foreign",
      expectedBranch: "fusion/fn-target",
      rootDir: repoDir,
    });

    expect(result.status).toBe("failed");
    // HEAD must remain on the observed branch — not detached on the tag.
    expect(git(repoDir, "git rev-parse --abbrev-ref HEAD")).toBe("fusion/fn-foreign");
    // And no branch label was created for the tag's name.
    const branchExists = spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/fusion/fn-target"], {
      cwd: repoDir,
    }).status;
    expect(branchExists).not.toBe(0);
  });
});
