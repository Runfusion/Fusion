import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDiffBaseRef } from "../executor/worktree-git-refs.js";
import { resolveContentReviewInputProof, computeCodeReviewInputFingerprint } from "../worktree/review-diff-fingerprint.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fusion-review-base-"));
  directories.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const commit = (file: string, content: string) => {
    writeFileSync(join(dir, file), content);
    git("add", file);
    git("commit", "-m", file);
    return git("rev-parse", "HEAD");
  };
  const stored = commit("initial.txt", "initial\n");
  return { dir, git, commit, stored };
}

describe("review base recovery", () => {
  it.each(["main", "origin/main"])("excludes newer integration history proven by %s from review and merge input", async (ref) => {
    const { dir, git, commit, stored } = fixture();
    const base = commit("upstream.txt", "upstream\n");
    git("update-ref", `refs/${ref === "main" ? "heads/main" : "remotes/origin/main"}`, base);
    git("checkout", "-b", "fusion/fx-012");
    if (ref === "origin/main") git("update-ref", "refs/heads/main", stored);
    commit("task.txt", "task\n");

    await expect(resolveDiffBaseRef(dir, stored)).resolves.toBe(base);
    const files = git("diff", "--name-only", `${await resolveDiffBaseRef(dir, stored)}..HEAD`);
    expect(files).toBe("task.txt");
    const fingerprint = await computeCodeReviewInputFingerprint(dir, base);
    await expect(resolveContentReviewInputProof(dir, stored)).resolves.toEqual({ kind: "fingerprint", fingerprint });
  });

  it("does not erase task work when integration refs already contain HEAD", async () => {
    const { dir, git, commit, stored } = fixture();
    git("checkout", "-b", "fusion/task");
    const head = commit("task.txt", "task\n");
    git("update-ref", "refs/heads/main", head);
    git("update-ref", "refs/remotes/origin/main", head);
    await expect(resolveDiffBaseRef(dir, stored)).resolves.toBe(stored);
  });

  it("preserves a newer stored base when integration refs lag or are absent", async () => {
    const { dir, git, commit, stored } = fixture();
    git("checkout", "-b", "fusion/task");
    const base = commit("predecessor.txt", "predecessor\n");
    commit("task.txt", "task\n");
    await expect(resolveDiffBaseRef(dir, base)).resolves.toBe(base);
    git("branch", "-D", "main");
    await expect(resolveDiffBaseRef(dir, base)).resolves.toBe(base);
    expect(base).not.toBe(stored);
  });
});
