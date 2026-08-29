import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProvenLandedCommit, isRepoLanded } from "../merge/workspace-land-predicate.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/*
FNXC:Workspace 2026-08-15-06:45:
A git-mode revert keeps historical landedSha for attribution, but its integration-tip boundary
invalidates both recorded-SHA and task-trailer proof until a newer task landing is created.
*/
describeIfGit("workspace land predicate revert boundary", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function fixture(): string {
    const repo = mkdtempSync(join(tmpdir(), "fn-9047-predicate-"));
    dirs.push(repo);
    git(repo, "git init -b main");
    git(repo, 'git config user.email "test@example.com"');
    git(repo, 'git config user.name "Test User"');
    writeFileSync(join(repo, "file.txt"), "base\n");
    git(repo, "git add file.txt && git commit -m init");
    return repo;
  }

  function commit(repo: string, content: string, subject: string, trailer = false): string {
    writeFileSync(join(repo, "file.txt"), content);
    git(repo, "git add file.txt");
    git(repo, `git commit -m ${JSON.stringify(subject)}${trailer ? " -m 'Fusion-Task-Id: FN-A'" : ""}`);
    return git(repo, "git rev-parse HEAD");
  }

  it("invalidates recorded and trailer landing proof at the revert boundary, then accepts a new landing", async () => {
    const repo = fixture();
    const landed = commit(repo, "landed\n", "land", true);
    const boundary = commit(repo, "reverted\n", "revert", true);

    await expect(isRepoLanded(repo, "main", landed, "FN-A", undefined, boundary)).resolves.toBe(false);
    await expect(findProvenLandedCommit(repo, "main", undefined, "FN-A", undefined, boundary)).resolves.toBeUndefined();
    await expect(isRepoLanded(repo, "main", landed, "FN-A")).resolves.toBe(true);

    const relanded = commit(repo, "relanded\n", "reland", true);
    await expect(findProvenLandedCommit(repo, "main", relanded, "FN-A", undefined, boundary)).resolves.toBe(relanded);
  });

  it("keeps legacy behavior for an unresolvable boundary", async () => {
    const repo = fixture();
    const landed = commit(repo, "landed\n", "land", true);
    await expect(isRepoLanded(repo, "main", landed, "FN-A", undefined, "not-a-sha")).resolves.toBe(true);
  });
});
