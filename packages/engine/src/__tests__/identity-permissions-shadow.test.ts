/**
 * FNXC:IdentityPermissions 2026-08-24-02:20:
 * Core ports `classifyGitCommand` because the git-write question is the canonical proof that
 * permission resolution is argument-aware and the CLI bundle inlines core alone. Duplicating a
 * security classifier is a drift hazard; this corpus is the guard. If it fails, the port is
 * wrong — do not "fix" it by relaxing the assertion. U19b collapses the two copies.
 */
import { describe, expect, it } from "vitest";
import { classifyGitCommandForPermissions } from "@fusion/core";
import { classifyGitCommand } from "../execution/gating-classifications.js";

const gitCases = [
  ["git status", false, "git status"],
  ["git diff", false, "git diff"],
  ["git log --oneline", false, "git log"],
  ["git show HEAD", false, "git show"],
  ["git add .", true, "git add"],
  ["git commit -m x", true, "git commit"],
  ["git branch", false, "git branch"],
  ["git branch --show-current", false, "git branch --show-current"],
  ["git branch feature", true, "git branch"],
  ["git branch -d feature", true, "git branch"],
  ["git switch main", false, "git switch"],
  ["git switch -c feature", true, "git switch -c"],
  ["git checkout main", false, "git checkout"],
  ["git checkout -b feature", true, "git checkout -b"],
  ["git pull", false, "git pull"],
  ["git pull --rebase", true, "git pull --rebase"],
  ["git restore file.ts", false, "git restore"],
  ["git restore --staged file.ts", true, "git restore --staged"],
  ["git remote -v", false, "git remote -v"],
  ["git remote add origin x", true, "git remote"],
  ["git remote set-url origin y", true, "git remote"],
  ["git worktree list", false, "git worktree"],
  ["git worktree add ../x", true, "git worktree add"],
  ["git worktree remove ../x", true, "git worktree remove"],
  ["echo hi && git status", false, "git status"],
  ["echo hi; git commit -m x", true, "git commit"],
  ["echo hi | git diff", false, "git diff"],
  ["echo hi\ngit checkout -b t", true, "git checkout -b"],
] as const;

describe("identity permissions git classifier shadow", () => {
  it.each(gitCases)("core port agrees with the engine original for %s", (command, write, operation) => {
    expect(classifyGitCommand(command)).toEqual({ write, operation });
    expect(classifyGitCommandForPermissions(command)).toEqual(classifyGitCommand(command));
  });

  it("both return null when no git command is present", () => {
    expect(classifyGitCommand("pnpm test")).toBeNull();
    expect(classifyGitCommandForPermissions("pnpm test")).toBeNull();
  });
});
