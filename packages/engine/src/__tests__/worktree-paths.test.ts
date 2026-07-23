import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AI_MERGE_DIRNAME,
  isAiMergeContainerDir,
  isInsideConfiguredWorktreesDir,
  resolveAiMergeRootPath,
  resolveTaskWorktreePath,
  resolveTaskWorktreePathForBackend,
  resolveWorktreesDir,
} from "../worktree/worktree-paths.js";

describe("worktree-paths", () => {
  const rootDir = "/tmp/repo-name";

  it("defaults to <rootDir>/.worktrees when unset", () => {
    expect(resolveWorktreesDir(rootDir, undefined)).toBe(join(rootDir, ".worktrees"));
  });

  it("defaults to <rootDir>/.worktrees when settings object is present but worktreesDir is unset", () => {
    expect(resolveWorktreesDir(rootDir, {} as any)).toBe(join(rootDir, ".worktrees"));
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

  it("builds the AI-merge root under the default worktrees dir", () => {
    expect(resolveAiMergeRootPath(rootDir, undefined)).toBe(join(rootDir, ".worktrees", AI_MERGE_DIRNAME));
  });

  it("builds the AI-merge root under an absolute custom worktrees dir", () => {
    expect(resolveAiMergeRootPath(rootDir, { worktreesDir: "/tmp/ext-worktrees" } as any)).toBe(join("/tmp/ext-worktrees", AI_MERGE_DIRNAME));
  });

  it("builds the AI-merge root under expanded {repo} and ~ worktrees dirs", () => {
    expect(resolveAiMergeRootPath(rootDir, { worktreesDir: "../{repo}.worktrees" } as any)).toBe(
      resolve(rootDir, "../repo-name.worktrees", AI_MERGE_DIRNAME),
    );
    expect(resolveAiMergeRootPath(rootDir, { worktreesDir: "~/.fn/{repo}/trees" } as any)).toBe(join(homedir(), ".fn/repo-name/trees", AI_MERGE_DIRNAME));
  });

  it("identifies only the dedicated AI-merge container name", () => {
    expect(isAiMergeContainerDir(AI_MERGE_DIRNAME)).toBe(true);
    expect(isAiMergeContainerDir("fusion-ai-merge-fn-1-abc")).toBe(false);
    expect(isAiMergeContainerDir(".ai-merge-child")).toBe(false);
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

  it("delegates to worktrunk backend path resolver", async () => {
    const resolver = async () => "/tmp/custom/fusion-fn-1";
    await expect(
      resolveTaskWorktreePathForBackend(rootDir, "fn-1", undefined, { kind: "worktrunk", resolveWorktreePath: resolver }, "fusion/fn-1"),
    ).resolves.toBe("/tmp/custom/fusion-fn-1");
  });

  it("falls back to native resolver for non-worktrunk backends", async () => {
    await expect(
      resolveTaskWorktreePathForBackend(rootDir, "fn-1", { worktreesDir: "../{repo}.worktrees" } as any, { kind: "native" }, "fusion/fn-1"),
    ).resolves.toBe(resolve(rootDir, "../repo-name.worktrees/fn-1"));
  });
});
