import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  isInsideConfiguredWorktreesDir,
  resolveTaskWorktreePath,
  resolveWorktreesDir,
} from "../worktree-paths.js";

describe("worktree-paths", () => {
  const rootDir = "/tmp/repo-name";

  it("defaults to <rootDir>/.worktrees when unset", () => {
    expect(resolveWorktreesDir(rootDir, undefined)).toBe(join(rootDir, ".worktrees"));
  });

  it("supports absolute path", () => {
    expect(resolveWorktreesDir(rootDir, { worktreesDir: "/var/tmp/fn-worktrees" } as any)).toBe("/var/tmp/fn-worktrees");
  });

  it("supports ~ expansion", () => {
    expect(resolveWorktreesDir(rootDir, { worktreesDir: "~/.fn-worktrees" } as any)).toBe(join(homedir(), ".fn-worktrees"));
  });

  it("supports relative path with {repo}", () => {
    expect(resolveWorktreesDir(rootDir, { worktreesDir: "../{repo}.worktrees" } as any)).toBe(resolve(rootDir, "../repo-name.worktrees"));
  });

  it("supports {repo} substitution mid-path", () => {
    expect(resolveWorktreesDir(rootDir, { worktreesDir: "~/.fn/{repo}/trees" } as any)).toBe(join(homedir(), ".fn/repo-name/trees"));
  });

  it("builds task worktree path under configured dir", () => {
    expect(resolveTaskWorktreePath(rootDir, { worktreesDir: "../{repo}.worktrees" } as any, "fn-123")).toBe(
      resolve(rootDir, "../repo-name.worktrees/fn-123"),
    );
  });

  it("detects paths inside and outside configured dir", () => {
    const dir = resolveWorktreesDir(rootDir, { worktreesDir: "../{repo}.worktrees" } as any);
    expect(isInsideConfiguredWorktreesDir(rootDir, { worktreesDir: "../{repo}.worktrees" } as any, join(dir, "fn-1"))).toBe(true);
    expect(isInsideConfiguredWorktreesDir(rootDir, { worktreesDir: "../{repo}.worktrees" } as any, join(rootDir, "elsewhere", "fn-1"))).toBe(false);
    expect(isInsideConfiguredWorktreesDir(rootDir, { worktreesDir: "../{repo}.worktrees" } as any, dir)).toBe(false);
  });

  it("legacy .worktrees default still works for containment checks", () => {
    expect(isInsideConfiguredWorktreesDir(rootDir, undefined, join(rootDir, ".worktrees", "fn-1"))).toBe(true);
    expect(isInsideConfiguredWorktreesDir(rootDir, undefined, join(rootDir, "fn-1"))).toBe(false);
  });
});
