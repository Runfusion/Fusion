import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTaskCodeCwd } from "../preview/task-code-worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("resolveTaskCodeCwd", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a live worktree when present on disk", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "quality-live-wt-"));
    temps.push(worktree);
    const result = await resolveTaskCodeCwd({
      projectRoot: "/project",
      task: { id: "FN-1", worktree },
    });
    expect(result).toMatchObject({ cwd: worktree, cwdKind: "worktree", created: false });
  });

  it("creates a disposable QA worktree at the task merge commit for done tasks", async () => {
    const repo = mkdtempSync(join(tmpdir(), "quality-repo-"));
    temps.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "readme.md"), "main\n");
    git(repo, ["add", "readme.md"]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["checkout", "-b", "fusion/fn-42"]);
    writeFileSync(join(repo, "feature.md"), "task code\n");
    git(repo, ["add", "feature.md"]);
    git(repo, ["commit", "-m", "task"]);
    const mergeSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-"]);
    // Done-task cleanup often deletes fusion/<id>; fall back to merge commit.
    git(repo, ["branch", "-D", "fusion/fn-42"]);

    const result = await resolveTaskCodeCwd({
      projectRoot: repo,
      task: {
        id: "FN-42",
        worktree: undefined,
        branch: undefined,
        mergeDetails: { commitSha: mergeSha },
      },
    });

    expect(result.cwdKind).toBe("qa-worktree");
    expect(result.created).toBe(true);
    expect(result.ref).toBe(mergeSha);
    expect(result.cwd).toContain(".fusion/quality-qa");
    expect(git(result.cwd, ["rev-parse", "HEAD"])).toBe(mergeSha);
    // Task file exists only on the task commit, not on main
    expect(() => git(result.cwd, ["cat-file", "-e", "HEAD:feature.md"])).not.toThrow();
  });

  it("reuses an existing QA worktree path without failing", async () => {
    const repo = mkdtempSync(join(tmpdir(), "quality-repo-reuse-"));
    temps.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-m", "init"]);
    const sha = git(repo, ["rev-parse", "HEAD"]);

    const first = await resolveTaskCodeCwd({
      projectRoot: repo,
      task: { id: "FN-7", mergeDetails: { commitSha: sha } },
    });
    const second = await resolveTaskCodeCwd({
      projectRoot: repo,
      task: { id: "FN-7", mergeDetails: { commitSha: sha } },
    });
    expect(second.cwd).toBe(first.cwd);
    expect(second.created).toBe(false);
  });

  it("errors when no worktree and no reachable ref (no project-root fallback)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "quality-repo-empty-"));
    temps.push(repo);
    git(repo, ["init"]);
    await expect(
      resolveTaskCodeCwd({
        projectRoot: repo,
        task: { id: "FN-missing" },
      }),
    ).rejects.toThrow(/no live worktree and no reachable branch\/merge commit/i);
  });
});
