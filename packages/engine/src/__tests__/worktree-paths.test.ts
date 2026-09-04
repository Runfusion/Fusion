import { describe, expect, it } from "vitest";
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AI_MERGE_DIRNAME,
  WORKTREE_LOCKS_DIRNAME,
  WORKTREE_RECOVERY_DIRNAME,
  isAiMergeContainerDir,
  isWorktreeContainerDir,
  isInsideConfiguredWorktreesDir,
  isReclaimableWorktreeCandidate,
  resolveAiMergeRootPath,
  resolveAiMergeSearchRoots,
  resolveLegacyAiMergeRootPath,
  resolveTaskWorktreePath,
  resolveTaskWorktreePathForBackend,
  resolveWorktreesDir,
  resolveWorktreesDirScanRoots,
} from "../worktree/worktree-paths.js";

describe("worktree-paths", () => {
  const rootDir = join(tmpdir(), "repo-name");

  it("defaults to <rootDir>/.fusion/worktrees when unset", () => {
    expect(resolveWorktreesDir(rootDir, undefined)).toBe(join(rootDir, ".fusion", "worktrees"));
  });

  it("defaults to <rootDir>/.fusion/worktrees when settings object is present but worktreesDir is unset", () => {
    expect(resolveWorktreesDir(rootDir, {} as any)).toBe(join(rootDir, ".fusion", "worktrees"));
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
    expect(resolveAiMergeRootPath(rootDir, undefined)).toBe(join(rootDir, ".fusion", "worktrees", AI_MERGE_DIRNAME));
  });

  it("builds the AI-merge root under an absolute custom worktrees dir", () => {
    expect(resolveAiMergeRootPath(rootDir, { worktreesDir: "/tmp/ext-worktrees" } as any)).toBe(join("/tmp/ext-worktrees", AI_MERGE_DIRNAME));
  });

  it("searches current, legacy, and historic AI-merge roots without configured worktrees", () => {
    expect(resolveAiMergeSearchRoots(rootDir, undefined)).toEqual([
      join(rootDir, ".fusion", "worktrees", AI_MERGE_DIRNAME),
      resolveLegacyAiMergeRootPath(rootDir),
      join(rootDir, ".worktrees", AI_MERGE_DIRNAME),
    ]);
  });

  it("deduplicates the historic AI-merge root when worktreesDir is configured to .worktrees", () => {
    expect(resolveAiMergeSearchRoots(rootDir, { worktreesDir: ".worktrees" } as any)).toEqual([
      join(rootDir, ".worktrees", AI_MERGE_DIRNAME),
      resolveLegacyAiMergeRootPath(rootDir),
    ]);
  });

  it("does not search the historic root for an external configured worktrees dir", () => {
    expect(resolveAiMergeSearchRoots(rootDir, { worktreesDir: "/abs/elsewhere" } as any)).toEqual([
      join("/abs/elsewhere", AI_MERGE_DIRNAME),
      resolveLegacyAiMergeRootPath(rootDir),
    ]);
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

  it("identifies internal worktree containers without hiding task worktrees", () => {
    expect(isWorktreeContainerDir(AI_MERGE_DIRNAME)).toBe(true);
    expect(isWorktreeContainerDir(WORKTREE_RECOVERY_DIRNAME)).toBe(true);
    expect(isWorktreeContainerDir(WORKTREE_LOCKS_DIRNAME)).toBe(true);
    expect(isWorktreeContainerDir("fusion-ai-merge-fn-1-abc")).toBe(false);
    expect(isWorktreeContainerDir(".fusion-recovery-child")).toBe(false);
    expect(isWorktreeContainerDir("fn-1")).toBe(false);
  });

  it("vetoes workspace containers and plain directories before a destructive sweep", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-worktree-paths-"));
    try {
      const plain = join(root, "plain");
      const group = join(root, "workspace-group");
      await mkdir(plain);
      await mkdir(group);
      await writeFile(join(group, ".fusion-workspace-root"), "/workspace");
      expect(await isReclaimableWorktreeCandidate(plain, { rootDir: root })).toBe(false);
      expect(await isReclaimableWorktreeCandidate(group, { rootDir: root })).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects paths inside and outside configured dir", () => {
    const dir = resolveWorktreesDir(rootDir, { worktreesDir: "../{repo}.worktrees" } as any);
    expect(isInsideConfiguredWorktreesDir(rootDir, { worktreesDir: "../{repo}.worktrees" } as any, join(dir, "fn-1"))).toBe(true);
    expect(isInsideConfiguredWorktreesDir(rootDir, { worktreesDir: "../{repo}.worktrees" } as any, join(rootDir, "elsewhere", "fn-1"))).toBe(false);
    expect(isInsideConfiguredWorktreesDir(rootDir, { worktreesDir: "../{repo}.worktrees" } as any, dir)).toBe(false);
  });

  it("accepts both default and legacy roots while unset", () => {
    const primary = join(rootDir, ".fusion", "worktrees");
    const legacy = join(rootDir, ".worktrees");
    /*
    FNXC:WorktreePathTests 2026-08-30-20:16:
    Scan-root expectations use Node's filesystem resolution as an independent oracle. Importing the production canonicalizer would let the implementation and test regress together.
    */
    const canonicalRootDir = join(realpathSync.native(tmpdir()), "repo-name");
    expect(resolveWorktreesDirScanRoots(rootDir, undefined)).toEqual([
      join(canonicalRootDir, ".fusion", "worktrees"),
      join(canonicalRootDir, ".worktrees"),
    ]);
    expect(isInsideConfiguredWorktreesDir(rootDir, undefined, join(primary, "fn-1"))).toBe(true);
    expect(isInsideConfiguredWorktreesDir(rootDir, undefined, join(legacy, "fn-1"))).toBe(true);
    expect(isInsideConfiguredWorktreesDir(rootDir, undefined, primary)).toBe(false);
    expect(isInsideConfiguredWorktreesDir(rootDir, undefined, legacy)).toBe(false);
    expect(isInsideConfiguredWorktreesDir(rootDir, undefined, join(rootDir, "fn-1"))).toBe(false);
  });

  it("excludes the legacy root when worktreesDir is configured", () => {
    const settings = { worktreesDir: "configured" } as any;
    expect(isInsideConfiguredWorktreesDir(rootDir, settings, join(rootDir, ".worktrees", "fn-1"))).toBe(false);
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
